// Routing decision tree for inbound email. The dominant case is a reply
// to something the agent sent — Message-ID threading carries the session
// id back. We also exercise the counterparty fallback, the new-session
// path, the subaddressing escape hatch, and the legacy `session_xxx@`
// direct address. Network calls to the Anthropic API are stubbed via
// global fetch so the test runs without credentials.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractSessionId,
  handleEmail,
  parseEmail,
  type ForwardableEmailMessage,
} from "../src/email-handler";
import {
  ensureAgentPrimaryEmail,
  recordSentMessage,
  upsertThread,
} from "../src/storage";
import { makeEnv } from "./helpers";

type FetchFn = typeof fetch;

function bodyToStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeMessage(
  to: string,
  from: string,
  raw: string,
): ForwardableEmailMessage & { _forwardedTo: string[]; _rejected: string | null } {
  const stream = bodyToStream(raw);
  const calls: string[] = [];
  let rejected: string | null = null;
  return {
    from,
    to,
    raw: stream,
    rawSize: raw.length,
    setReject(reason: string) {
      rejected = reason;
    },
    async forward(rcptTo: string) {
      calls.push(rcptTo);
    },
    get _forwardedTo() {
      return calls;
    },
    get _rejected() {
      return rejected;
    },
  };
}

// Capture every outbound HTTP call so tests can assert on (a) which
// session events.send was called against, (b) whether sessions.create
// was invoked, and (c) what payload went up.
interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(responder: (call: FetchCall) => Response): {
  calls: FetchCall[];
  fn: ReturnType<typeof vi.fn>;
} {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method);
    let body: unknown = null;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: FetchCall = { url, method, body };
    calls.push(call);
    return responder(call);
  });
  return { calls, fn: fn as unknown as ReturnType<typeof vi.fn> };
}

describe("parseEmail", () => {
  it("extracts In-Reply-To and References ids", () => {
    const raw = [
      "From: bob@example.com",
      "To: agent-abc123@agents.test",
      "Subject: Re: ping",
      "In-Reply-To: <session_aaa.uuid-1@agents.test>",
      "References: <session_aaa.first@agents.test> <session_aaa.uuid-1@agents.test>",
      "Content-Type: text/plain",
      "",
      "hello",
    ].join("\r\n");
    const parsed = parseEmail(raw, "bob@example.com", "agent-abc123@agents.test");
    expect(parsed.inReplyTo).toBe("session_aaa.uuid-1@agents.test");
    expect(parsed.references).toEqual([
      "session_aaa.first@agents.test",
      "session_aaa.uuid-1@agents.test",
    ]);
    expect(parsed.textBody).toBe("hello");
  });

  it("returns empty arrays when no threading headers are present", () => {
    const raw = [
      "From: bob@example.com",
      "To: agent-abc123@agents.test",
      "Subject: hi",
      "",
      "fresh",
    ].join("\r\n");
    const parsed = parseEmail(raw, "bob@example.com", "agent-abc123@agents.test");
    expect(parsed.inReplyTo).toBeNull();
    expect(parsed.references).toEqual([]);
  });
});

describe("extractSessionId", () => {
  it("returns the session id from a raw local part", () => {
    expect(extractSessionId("session_abc")).toBe("session_abc");
    expect(extractSessionId("sesn_xyz123")).toBe("sesn_xyz123");
  });

  it("returns the session id from `<prefix>+<sessionId>` subaddressing", () => {
    expect(extractSessionId("alice+session_abc")).toBe("session_abc");
    expect(extractSessionId("support+sesn_xyz")).toBe("sesn_xyz");
  });

  it("returns null when neither matches", () => {
    expect(extractSessionId("alice")).toBeNull();
    expect(extractSessionId("agent-abc123")).toBeNull();
  });
});

