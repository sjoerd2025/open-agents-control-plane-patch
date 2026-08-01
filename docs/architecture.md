# Architecture

The control plane is a single Cloudflare Worker. It receives webhooks
from the Claude Managed Agents platform, dispatches each session into a
MicroVM or Isolate sandbox, and serves a dashboard over HTTP.

Storage, egress control, and private-network access use Worker
bindings to D1, KV, R2, Worker Loader, and Workers VPC.

## What runs where

```
┌──────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                               │
│                                                                  │
│   /            React dashboard (SPA)                             │
│   /api/*       Hono REST API                                     │
│   /webhooks    Anthropic webhook ingress                         │
│   /ws/terminal xterm.js proxy (MicroVM only)                     │
│   email, cron  inbox routing, daily prune                        │
│                              │                                   │
│                              ▼                                   │
│   ┌──────────────────────┐    ┌─────────────────────────┐        │
│   │  MicroVM Sandbox     │    │  Isolate Sandbox        │        │
│   │  Container DO        │    │  Agents SDK DO          │        │
│   │  Linux + ant runner  │    │  SQLite Workspace       │        │
│   └─────────┬────────────┘    └────────────┬────────────┘        │
│             │                              │                     │
│             └───────────────┬──────────────┘                     │
│                             ▼                                    │
│                    Egress proxy Worker                           │
│                             │                                    │
│                             ▼                                    │
│                  Internet or private services                    │
│                                                                  │
│                                                                  │
│   Storage:  D1  ·  KV  ·  R2                                     │
│   Bindings: Worker Loader  ·  VPC  ·  Email Routing  ·  AI       │
└──────────────────────────────────────────────────────────────────┘
```

Anthropic posts signed webhooks to the Worker on various events. Most
importantly on session start and end.

The Worker will use session IDs to launch or route to specific
sandboxes for each session.

Each session has a Durable Object backing it, which is a stateful
piece of code running in Workers, outside the sandbox itself. This
allows you to store information about the session and control it
from a trusted location.

