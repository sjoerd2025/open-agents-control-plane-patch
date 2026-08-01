# Isolate vs VM-based Sandboxes

This runner ships **two** sandbox backends. Each session gets its own
sandbox; the choice is per-agent and saved alongside the agent in D1.

| | MicroVM Sandbox | Isolate Sandbox |
| --- | --- | --- |
| Implementation | [Cloudflare Container](https://developers.cloudflare.com/containers/) | [Workers Isolate](https://developers.cloudflare.com/workers/reference/how-workers-works/) |
| Cold start | ~2 seconds | sub-second |
| Filesystem | full Linux (`/workspace`) | SQLite-backed `Workspace` (`@cloudflare/shell`) |
| Shell / arbitrary processes | yes (`bash`) | no |
| Persistence | R2 snapshots of `/workspace` | Durable Object SQLite, automatic |
| Code execution tool | shell-driven | [codemode](https://developers.cloudflare.com/agents/api-reference/code-mode/) (`execute`, `run_file`; require `LOADER`) |
| Best for | builds, installs, anything needing a real shell | structured edits, tool-heavy tasks, fast iteration |

Both backends share the egress policy engine, the dashboard, the webhook
ingress, and the agent management API. The difference is what happens
once a session starts.

## Why two backends?

The right shape depends on the task:

- **Reach for MicroVM** when the agent will run `npm install`, build a
  binary, fix a failing test suite, install a CLI, or otherwise needs a
  real Linux environment. The container is the Cloudflare Sandbox SDK
  base image with the Anthropic `ant` CLI on `PATH`. You can ship your
  own tools in by editing the `Dockerfile`.

- **Reach for Isolate** when the agent is doing structured work over a
  known set of files — code review, refactoring, generating documentation
  from a repo, applying a series of edits. Isolate sessions cold-start
  in milliseconds, persist across hibernation natively, and cost a
  fraction of a container session because there's no MicroVM to keep
  warm. The trade-off: no shell, and tool calls are constrained to what
  the control plane registers.

In practice teams pick one default and use the other for specific
agents.

## What each backend looks like at runtime

### MicroVM — `src/microvm/sandbox.ts`

The `Sandbox` class extends `@cloudflare/sandbox`'s `SandboxBase`. One
container per session, addressed by `idFromName(sessionId)`. On
dispatch:

1. Resolve the egress policy for this session and register it as the
   container's outbound handler (HTTPS interception is on, so even TLS
   traffic flows through your policy).
2. Boot the container with the work payload's secrets injected as env
   vars.
3. Restore the latest R2 snapshot into `/workspace`, if any.
4. Start the agent loop:

   ```sh
   ant beta:worker run \
     --workdir /workspace \
     --unrestricted-paths \
     --max-idle 60s \
     --log-format json
   ```

5. On `SESSION_IDLE_TTL` of idle, snapshot `/workspace` to R2 and let
   the container hibernate. The default is **3 minutes**, set in
   `src/microvm/sandbox.ts`. Edit the constant — or override per-deploy
   by bumping it before `npm run deploy` — if you'd rather pay for
   warmth than cold boots.

The agent gets the stock Anthropic toolset (bash, file ops, web fetch,
etc.) running locally inside the container. Cloudflare-specific tools
(the `cf_*` family, plus `browser_search` / `browser_execute` when
`LOADER` + `BROWSER` are bound) ride the same agent payload as `type:
"custom"` entries; the Sandbox Durable Object runs
`runCustomToolDispatcher` alongside the container, polls Anthropic for
`agent.custom_tool_use` events, and answers them with handlers that
close over the Worker's `env`. The browser tools share the same
runtime factory as the Isolate backend — they spin up a fresh Worker
isolate via `LOADER` and call `BROWSER` directly, so the container is
uninvolved.

### Isolate — `src/isolate/runner.ts`

`IsolateRunner` is a plain Durable Object with a SQLite-backed workspace
(`@cloudflare/shell`). On dispatch:

1. Resolve and attach the egress policy via `IsolateOutboundGateway`
   (a `WorkerEntrypoint` used as `globalOutbound` for any code the
   agent runs through Worker Loaders).
2. Build the tool list:
    - workspace tools (`cf_read`, `cf_write`, `cf_edit`,
      `list`, `find`, `cf_grep`, `delete`)
    - `execute` and `run_file` (when `LOADER` is bound)
   - browser tools (`browser_search`, `browser_execute`) when
     `LOADER` and `BROWSER` are both bound
   - `cf_*` tools for any other Cloudflare bindings present
3. Construct an Anthropic SDK `ToolDispatcher` and run it detached. The
   model runs at Anthropic; tool calls stream into this Durable Object
   and run locally.

The Durable Object sleeps after 60 seconds of idle. Anthropic sends
another webhook when there's new work, and the control plane picks back up
where it left off because SQLite state survives.

## Configuring the MicroVM container

Container image and instance size live in `wrangler.jsonc`. See
[Customizing Sandboxes](./customizing-sandboxes.md) for the full reference.

## Picking a backend

In the dashboard: **Agents → New Agent → Backend** has a radio between
MicroVM and Isolate. The form also lets you choose which Isolate tools
to enable per agent.

Programmatically, set the backend at agent-create time by passing a
`backend` field alongside the usual agent fields:

```sh
curl -X POST https://<worker>/api/agents \
  -H 'content-type: application/json' \
  -d '{"name": "my-isolate-agent", "model": "claude-sonnet-4-6", "backend": "isolate", "tools": []}'
```

The dashboard's POST handler strips `backend` from the payload before
forwarding to Anthropic (the upstream API doesn't know about it) and
persists it in the local `agent_backends` D1 table. To CHANGE an
existing agent's backend, POST to the same agent id with the new
value:

```sh
curl -X POST https://<worker>/api/agents/<agentId> \
  -H 'content-type: application/json' \
  -d '{"backend": "isolate"}'
```

Read it back with `GET /api/agents/<agentId>/backend`.

Backend choice is sticky per-agent. Existing sessions keep whatever
backend they were dispatched on; new sessions follow the agent's
current setting.

## Live debugging (MicroVM)

MicroVM sessions get a live shell via the dashboard's terminal pane,
backed by `/ws/terminal`. You can see exactly what the agent saw, run
ad-hoc commands, and follow the Sandbox SDK's process logs without
restarting.

Isolate sessions don't have a shell to attach to. Use Workers Logs
(`npx wrangler tail`) to follow tool calls; the dispatcher logs each
tool name and outcome.
