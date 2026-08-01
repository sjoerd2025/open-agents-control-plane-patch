// Email Worker entrypoint. Cloudflare Email Routing invokes the Worker's
// `email()` export when a routed message arrives; we resolve the
// recipient to a session, persist the message to the `inbox` D1 table,
// and post a `user.message` event back to Anthropic (which fires a
// `session.status_run_started` webhook back to us so the agent wakes
// up and can respond).
//
// Routing model (agent-level addresses, sessions linked via headers):
//
//   - Each agent has a public address `<alias>@<EMAIL_DOMAIN>`. The
//     alias is auto-provisioned by the webhook resolver on first
//     agent_id sighting and stored in the `agent_emails` table.
//
//   - When the agent sends mail via email_send, the tool stamps a
//     Message-ID encoding the session id and records it in
//     `sent_messages`. A reply that carries that id in In-Reply-To /
//     References routes back to the originating session — even if the
//     same counterparty is corresponding with multiple sessions of the
//     same agent in parallel.
//
//   - When there's no Message-ID match (compose-fresh, mailing lists,
//     clients that strip references), we fall back to a per-counterparty
//     thread mapping in `email_threads`: same `(agent_id, from)` keeps
//     landing in the same session. First contact mints a new session.
//
//   - Operators can pin a specific session via subaddressing:
//     `<alias>+<sessionId>@<EMAIL_DOMAIN>`. Useful for injecting events
//     from a regular mail client; also covers per-session inboxes
//     handed out by older versions of this Worker.
//
//   - Direct legacy addresses (`session_xxx@<EMAIL_DOMAIN>` /
//     `sesn_xxx@<EMAIL_DOMAIN>`) keep working so deployments that
//     migrate don't lose mail mid-flight.
//
// Routing setup (one-time, in the Cloudflare dashboard):
//   1. Email Routing → Settings → Custom address → add a catch-all rule
//      `*@<EMAIL_DOMAIN>` → "Send to a Worker" → pick this Worker.
//   2. Optional: register verified destination addresses for `forward()`.
//
// The user.message we post into the session is intentionally minimal:
// "Email arrived from <from> with subject <subject>; call
// email_inbox / email_read to view it." We DON'T inline the body
// because long emails would blow context, and the agent already has
// the read tools to fetch the body on demand. Agents that want a
// different policy (e.g. auto-summarise, ignore certain senders) can
// add an "Email handling" section to their system prompt — see
// TODO.md → "Per-agent email handling policy".

import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_BETA, resolveAnthropicBaseURL } from "./anthropic";
import { SESSION_ID_PREFIX_REGEX } from "./helpers";
import {
  findSessionByMessageId,
  getAgentIdByAlias,
  getThreadSession,
  normalizeAlias,
  normalizeCounterparty,
  touchThread,
  upsertThread,
} from "./storage";

// Anthropic SDK client authenticated with the Worker's API key. Used by
// the email handler to mint sessions and post `user.message` events
// back into them. The control plane-side per-session token isn't available
// here — inbound mail predates any per-session credential — so we
// authenticate with the env's API key the same way the rest of the
// Worker's Anthropic calls do.
function emailClient(env: Env): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: resolveAnthropicBaseURL(env),
  });
}

// `ForwardableEmailMessage` ships with the workerd runtime types; we
// declare the slice we use here so the file compiles even when the
// project's tsconfig lib doesn't pull in the `cloudflare:email` ambient
// definitions. Mirrors the official type's shape.
export interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
  reply?(message: unknown): Promise<void>;
}

// Cap stored bodies so a malicious sender can't fill D1 with a single
// 50 MB message. The agent-side tools cap at 200 KB anyway.
const MAX_STORED_BYTES = 256_000;

