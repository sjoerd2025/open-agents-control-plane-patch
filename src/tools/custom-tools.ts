// =============================================================================
// CUSTOM TOOLS — add your own agent tools here.
// =============================================================================
//
// This is the ONE file you edit to give agents new tools. Anything you put
// in the `CUSTOM_TOOLS` array below is automatically:
//
//   - registered on Isolate-Sandbox sessions (in-process tool dispatcher
//     in `src/isolate/runner.ts`)
//   - registered on MicroVM-Sandbox sessions (the Sandbox DO calls back
//     into the Worker's custom-tool dispatcher with the same registry)
//   - advertised to Anthropic in the agent's tool catalog as a
//     `type: "custom"` entry
//   - surfaced as a toggle in the agent form on the dashboard
//
// You do NOT need to touch `src/tools/*` registries, the schemas file,
// the control plane, or the frontend. The wiring picks them up
// automatically.
//
// See `docs/adding-custom-tools.md` for the full guide.
//
// -----------------------------------------------------------------------------
// Quick start
// -----------------------------------------------------------------------------
//
// 1. Copy the example below, uncomment it, and tweak the name / schema / run
//    function. The example calls a private VPC service; yours can do
//    anything the Worker has access to (KV, R2, D1, AI, fetch, etc).
//
// 2. If your tool needs a binding, declare a `requires` predicate and
//    add the binding to `wrangler.jsonc`. The tool will only register on
//    deployments where the binding is actually wired up.
//
// 3. `npm run deploy`. Open an agent on the dashboard — your tool will be
//    in the tool toggle list. Tick it and the agent can use it.
//
// -----------------------------------------------------------------------------
// Conventions
// -----------------------------------------------------------------------------
//
// - Tool names must be unique across the entire catalog. Don't reuse a
//   built-in name (`read`, `write`, `bash`, `web_fetch`, `glob`, `grep`).
//   The `cf_` prefix is the convention for binding-backed tools.
//
// - Descriptions should be short and actionable — the model reads them
//   to decide when to reach for the tool.
//
// - Inputs use Zod schemas. `.describe()` each field so the model knows
//   what to put there.
//
// - `run` returns a string (or a Promise<string>). Throw or return an
//   `error: ...` string to signal failure; the dispatcher will surface
//   it to the model as a tool error.
//
// =============================================================================

import { z } from "zod";
import { defineTool, type CustomTool } from "./custom-tools-runtime";

// Add your tools to this array. Order doesn't matter.
export const CUSTOM_TOOLS: CustomTool[] = [
  // ---------------------------------------------------------------------------
  // EXAMPLE — uncomment and customise.
  // ---------------------------------------------------------------------------
  //
  // Looks up a user from a private VPC service. Demonstrates:
  //  - a Zod input schema with a typed argument
  //  - a `requires` predicate that hides the tool when the binding is missing
  //  - a `run` function that hits a binding and returns the body
  //
  // defineTool({
  //   name: "cf_lookup_user",
  //   description:
  //     "Look up a user profile from the internal users service. Takes a stable user id.",
  //   inputSchema: z.object({
  //     userId: z.string().describe("Stable user id, e.g. usr_abc123"),
  //   }),
  //   requires: (env) => Boolean((env as unknown as { USERS?: unknown }).USERS),
  //   run: async ({ userId }, { env }) => {
  //     const users = (env as unknown as { USERS: Fetcher }).USERS;
  //     // The VPC binding routes to the Host/Port configured on the VPC
  //     // Service in the dashboard; the URL host here is just a placeholder.
  //     const r = await users.fetch(`http://service.local/v1/${userId}`);
  //     if (!r.ok) return `error: ${r.status} ${await r.text()}`;
  //     return await r.text();
  //   },
  // }),
  // ---------------------------------------------------------------------------
  // More examples to copy from
  // ---------------------------------------------------------------------------
  //
  // KV lookup:
  //
  // defineTool({
  //   name: "cf_kv_get",
  //   description: "Read a value from the configured KV namespace.",
  //   inputSchema: z.object({ key: z.string() }),
  //   requires: (env) => Boolean((env as unknown as { MY_KV?: unknown }).MY_KV),
  //   run: async ({ key }, { env }) => {
  //     const kv = (env as unknown as { MY_KV: KVNamespace }).MY_KV;
  //     return (await kv.get(key)) ?? "(not found)";
  //   },
  // }),
  //
  // Workers AI (text classification):
  //
  // defineTool({
  //   name: "cf_classify",
  //   description: "Classify text sentiment as positive / negative / neutral.",
  //   inputSchema: z.object({ text: z.string().min(1) }),
  //   requires: (env) => Boolean((env as unknown as { AI?: unknown }).AI),
  //   run: async ({ text }, { env }) => {
  //     const ai = (env as unknown as { AI: Ai }).AI;
  //     const result = await ai.run("@cf/huggingface/distilbert-sst-2-int8", { text });
  //     return JSON.stringify(result);
  //   },
  // }),
];
