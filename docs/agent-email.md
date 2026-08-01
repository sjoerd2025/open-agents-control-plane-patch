# Agent Email

Give an agent its own email address. The control plane provisions a public
inbox per agent, persists inbound mail in D1, and
exposes three tools that let the agent send, list, and read messages —
all using the [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) and 
[Cloudflare Email Workers](https://developers.cloudflare.com/email-routing/email-workers/).

Replies to a message from the agent are routed back into the same session
they came from. New inbound mail from a known correspondent lands in the
session that's already corresponding with them. Fresh contacts
start a new session.

## Email tools

This control plane ships with three default tools to use email:

| Tool | Purpose |
| --- | --- |
| `email_send` | Send an email through the Email Service. The destination must be a verified address on your zone. |
| `email_inbox` | List recent emails delivered to this session's inbox (up to 25, newest first). |
| `email_read` | Read the full body of a single message by id. |

## Setup

The following are necessary for the built-in email tools:

| Capability | Tools enabled | What to configure |
| --- | --- | --- |
| Outbound only | `email_send` | `SEND_EMAIL` binding in `wrangler.jsonc`, `EMAIL_FROM` (or pass `from` per-call) |
| Inbox (read-only) | `email_inbox`, `email_read` | `DB` (D1) binding + `EMAIL_DOMAIN`, plus the Email Worker route in the dashboard |

### 1. Configure Email Routing on a zone

In the Cloudflare dashboard:

1. Open **Email → Email Routing** on a zone you control.
2. Enable Email Routing if it isn't already on. Verify any destination
   addresses you want the agent to be able to send to — Email Routing
   rejects outbound to unverified destinations.
3. Add a **catch-all** route, set the action to **Send to a Worker**,
   and pick this Worker. That's what feeds the inbox.

### 2. Set the vars in `wrangler.jsonc`

The `SEND_EMAIL` and `DB` bindings ship declared by default. You only
need to set the email vars:

```jsonc
"vars": {
  "EMAIL_DOMAIN": "agents.example.com",
  "EMAIL_FROM": "noreply@example.com",
  "EMAIL_FORWARD": "ops@example.com"
}
```

- `EMAIL_DOMAIN` is the suffix the control plane mints per-agent inbox
  addresses under. The catch-all route on that zone has to point at
  this Worker.
- `EMAIL_FROM` is the default sender for `email_send` when the
  agent's primary alias hasn't been resolved yet. Must belong to a
  zone you control.
- `EMAIL_FORWARD` is optional — mail with no routable destination gets
  forwarded here. Without it, unroutable mail is dropped.

### 3. Deploy and test

```sh
npm run deploy
```

Send a test message to `<alias>@<EMAIL_DOMAIN>` and watch
`wrangler tail` for the handler logging the receive. The first message
mints a new session for the agent; subsequent messages from the same
sender land in that session.

After a session has run end-to-end at least once, you can look up the agent's
public address with:

```sh
npx wrangler d1 execute claude-managed-agents-db --remote \
  --command "SELECT alias FROM agent_emails WHERE agent_id='agent_xxx' AND is_primary=1"
```

## How routing works

Each agent owns a public address `<alias>@<EMAIL_DOMAIN>`. The alias is
auto-derived from the agent id (`agent-<shortHash>`) and stored in the
`agent_emails` table on first sighting.

When mail arrives, the handler tries to match it to an existing
session using these signals in order:

1. **Session-specific subaddressing** — `<alias>+<sessionId>@<EMAIL_DOMAIN>`
   pins the message to a specific session, no matter what the headers
   look like. Useful for injecting events from a regular mail client.
2. **In-Reply-To / References** — the agent stamps a Message-ID
   encoding the session on every outbound (`<sessionId>.<uuid>@<domain>`)
   and persists it in `sent_messages`. When a counterparty hits reply,
   their mail client echoes the id into `In-Reply-To`; the handler looks
   it up and routes the reply back to the originating session. We walk
   `References` right-to-left as a fallback for clients that omit
   `In-Reply-To`.
3. **Counterparty thread** — `(agent_id, normalized_from)` is looked up
   in `email_threads`. Same correspondent corresponding with the same
   agent keeps landing in the same session. First contact mints a fresh
   session via the Anthropic API and writes the mapping.

Mail that doesn't resolve to any agent is forwarded to `EMAIL_FORWARD`
address if configured, otherwise dropped with a warning in the logs.

The agent never sees routing details — it just gets a `user.message`
event saying "an email arrived, here are its headers, call
`email_read` to view the body".

## Tool reference

### `email_send`

```ts
{
  to: string,           // verified destination
  subject: string,
  body: string,         // plain text
  html?: string,        // optional HTML multipart alternative
  from?: string,        // defaults to <alias>@<EMAIL_DOMAIN> when available
}
```

Returns `sent to <to> (subject: <subject>)` on success.

The `from` defaulting cascade:
1. Whatever the agent passes explicitly.
2. The agent's primary public address (when `EMAIL_DOMAIN` is set and
   `agent_id` has been cached on the session row).
3. `EMAIL_FROM` from `wrangler.jsonc`.

If none of those resolves to a valid address, the tool returns
`error: no 'from' address — pass one explicitly or set EMAIL_FROM / EMAIL_DOMAIN`.

Every outbound includes a `Message-ID` of the form
`<sessionId>.<uuid>@<domain>`. We persist this in `sent_messages` so an
eventual reply (carrying that value in `In-Reply-To`) routes back to
the same session.

### `email_inbox`

```ts
{
  limit?: number,       // 1..50, default 25
  since_ms?: number,    // Unix epoch ms; only return messages received after this
}
```

Returns a JSON object: `{ inbox, items: [{ id, from, to, subject, receivedAt, sizeBytes }] }`.
The agent uses `id` from a listing entry as the input to `email_read`.

### `email_read`

```ts
{ id: string }
```

Returns `{ id, from, to, subject, receivedAt, sizeBytes, format, body }`
as JSON. `format` is one of `"text"`, `"html"`, or `"empty"`; `body` is
the plain-text body when available, HTML otherwise, truncated at 200 KB.

## Troubleshooting

- **"error: SEND_EMAIL binding not configured"** — the `send_email`
  block is missing from `wrangler.jsonc`. Add it and redeploy.
- **"error: DB binding not configured"** — the inbox tools need a D1
  binding named `DB`. The standard onboarding sets this up.
- **`email_send` returns "error: no 'from' address"** — neither
  `EMAIL_DOMAIN` nor `EMAIL_FROM` is set. Set one in `wrangler.jsonc`
  or have the agent pass `from` explicitly.
- **Inbox is empty even though you sent mail** — the catch-all route
  on the zone isn't pointing at this Worker, or `EMAIL_DOMAIN` doesn't
  match the zone the route fires on. Tail logs and look for
  `[email]` lines on inbound.
- **Sends are rejected with "Destination not verified"** — Email
  Routing only allows outbound to addresses you've verified in the
  dashboard. Add the destination under **Email Routing → Destination
  addresses** and confirm.
- **Replies go to a brand new session instead of the original** — the
  reply client stripped `In-Reply-To`. The counterparty thread
  fallback should still keep them in the same session for subsequent
  emails. If it's still routing wrong, check the `email_threads` row
  for `(agent_id, normalized_from)`.
