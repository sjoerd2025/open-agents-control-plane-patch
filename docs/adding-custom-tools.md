# Adding Custom Tools

There is **one file** to edit when you want to give an agent a new tool:
[`src/tools/custom-tools.ts`](../src/tools/custom-tools.ts).

Anything you add to the `CUSTOM_TOOLS` array will be availible
to attach to any agent on agent create.

## Quick start

Open [`src/tools/custom-tools.ts`](../src/tools/custom-tools.ts). Inside the
`CUSTOM_TOOLS` array, add an entry:

```ts
import { z } from "zod";
import { defineTool, type CustomTool } from "./custom-tools-runtime";

export const CUSTOM_TOOLS: CustomTool[] = [
  defineTool({
    name: "lookup_user",
    description: "Look up a user profile from the internal users service.",
    inputSchema: z.object({
      userId: z.string().describe("Stable user id, e.g. usr_abc123"),
    }),
    requires: (env) => Boolean((env as unknown as { USERS?: unknown }).USERS),
    run: async ({ userId }, { env }) => {
      const users = (env as unknown as { USERS: Fetcher }).USERS;
      const r = await users.fetch(`http://users.local/v1/${userId}`);
      if (!r.ok) return `error: ${r.status} ${await r.text()}`;
      return await r.text();
    },
  }),
];
```

Declare any required binding in `wrangler.jsonc`:

```jsonc
"vpc_services": [
  { "binding": "USERS", "service_id": "..." }
]
```

Deploy:

```sh
npm run deploy
```

Open the dashboard. Your new tool appears in the toggle list on both
backends. Tick it, save the agent, and the model can call it from the
next session.

Now your Managed Agents can use your custom tool.

## Anatomy of a custom tool

```ts
defineTool({
  name: "cf_lookup_user",       // unique;
  description: "...",           // shown to the model
  inputSchema: z.object({...}), // zod schema; must be a z.object(...)
  requires: (env) => ...,       // optional binding gate
  run: async (input, ctx) => {
    // input is the validated z.infer<typeof inputSchema>
    // ctx.env is the Worker's Env (all bindings)
    return "string result";
  },
})
```

Notes on each field:

- **`name`** — must be unique across the entire catalog. Don't reuse a
  built-in name (`read`, `write`, `bash`, `web_fetch`, `glob`, `grep`).
- **`description`** — keep it short and actionable. The model reads it
  to decide when to reach for the tool.
- **`inputSchema`** — Zod schema. Must resolve to a JSON object
  (`z.object(...)`) because Anthropic requires tool inputs to be
  objects. Use `.describe()` on each field — that text flows through
  to the JSON Schema and helps the model fill in correct values.
- **`requires`** — optional. Returns true when the tool should be
  available on this deployment. Use it to hide tools whose required
  binding isn't configured. Tools without a `requires` predicate
  always register.
- **`run`** — the implementation. The first argument is the validated
  input. The second is a context with `env` (all Worker bindings).
  Return a string. Throw or return an `error: ...` string to signal
  failure; the dispatcher surfaces it to the model as a tool error.

## Why use a custom tool

- **Domain-specific shortcuts.** Instead of teaching the agent to craft
  a `curl` command against your auth service, give it a `lookup_user`
  tool with a typed input/output. Shorter prompts, fewer mistakes,
  easier to test.
- **Easy integration with Cloudflare bindings.** The agent gets to use
  Vectorize for search, R2 for blob storage, D1 for queries, and
  Durable Objects for stateful coordination — all without leaving
  Cloudflare.
- **Better guardrails.** A custom tool can validate inputs, enforce
  rate limits, redact PII, or check authorization before doing the
  work.
- **Replace shaky shell commands.** Anything the agent does today by
  shelling out is a candidate for a typed tool with a smaller failure
  surface.

## More examples

Look in [`src/tools/custom-tools.ts`](../src/tools/custom-tools.ts) for
ready-to-copy examples.

## Built-in tools

This repository ships with a tool catalog covering Cloudflare's developer
platform. Each tool is gated on the relevant binding, so it only
appears in the agent's catalog when the operator has wired it up.

This is meant to give you a jumping-off point for further customization
and integrations.

### Workspace (Isolate only)

A SQLite-backed virtual filesystem the agent can read, write, and
search. Always available on Isolate sessions. Backed by
[`@cloudflare/shell`](https://www.npmjs.com/package/@cloudflare/shell).

| Tool | Purpose |
| --- | --- |
| `cf_read` | Read a UTF-8 file |
| `cf_write` | Write a UTF-8 file (creates parent dirs) |
| `cf_edit` | Replace the first match in a file |
| `list` | List files and directories |
| `find` | Glob for paths |
| `cf_grep` | Search file contents (regex) |
| `delete` | Delete a file or directory |

### Code execution (Isolate only, requires `LOADER`)

Runs JavaScript in a sandboxed isolate via the
[Worker Loader binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/).
The agent uses
[code mode](https://developers.cloudflare.com/agents/api-reference/code-mode/)
to chain multi-step work into a single tool call.

| Tool | Purpose |
| --- | --- |
| `execute` | Run inline JavaScript in a fresh isolate |
| `run_file` | Read a file from the workspace and run it |

### Browser Rendering

See [Browser Rendering Tools](./browser-rendering-tools.md) for the
full reference. Summary:

| Tool | Backend | Purpose |
| --- | --- | --- |
| `cf_web_fetch` | both | Fetch a URL; auto-detects PDFs; preferred over the built-in `web_fetch` |
| `fetch_to_markdown` | both | URL → clean markdown |
| `browse` | both | URL → rendered HTML |
| `screenshot` | both | Capture a PNG of a URL |
| `browser_search` | both (needs `LOADER` + `BROWSER`) | Query the CDP spec |
| `browser_execute` | both (needs `LOADER` + `BROWSER`) | Run CDP commands against a live browser |

### Workers AI (requires `AI`)

Image generation through
[Workers AI](https://developers.cloudflare.com/workers-ai/), defaulting
to
[`@cf/black-forest-labs/flux-2-dev`](https://developers.cloudflare.com/workers-ai/models/flux-2-dev/).

You can change the image model by tweaking the tool code.

| Tool | Purpose |
| --- | --- |
| `image_generate` | Text prompt → PNG saved to the workspace (or returned inline on MicroVM) |

### Workers VPC (requires `vpc_services` bindings)

Calls private services exposed through
[Workers VPC](https://developers.cloudflare.com/workers-vpc/) without
the agent having to know hostnames. The available bindings are
discovered at runtime from `wrangler.jsonc` and surfaced as an enum
on the tool input.

| Tool | Purpose |
| --- | --- |
| `call_service` | Call a private VPC service by binding name |

See [Connecting to Private Services](./connecting-to-private-services.md)
for the full setup.

### Email Routing

See [Agent Email](./agent-email.md) for the full reference. Summary:

| Tool | Purpose |
| --- | --- |
| `email_send` | Send an email through Email Routing |
| `email_inbox` | List recent emails delivered to this session's inbox |
| `email_read` | Read the full body of a single message |

## How it works under the hood

Skip this section unless you're debugging or extending the machinery.

Each entry in `CUSTOM_TOOLS` is read in three places:

- [`src/tools/cf/index.ts`](../src/tools/cf/index.ts) — `buildCfTools`
  appends customs to the runtime catalog both backends' dispatchers
  consume, and `cfToolGroups` registers them for drift detection.
- [`src/tools/schemas.ts`](../src/tools/schemas.ts) — `customToolAgentDef`
  converts each tool into an entry on the Anthropic agent payload at
  agent-create time.
- `/api/custom-tools` — the dashboard reads this on agent-form mount.
  Tools whose `requires()` predicate fails render disabled with a
  "binding not configured" hint.

Each checked custom tool ships to Anthropic as a `type: "custom"`
entry. At runtime, your `run` function executes inside the session's
Durable Object — IsolateRunner for Isolate sessions, Sandbox for
MicroVM. Both have full `env` access, so calls are a single function
invocation: no container egress, no MCP relay, no virtual hostname.

The DO dispatcher answers `agent.custom_tool_use` events directly. On
MicroVM, Anthropic's stock toolset (bash, read, write, edit, glob,
grep, web_fetch, web_search) is handled by `ant beta:worker run`
inside the container via `agent.tool_use` — your custom tools are on a
parallel event channel and stay in the DO.

## Drift detection

Long-lived dispatchers can outlast a deploy. The control plane keeps a list
of the active dispatcher's tool names and compares it against the
current build:

```ts
// src/isolate/runner.ts
if (!toolNamesMatch(running.tools, desired)) {
  await running.controller.abort();
  // … start a fresh dispatcher with the updated tool set
}
```

Adding a new custom tool, removing an old one, or changing a tool's
name takes effect on the **next** Anthropic event for that session —
not the next deploy.

## Troubleshooting

- **"tool not implemented" errors.** Either the tool's `requires()`
  predicate is failing (so the dispatcher didn't register it), or you
  changed the tool's name between defining it and deploying. The
  `/api/custom-tools` endpoint shows you which tools are available on
  the current deployment.
- **Tool is registered but the agent doesn't use it.** Open the agent
  on the dashboard — custom tools are opt-in per agent. Tick the
  checkbox and save.
- **Tool works on Isolate but not MicroVM (or vice versa).** Both
  backends run the dispatcher inside their respective Durable Object
  with the same `env`, so the most likely cause is a binding that's
  only wired up for one DO — or a tool that depends on the Workspace
  (Isolate-only). Bindings declared inside the container itself (e.g.
  through a startup script) are NOT visible to the dispatcher; only
  Worker bindings declared in `wrangler.jsonc` are.
- **"Custom tool must use a z.object(...)".** Anthropic requires tool
  inputs to be JSON objects. If your tool takes a single string, wrap
  it: `z.object({ value: z.string() })`.