MicroVM backed agents use the [SandboxSDK](https://developers.cloudflare.com/sandbox/)
and Cloudflare Containers.

The isolate backend is built on the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/),
[Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/), and a persistent
filesystem [workspace](https://www.npmjs.com/package/@cloudflare/shell).

## Request lifecycle

The Worker has no long-lived process. It does work only in response to
a webhook from Anthropic, plus a daily cron that prunes old rows.

1. **Webhook arrives.** The handler verifies the Standard Webhooks
   signature (HMAC-SHA256 with a ±300s tolerance), persists the event
   to D1, and on `session.status_run_started` drains pending work.
2. **Drain work.** The handler polls Anthropic's environment work
   queue. Each item carries a base64-encoded secret containing the
   session ingress token plus any agent secrets.
3. **Pick a backend.** The backend choice is per-agent, persisted in
   D1, and cached on the session row so subsequent webhooks skip the
   lookup. The default is MicroVM.
4. **Dispatch.** Either the MicroVM Sandbox or the Isolate Runner
   Durable Object picks up the work. Both attach the session's egress
   policy before starting any agent code.
5. **Run.** MicroVM runs Anthropic's stock toolset (bash, file ops)
   inside the container, plus a custom-tool dispatcher in the Durable Object
   that answers custom tool calls. Isolates run the same
   custom-tool dispatcher inside its Agents SDK Durable Object and have
   no container at all. Instead they do file system operations and
   code execution via custom tool calls.
6. **Persist.** MicroVM snapshots `/workspace` to R2 when the session
   goes idle. Isolate persists automatically through Durable Object
   SQLite storage.

See [Isolate vs VM-based Sandboxes](./isolate-vs-vm-sandboxes.md) for
the trade-offs that drive step 3.

## Components

**Worker entrypoint** routes incoming traffic to the React SPA, the
Hono API, the webhook handler, and the terminal WebSocket. Terminal
upgrades are only valid for MicroVM sessions — Isolate sessions return
409.

**Durable Objects.** Two classes, both bound by name:

```jsonc
// wrangler.jsonc
"durable_objects": {
  "bindings": [
    { "class_name": "Sandbox", "name": "Sandbox" },
    { "class_name": "IsolateRunner", "name": "IsolateRunner" }
  ]
}
```

`Sandbox` is a Container-enabled Durable Object — `wrangler.jsonc`
declares the image and instance type:

```jsonc
"containers": [{
  "class_name": "Sandbox",
  "image": "./Dockerfile",
  "instance_type": "standard-1",
  "max_instances": 100
}]
```

`IsolateRunner` extends `Agent` from the
[Agents SDK](https://developers.cloudflare.com/agents/api-reference/agents-api/),
which gives the control plane persisted state, durable fibers, and the
SQLite-backed `Workspace` that stands in for a filesystem.

**Storage.** D1 holds session and webhook event metadata; KV holds
egress-policy JSON and named secret values; R2 holds workspace
snapshots for MicroVM sessions.

**Egress.** Both sandbox shapes route outbound traffic through a
shared policy engine that compiles each session's policy down to allow
lists, deny lists, header-injection rules, optional Dynamic Worker
proxy, and VPC service routing. Details in
[Applying Egress Policies](./applying-egress-policies.md).

**Cron.** A daily trigger (`0 4 * * *`) prunes old webhook events,
sessions, and inbox rows.

## API reference

The Worker exposes an OpenAPI 3.1 document covering every HTTP route —
sandbox lifecycle, agent / session proxies, egress policy CRUD,
secrets, VPC bindings, webhook ingress, and the WebSocket terminal
upgrade.

Open `/redoc.html` in your Worker to browse the spec, or fetch
`/openapi.json` for machine-friendly output. `/api/config` returns an
`openapi` block pointing at both URLs.

```sh
# CLI usage
curl -sf https://<your-worker>.workers.dev/openapi.json | jq .info

# Generate a typed client
npx openapi-typescript \
  https://<your-worker>.workers.dev/openapi.json \
  -o src/api-types.ts
```

## Bindings reference

Required:

| Binding | Type | Purpose |
| --- | --- | --- |
| `Sandbox` | Container Durable Object | MicroVM sandbox |
| `IsolateRunner` | Durable Object | Isolate sandbox |
| `DB` | D1 | Sessions, webhooks, agent backends |
| `SECRETS` | KV | Named secrets for egress rules |
| `EGRESS_POLICIES` | KV | Egress policy JSON |
| `ASSETS` | Static assets | Dashboard SPA |
| `PROXY_LOADER` | Worker Loader | Runs Dynamic Worker proxy fns |

Required vars: `ENVIRONMENT_ID`. Required secrets:
`ANTHROPIC_ENVIRONMENT_KEY`, `ANTHROPIC_API_KEY`, `WEBHOOK_SECRET`.

Optional but useful:

| Binding | Enables |
| --- | --- |
| `LOADER` (Worker Loader) | Isolate `execute`, `run_file`, browser tools |
| `BROWSER` | Browser Rendering tools |
| `AI` | Workers AI tools (e.g. image generation) |
| `BACKUP_BUCKET` (R2) | MicroVM workspace snapshots |
| `SEND_EMAIL` | `email_send` |
| `vpc_services`, `vpc_networks` | Private-network reach |

## Where to look in the code

| Area | File |
| --- | --- |
| Worker entrypoint | `src/index.ts` |
| Hono API surface | `src/api/index.ts` |
| Webhook ingress + dispatch | `src/webhooks.ts` |
| MicroVM sandbox class | `src/microvm/sandbox.ts` |
| Isolate runner | `src/isolate/runner.ts` |
| Isolate outbound gateway | `src/isolate/gateway.ts` |
| Egress compile + apply | `src/egress/handler.ts` |
| cf_* tool factories (shared) | `src/tools/cf/` |
| Tool registry + schemas (shared) | `src/tools/` |
| Custom-tool dispatcher (shared) | `src/isolate/custom-dispatch.ts` |
| User-defined custom tools | `src/tools/custom-tools.ts` |
| D1 access layer | `src/storage.ts` |
| Migrations | `migrations/000*.sql` |