// Read up to `max` bytes from a ReadableStream<Uint8Array>, returning
// the bytes as a single Uint8Array (truncated if necessary).
async function readStream(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      const remaining = max - total;
      const slice =
        value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (slice.byteLength < value.byteLength) break; // truncated
    }
  }
  reader.releaseLock();
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// Naive RFC 5322 splitter — good enough to extract the plain-text and
// HTML alternatives most agents will produce. We deliberately don't pull
// in a full MIME parser; if a sender ships an attachment-heavy message,
// the body fields will be the first text/* part we find and the rest is
// dropped.
interface ParsedEmail {
  subject: string;
  from: string;
  to: string;
  textBody: string | null;
  htmlBody: string | null;
  inReplyTo: string | null;
  references: string[];
}

function parseHeaders(raw: string): {
  headers: Record<string, string>;
  bodyStart: number;
} {
  const headers: Record<string, string> = {};
  const sep = raw.indexOf("\r\n\r\n");
  const bodyStart = sep === -1 ? raw.length : sep + 4;
  const headerBlock = sep === -1 ? raw : raw.slice(0, sep);
  let lastKey = "";
  for (const line of headerBlock.split("\r\n")) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      // Header continuation — append to last seen key.
      if (lastKey) headers[lastKey] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[key] = value;
    lastKey = key;
  }
  return { headers, bodyStart };
}

function extractMimePart(
  body: string,
  boundary: string,
  contentType: string,
): string | null {
  // Walk multipart parts looking for the requested content-type. Returns
  // the first matching part's body. Quoted-printable / base64 decoding
  // is left to the model — most agents send 7bit text anyway and we don't
  // want a parser footprint here.
  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    const trimmed = part.replace(/^\r?\n/, "");
    if (!trimmed || trimmed.startsWith("--")) continue;
    const { headers, bodyStart } = parseHeaders(trimmed);
    const ct = headers["content-type"] ?? "";
    if (ct.toLowerCase().includes(contentType)) {
      return trimmed.slice(bodyStart).trim();
    }
  }
  return null;
}

// Pull every `<msgid>` out of a header value. RFC 5322 message-id
// references are angle-bracketed; we accept either bare or bracketed
// forms and tolerate folding whitespace. Order is preserved so the
// caller can prefer In-Reply-To over References.
function parseMessageIdList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  // Find every `<...>` segment; fall back to whitespace-split bare ids
  // if the header had no angle brackets at all.
  const bracketed = value.matchAll(/<([^>]+)>/g);
  let any = false;
  for (const m of bracketed) {
    any = true;
    const id = m[1].trim();
    if (id) out.push(id);
  }
  if (!any) {
    for (const tok of value.split(/\s+/)) {
      if (tok) out.push(tok);
    }
  }
  return out;
}

export function parseEmail(
  raw: string,
  fallbackFrom: string,
  fallbackTo: string,
): ParsedEmail {
  const { headers, bodyStart } = parseHeaders(raw);
  const body = raw.slice(bodyStart);
  const subject = headers.subject ?? "(no subject)";
  const from = headers.from ?? fallbackFrom;
  const to = headers.to ?? fallbackTo;
  const ct = headers["content-type"] ?? "text/plain";
  const inReplyToList = parseMessageIdList(headers["in-reply-to"]);
  const inReplyTo = inReplyToList[0] ?? null;
  const references = parseMessageIdList(headers["references"]);
  if (ct.toLowerCase().includes("multipart/")) {
    const m = ct.match(/boundary="?([^";]+)"?/);
    if (m) {
      const boundary = m[1];
      return {
        subject,
        from,
        to,
        textBody: extractMimePart(body, boundary, "text/plain"),
        htmlBody: extractMimePart(body, boundary, "text/html"),
        inReplyTo,
        references,
      };
    }
  }
  if (ct.toLowerCase().includes("text/html")) {
    return {
      subject,
      from,
      to,
      textBody: null,
      htmlBody: body.trim(),
      inReplyTo,
      references,
    };
  }
  return {
    subject,
    from,
    to,
    textBody: body.trim(),
    htmlBody: null,
    inReplyTo,
    references,
  };
}

