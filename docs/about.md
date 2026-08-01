# About

## Overview

This is a Workers-based control-plane for [Claude Managed
Agents](https://docs.claude.com/en/docs/claude-platform/managed-agents/overview)
that you deploy to your own
[Cloudflare](https://developers.cloudflare.com/workers/) account. It
gives each session its own sandbox (either a MicroVM container or a
Workers Isolate), routes the agent's outbound traffic through a
per-session egress policy, and exposes a dashboard for managing
agents, sessions, secrets, and policies. Anthropic's platform
drives the agent loop; Cloudflare provides the runtime that the
agent's tools execute in.

## Why run Claude Managed Agents on Cloudflare

Cloudflare gives you a variety of benefits when running Claude Managed Agents:
- Sandbox customization and observability
- Security
- Isolate-based and microVM-based sandboxes
- Private service connectivity
- Programmability and custom tool integration

### Control and observability over your sandboxes

The agent does its work inside a sandbox you own.

- **Pick the instance size.** `dev`, `basic`, `standard`, or any of the larger
  variants — set it in `wrangler.jsonc` and redeploy.
- **Customize the Docker image.** The sandbox runs using a container image you fully control.
- Bake in language toolchains, CLI tools, or org-specific binaries instead of
  shipping setup steps in every prompt.
- **Logs and live SSH.** Every session shows up in
  [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/).
  Open a shell into a running sandbox from the dashboard to see what the
  agent saw, run ad-hoc commands, or do live debugging of stuck tasks.

See [customizing sandboxes](./customizing-sandboxes.md) for more information.

### Secure each agent session end-to-end

Intercept and control each agent's access to the outside world:

- **Lock down internet access.** Add allow or deny lists to restrict which
  domains the agent can access.
- **Zero-trust secret injection.** Secrets are injected into outbound requests
- but never exposed to the agent. Secret rotation is simple and picked up automatically.
- **Customizable proxies.** Add fully programmable and dynamic proxies to
  control egress traffic however you want. Apply per-tenant policy, inspect
  request content, add custom observability.

Policies can be customized and applied to different agents and sessions based on simple
rules.

See [Applying Egress Policies](./applying-egress-policies.md) for more information.

### Reach private services anywhere

[Workers VPC](https://developers.cloudflare.com/workers-vpc) + [Mesh](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-mesh/)
give your agent a private path into your existing
infrastructure — on any cloud provider or on-prem — without exposing it to the
public internet. Walk through the wiring in
[Connecting to Private Services](./connecting-to-private-services.md).

### Two sandbox shapes for two workloads

Pick the sandbox that matches the task:

- **MicroVM sandboxes** give the agent a full Linux container with bash,
  a writable filesystem, and arbitrary processes. Use these for code
  generation, builds, and anything that needs a real shell and VM.
- **Isolate sandboxes** cold-start in milliseconds and are dramatically
  cheaper to run, while still being able to write files and execute arbitrary
  code. They do not have a full Linux VM, but are suitable for many agent workloads.

[Isolate vs VM-based Sandboxes](./isolate-vs-vm-sandboxes.md) compares the
two side-by-side.

### Extend the agent with custom tools

Adding tools with no additional infrastructure overhead is easy. Just
add a tool definition in `src/tools/custom-tools.ts` and redeploy.

See [Adding Custom Tools](./adding-custom-tools.md) for more information.

### Use the Cloudflare Developer Platform as your tool surface

Every other product on the platform is a binding away:

- **[Workers AI](https://developers.cloudflare.com/workers-ai/)** for inline classifiers, embeddings, and small LLM calls.
- **[Vectorize](https://developers.cloudflare.com/vectorize/)** for semantic recall across sessions.
- **[Browser Rendering](https://developers.cloudflare.com/browser-rendering/)** for headless web fetches and screenshots.
- **[R2](https://developers.cloudflare.com/r2/)** for build artefacts, generated files, and screenshots.
- **[Durable Objects](https://developers.cloudflare.com/durable-objects/)** for cross-session co-ordination, locks, and rate limits.
- **[Workers VPC](https://developers.cloudflare.com/workers-vpc/)** for private-network reachability.
- **[Artifacts](https://developers.cloudflare.com/artifacts/)**, **[Queues](https://developers.cloudflare.com/queues/)**, **[Hyperdrive](https://developers.cloudflare.com/hyperdrive/)**, **[D1](https://developers.cloudflare.com/d1/)**, **[KV](https://developers.cloudflare.com/kv/)** — anything you can bind to a Worker, the agent can use.