describe("handleEmail", () => {
  let originalFetch: FetchFn;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("routes a reply with matching Message-ID back to the originating session", async () => {
    const env = makeEnv({ EMAIL_DOMAIN: "agents.test" });
    // The agent already exists in the catalog and has its primary alias
    // provisioned — equivalent to what the webhook resolver does on
    // first session sighting.
    await ensureAgentPrimaryEmail(env.DB, "agent_abc");
    const aliasRow = Array.from(env.DB._tables.agent_emails.values())[0];
    const alias = String(aliasRow.alias);
    const inboundAddress = `${alias}@agents.test`;

    // The agent previously sent something from session_old, stamping a
    // Message-ID we now persist. The reply's In-Reply-To carries that id.
    const issuedId = "session_old.uuid-1@agents.test";
    await recordSentMessage(env.DB, issuedId, "session_old", "agent_abc", "bob@example.com");

    const raw = [
      `From: bob@example.com`,
      `To: ${inboundAddress}`,
      `Subject: Re: ping`,
      `In-Reply-To: <${issuedId}>`,
      `Content-Type: text/plain`,
      ``,
      `hello back`,
    ].join("\r\n");
    const msg = makeMessage(inboundAddress, "bob@example.com", raw);

    const { calls, fn } = stubFetch(() => new Response("{}", { status: 200 }));
    globalThis.fetch = fn as unknown as FetchFn;

    await handleEmail(msg, env as unknown as Env);

    // Inbox row landed against the original session.
    const inboxRows = Array.from(env.DB._tables.inbox.values());
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].session_id).toBe("session_old");

    // Anthropic events.send fired against the original session id, NOT
    // a freshly-minted one.
    const eventsCall = calls.find((c) => c.url.includes("/v1/sessions/") && c.url.endsWith("/events?beta=true"));
    expect(eventsCall).toBeDefined();
    expect(eventsCall?.url).toContain("/v1/sessions/session_old/events");

    // sessions.create was NOT called.
    expect(calls.find((c) => c.url.endsWith("/v1/sessions?beta=true"))).toBeUndefined();
  });

  it("falls back to the counterparty thread when no Message-ID matches", async () => {
    const env = makeEnv({ EMAIL_DOMAIN: "agents.test" });
    await ensureAgentPrimaryEmail(env.DB, "agent_abc");
    const aliasRow = Array.from(env.DB._tables.agent_emails.values())[0];
    const inboundAddress = `${String(aliasRow.alias)}@agents.test`;

    // Prior thread mapping: bob has been corresponding with this agent
    // on session_existing.
    await upsertThread(env.DB, "agent_abc", "bob@example.com", "session_existing");

    const raw = [
      `From: Bob Smith <bob@example.com>`,
      `To: ${inboundAddress}`,
      `Subject: new topic`,
      `Content-Type: text/plain`,
      ``,
      `nothing references the agent's previous mail`,
    ].join("\r\n");
    const msg = makeMessage(inboundAddress, "bob@example.com", raw);

    const { calls, fn } = stubFetch(() => new Response("{}", { status: 200 }));
    globalThis.fetch = fn as unknown as FetchFn;

    await handleEmail(msg, env as unknown as Env);

    const inboxRows = Array.from(env.DB._tables.inbox.values());
    expect(inboxRows[0].session_id).toBe("session_existing");
    expect(calls.find((c) => c.url.endsWith("/v1/sessions?beta=true"))).toBeUndefined();
    expect(calls.find((c) => c.url.includes("/v1/sessions/session_existing/events"))).toBeDefined();
  });

  it("mints a new session for a brand-new counterparty", async () => {
    const env = makeEnv({ EMAIL_DOMAIN: "agents.test" });
    await ensureAgentPrimaryEmail(env.DB, "agent_abc");
    const aliasRow = Array.from(env.DB._tables.agent_emails.values())[0];
    const inboundAddress = `${String(aliasRow.alias)}@agents.test`;

    const raw = [
      `From: stranger@elsewhere.test`,
      `To: ${inboundAddress}`,
      `Subject: first contact`,
      `Content-Type: text/plain`,
      ``,
      `hi`,
    ].join("\r\n");
    const msg = makeMessage(inboundAddress, "stranger@elsewhere.test", raw);

    // The Anthropic SDK's `defaultParseResponse` only parses bodies it
    // can identify as JSON via the content-type header, so we have to
    // set it explicitly on every stubbed response — otherwise the SDK
    // returns `undefined` and `sessions.create` looks like it failed.
    const jsonHeaders = { "content-type": "application/json" };
    const { calls, fn } = stubFetch((call) => {
      if (call.url.endsWith("/v1/sessions?beta=true")) {
        return new Response(JSON.stringify({ id: "session_new" }), {
          status: 200,
          headers: jsonHeaders,
        });
      }
      return new Response("{}", { status: 200, headers: jsonHeaders });
    });
    globalThis.fetch = fn as unknown as FetchFn;

    await handleEmail(msg, env as unknown as Env);

    // sessions.create was invoked with the right agent. The SDK uses
    // `agent` (string id) rather than the legacy `agent_id` field.
    const createCall = calls.find((c) => c.url.endsWith("/v1/sessions?beta=true"));
    expect(createCall).toBeDefined();
    expect((createCall?.body as Record<string, unknown>).agent).toBe("agent_abc");

    // events.send fired against the newly-minted session.
    const eventsCall = calls.find((c) =>
      c.url.includes("/v1/sessions/session_new/events"),
    );
    expect(eventsCall).toBeDefined();

    // Thread was recorded so a follow-up from the same sender keeps the session.
    const threadKey = `agent_abc\x00stranger@elsewhere.test`;
    expect(env.DB._tables.email_threads.get(threadKey)?.session_id).toBe("session_new");
  });

  it("honours `<alias>+<sessionId>@` subaddressing as an escape hatch", async () => {
    const env = makeEnv({ EMAIL_DOMAIN: "agents.test" });
    await ensureAgentPrimaryEmail(env.DB, "agent_abc");
    const inboundAddress = `agent-anything+session_pinned@agents.test`;

    const raw = [
      `From: bob@example.com`,
      `To: ${inboundAddress}`,
      `Subject: pinned`,
      `Content-Type: text/plain`,
      ``,
      `body`,
    ].join("\r\n");
    const msg = makeMessage(inboundAddress, "bob@example.com", raw);

    const { calls, fn } = stubFetch(() => new Response("{}", { status: 200 }));
    globalThis.fetch = fn as unknown as FetchFn;

    await handleEmail(msg, env as unknown as Env);

    expect(Array.from(env.DB._tables.inbox.values())[0].session_id).toBe("session_pinned");
    expect(calls.find((c) => c.url.endsWith("/v1/sessions?beta=true"))).toBeUndefined();
  });

  it("forwards unroutable mail to EMAIL_FORWARD when no agent owns the alias", async () => {
    const env = makeEnv({ EMAIL_DOMAIN: "agents.test", EMAIL_FORWARD: "ops@example.com" });
    const inboundAddress = `random-unknown@agents.test`;
    const raw = [
      `From: noone@elsewhere.test`,
      `To: ${inboundAddress}`,
      `Subject: stray`,
      ``,
      `body`,
    ].join("\r\n");
    const msg = makeMessage(inboundAddress, "noone@elsewhere.test", raw);

    const { fn } = stubFetch(() => new Response("{}", { status: 200 }));
    globalThis.fetch = fn as unknown as FetchFn;

    await handleEmail(msg, env as unknown as Env);

    expect(msg._forwardedTo).toEqual(["ops@example.com"]);
    expect(env.DB._tables.inbox.size).toBe(0);
  });
});