// Pull a literal session id out of a local-part. Accepts:
//   - the raw session id  (`session_abc...`)            — legacy direct inbox
//   - `<prefix>+<sessionId>` form for subaddressing     — operator escape hatch
//
// Returns null when neither matches. The caller decides which routing
// branch to take.
export function extractSessionId(localPart: string): string | null {
  const candidate = localPart.includes("+")
    ? localPart.split("+", 2)[1]
    : localPart;
  const match = candidate.match(SESSION_ID_PREFIX_REGEX);
  return match ? match[0] : null;
}

// Resolution decision returned by resolveRecipient. The caller persists
// the inbox row + notifies the session under whatever kind we picked.
//
//   - `session`: route directly to this session (existing or freshly
//     created). `agentId` may be null when we resolved via the legacy
//     `session_xxx` path and never learned the agent.
//   - `none`: no routable destination. The caller forwards to
//     EMAIL_FORWARD if set, or drops.
type Resolution =
  | {
      kind: "session";
      sessionId: string;
      agentId: string | null;
      reason: string;
    }
  | { kind: "none"; reason: string };

// Resolve the inbound recipient + parsed headers to a session. Pure of
// side effects except for `email_threads` upserts (creating a thread
// when a new counterparty contacts a known agent for the first time).
//
// Order matters — earlier branches override later ones:
//   1. `<prefix>+<sessionId>` subaddressing wins outright; the operator
//      has explicitly pinned a session.
//   2. Raw `session_xxx@` legacy address routes directly (preserves
//      every existing deployment's per-session inboxes).
//   3. Look up the local-part in `agent_emails`. If no agent owns it,
//      bail with `none`.
//   4. Within the agent: walk In-Reply-To then References against
//      `sent_messages`. First hit wins.
//   5. Look up the counterparty in `email_threads` for that agent.
//   6. No match → mint a new session via the Anthropic API, write the
//      thread mapping, and return it.
async function resolveRecipient(
  env: Env,
  recipient: string,
  parsed: ParsedEmail,
): Promise<Resolution> {
  const at = recipient.indexOf("@");
  if (at <= 0) {
    return { kind: "none", reason: `malformed recipient=${recipient}` };
  }
  const localRaw = recipient.slice(0, at);
  const localLower = localRaw.toLowerCase();

  // (1) Subaddressed `<alias>+<sessionId>@…` — operator escape hatch.
  // We accept this even when the alias isn't registered, because the
  // session id alone is enough to route the message safely.
  const subaddressed = localLower.includes("+")
    ? extractSessionId(localLower)
    : null;
  if (subaddressed) {
    return {
      kind: "session",
      sessionId: subaddressed,
      agentId: null,
      reason: "subaddress",
    };
  }

  // (2) Legacy direct session inbox.
  const direct = extractSessionId(localLower);
  if (direct) {
    return {
      kind: "session",
      sessionId: direct,
      agentId: null,
      reason: "legacy-session-local",
    };
  }

  // (3) Agent alias lookup. Without an agent we have nowhere to
  // route — fall through to the caller's forward/drop path.
  const aliasKey = normalizeAlias(localRaw);
  const agentId = await getAgentIdByAlias(env.DB, aliasKey);
  if (!agentId) {
    return { kind: "none", reason: `no agent alias for local=${aliasKey}` };
  }

  // (4) In-Reply-To / References → sent_messages. Walk newest first;
  // In-Reply-To is the strongest signal because RFC 5322 mandates it
  // points at the immediate parent.
  const candidates: string[] = [];
  if (parsed.inReplyTo) candidates.push(parsed.inReplyTo);
  // References lists every ancestor oldest-first; the most recent is at
  // the end. Walk it in reverse so we prefer the closest ancestor.
  for (let i = parsed.references.length - 1; i >= 0; i--) {
    const id = parsed.references[i];
    if (id && id !== parsed.inReplyTo) candidates.push(id);
  }
  for (const messageId of candidates) {
    const hit = await findSessionByMessageId(env.DB, messageId);
    if (hit && hit.agentId === agentId) {
      // Refresh the thread row so subsequent compose-fresh emails from
      // this counterparty also land in the right session.
      const counterparty = normalizeCounterparty(parsed.from);
      if (counterparty) {
        try {
          await touchThread(env.DB, agentId, counterparty);
        } catch (error) {
          console.warn(
            `[email] failed to touch thread for ${agentId}/${counterparty}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return {
        kind: "session",
        sessionId: hit.sessionId,
        agentId,
        reason: `in-reply-to=${messageId}`,
      };
    }
  }

  // (5) Counterparty thread mapping.
  const counterparty = normalizeCounterparty(parsed.from);
  if (counterparty) {
    const threadSession = await getThreadSession(env.DB, agentId, counterparty);
    if (threadSession) {
      try {
        await touchThread(env.DB, agentId, counterparty);
      } catch (error) {
        console.warn(
          `[email] failed to touch thread for ${agentId}/${counterparty}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        kind: "session",
        sessionId: threadSession,
        agentId,
        reason: `thread:${counterparty}`,
      };
    }
  }

  // (6) Fresh contact — mint a new session for this agent.
  const newSessionId = await createSessionForAgent(env, agentId);
  if (!newSessionId) {
    return {
      kind: "none",
      reason: `could not create new session for agent=${agentId}`,
    };
  }
  if (counterparty) {
    try {
      await upsertThread(env.DB, agentId, counterparty, newSessionId);
    } catch (error) {
      console.warn(
        `[email] failed to upsert thread for ${agentId}/${counterparty}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    kind: "session",
    sessionId: newSessionId,
    agentId,
    reason: "new-session",
  };
}

// Spawn a fresh session for the given agent via the Anthropic API.
// Returns the new session id on success, null on failure. The caller
// proceeds without notifying when null — the inbox row will already
// be written, so a follow-up email_inbox call from any future
// session of the agent could still pick it up.
async function createSessionForAgent(
  env: Env,
  agentId: string,
): Promise<string | null> {
  const client = emailClient(env);
  if (!client) {
    console.warn(
      `[email] cannot create session for agent=${agentId} — ANTHROPIC_API_KEY not set`,
    );
    return null;
  }
  try {
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: env.ENVIRONMENT_ID,
      betas: [ANTHROPIC_BETA],
    });
    if (typeof session.id !== "string") {
      console.warn(
        `[email] sessions.create response missing id agent=${agentId}`,
      );
      return null;
    }
    console.log(`[email] minted session=${session.id} for agent=${agentId}`);
    return session.id;
  } catch (error) {
    const status = (error as { status?: number })?.status;
    const detail = error instanceof Error ? error.message : String(error);
    if (typeof status === "number") {
      console.warn(
        `[email] sessions.create rejected status=${status} agent=${agentId}: ${detail}`,
      );
    } else {
      console.warn(
        `[email] sessions.create network error agent=${agentId}: ${detail}`,
      );
    }
    return null;
  }
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const recipient = message.to;

  const rawBytes = await readStream(message.raw, MAX_STORED_BYTES);
  // `fatal: false` + `ignoreBOM: false` is the safe default; we never
  // expect a BOM in inbound mail and want malformed bytes replaced rather
  // than throwing.
  const raw = new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: false,
  }).decode(rawBytes);
  const parsed = parseEmail(raw, message.from, recipient);

  const resolution = await resolveRecipient(env, recipient, parsed);
  if (resolution.kind !== "session") {
    console.log(
      `[email] unroutable recipient=${recipient} reason=${resolution.reason}`,
    );
    const fallback = env.EMAIL_FORWARD;
    if (fallback) {
      try {
        await message.forward(fallback);
      } catch (error) {
        console.warn(
          `[email] forward to ${fallback} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return;
  }

  const sessionId = resolution.sessionId;
  const messageId = `msg_${crypto.randomUUID()}`;
  const sizeBytes = rawBytes.byteLength;
  const now = Date.now();

  try {
    await env.DB.prepare(
      `INSERT INTO inbox (
        message_id, session_id, from_addr, to_addr, subject,
        received_at_ms, size_bytes, body_text, body_html, raw
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        messageId,
        sessionId,
        parsed.from,
        parsed.to,
        parsed.subject,
        now,
        sizeBytes,
        parsed.textBody,
        parsed.htmlBody,
        // Cap raw — we already truncated the stream read but be defensive.
        raw.slice(0, MAX_STORED_BYTES),
      )
      .run();
    console.log(
      `[email] stored message=${messageId} session=${sessionId} agent=${resolution.agentId ?? "(unknown)"} routed=${resolution.reason} from=${parsed.from} subject="${parsed.subject.slice(0, 60)}"`,
    );
  } catch (error) {
    console.error(
      `[email] failed to store message session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    // We don't reject the delivery — Email Routing would retry indefinitely
    // and we already logged the failure. The agent simply won't see it.
    return;
  }

  // Notify the agent that mail arrived. Posting a `user.message` event
  // makes Anthropic schedule the session (its status moves from idle
  // back to running) and fires a `session.status_run_started` webhook
  // to this Worker, which dispatches the matching sandbox. From the
  // agent's perspective: a new user message saying "an email arrived,
  // here are its headers, call email_read to view the body".
  //
  // Best-effort: a failure here logs and proceeds. The email is
  // already stored in the inbox table; the agent can still discover
  // it on its next natural turn via email_inbox.
  try {
    await notifyAgentOfEmail(env, sessionId, messageId, parsed);
  } catch (error) {
    console.warn(
      `[email] failed to notify session=${sessionId} of message=${messageId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Build the short notification message we post into the session. We
// intentionally keep this terse — the agent has email_inbox /
// email_read to pull the body when it decides to act. Agents that
// want a different escalation policy (auto-reply, ignore senders,
// summarise long threads) should encode it in their system prompt.
function buildEmailNotification(
  messageId: string,
  parsed: ParsedEmail,
): string {
  const subject = parsed.subject.slice(0, 200) || "(no subject)";
  return [
    `A new email arrived in this session's inbox.`,
    `  from:    ${parsed.from}`,
    `  to:      ${parsed.to}`,
    `  subject: ${subject}`,
    `  id:      ${messageId}`,
    ``,
    `Use email_read with this id to fetch the full body, or `,
    `email_inbox to list all unread mail. Respond if appropriate.`,
  ].join("\n");
}

// Post a `user.message` event to the Anthropic events endpoint via
// the SDK so the agent wakes up for inbound mail. The SDK handles
// `?beta=true`, the version header, and the body shape — we just
// supply the event content.
async function notifyAgentOfEmail(
  env: Env,
  sessionId: string,
  messageId: string,
  parsed: ParsedEmail,
): Promise<void> {
  const client = emailClient(env);
  if (!client) {
    console.warn(
      `[email] cannot notify session=${sessionId} — ANTHROPIC_API_KEY not set`,
    );
    return;
  }
  const text = buildEmailNotification(messageId, parsed);
  // The SDK's typed events array doesn't yet include `user.message` in
  // its discriminated union — cast through `unknown` so we can post the
  // shape Anthropic actually accepts. Same escape hatch as the
  // audit/custom-dispatch modules.
  await client.beta.sessions.events.send(sessionId, {
    betas: [ANTHROPIC_BETA],
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text }],
      },
    ],
  } as unknown as Parameters<typeof client.beta.sessions.events.send>[1]);
  console.log(`[email] notified session=${sessionId} of message=${messageId}`);
}
