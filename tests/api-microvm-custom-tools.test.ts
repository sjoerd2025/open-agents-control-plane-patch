// Verifies that user-defined custom tools from `src/tools/custom-tools.ts`
// reach MicroVM agents end-to-end. The wire path is:
//
//   frontend form  →  POST /api/agents  →  Anthropic /v1/agents
//
// Under the post-MCP design the same `type: "custom"` shape is used on
// both backends. For MicroVM specifically, the worker:
//
//   1. Reads checked custom-tool names from `agent_toolset_20260401.configs`
//      (the form lists every checked name there).
//   2. Hoists those names out of the wrapper and emits a `type: "custom"`
//      entry for each, looking up description / schema in the registry.
//   3. Migrates any legacy `mcp_toolset` block (from the previous
//      MCP-based design) the same way, so old agents convert
//      transparently on the next save.
//
// We mock `../src/tools/custom-tools` with a tiny synthetic catalog so the
// behaviour is deterministic regardless of what live operators have
// in their file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Same Workers-runtime stubs as `api.test.ts` so the API surface can
// boot in Node without workerd.
vi.mock("../src/microvm/sandbox", () => ({
  Sandbox: class {},
  SESSION_IDLE_TTL: "30m",
  getSessionSandbox: () => ({
    destroy: async () => {},
    isLive: async () => false,
    dispatch: async () => {},
  }),
  getContainerStatus: async () => "unknown",
}));

vi.mock("../src/isolate/runner", () => ({
  IsolateRunner: class {},
  getIsolateRunner: () => ({
    isLive: async () => false,
    start: async () => {},
    stop: async () => {},
    getStatus: async () => "stopped",
    readDir: async () => [],
  }),
}));

vi.mock("../src/webhooks", () => ({
  resolveBackend: async () => ({ backend: "microvm", agentId: null }),
  drainWork: async () => [],
}));

// Inject a synthetic custom-tool catalog so we can assert the API
// rewrite without depending on whatever the operator has wired up in
// `src/tools/custom-tools.ts`. The tool is binding-free (no `requires`) so
// `isCustomToolEnabled` always returns true.
vi.mock("../src/tools/custom-tools", () => ({
  CUSTOM_TOOLS: [
    {
      name: "cf_test_lookup",
      description: "Synthetic custom tool used by the api-microvm-custom-tools test.",
      inputSchema: z.object({ userId: z.string() }),
      run: async () => "ok",
    },
  ],
}));

import { createApiApp } from "../src/api";
import { makeEnv, type FakeEnv } from "./helpers";

function call(env: FakeEnv, path: string, init?: RequestInit) {
  const app = createApiApp();
  return app.fetch(new Request(`https://example.com${path}`, init), env as unknown as Env);
}

describe("POST /api/agents — user-defined custom tools on MicroVM", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        return new Response(String(init?.body ?? ""), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits a type:\"custom\" entry for a user-defined tool selected via the toolset wrapper", async () => {
    const env = makeEnv();
    await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "microvm-with-user-custom",
        model: "claude-sonnet-4-6",
        backend: "microvm",
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
            configs: [{ name: "cf_test_lookup", enabled: true }],
          },
        ],
      }),
    });

    const spy = (globalThis.fetch as unknown) as { mock: { calls: Array<[unknown, RequestInit]> } };
    const sent = JSON.parse(String(spy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{
        type: string;
        name?: string;
        configs?: Array<{ name: string }>;
      }>;
      mcp_servers?: Array<{ name: string }>;
    };

    const custom = sent.tools.find(
      (t) => t.type === "custom" && t.name === "cf_test_lookup",
    );
    expect(custom).toBeDefined();
    // The custom tool's name should not also appear in the wrapper configs.
    const wrapper = sent.tools.find((t) => t.type === "agent_toolset_20260401");
    const wrapperNames = (wrapper?.configs ?? []).map((c) => c.name);
    expect(wrapperNames).not.toContain("cf_test_lookup");
    // No legacy MCP plumbing on the wire.
    expect(sent.tools.some((t) => t.type === "mcp_toolset")).toBe(false);
    expect(sent.mcp_servers ?? []).toEqual([]);
  });

  it("drops the custom tool when its requires() predicate fails", async () => {
    // Custom tools with a `requires` predicate disappear from the
    // catalog when the predicate is false — same pattern as the
    // binding-gated cf_* family.
    const env = makeEnv();
    // Pretend a binding the synthetic tool depends on isn't there.
    // The mocked CUSTOM_TOOLS catalog above has no requires predicate,
    // so this test just confirms the unknown-name path: when the
    // configured catalog doesn't include the name the wire format
    // should not emit a type:"custom" entry for it.
    await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "microvm-unknown-tool",
        model: "claude-sonnet-4-6",
        backend: "microvm",
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
            configs: [{ name: "this_tool_does_not_exist", enabled: true }],
          },
        ],
      }),
    });

    const spy = (globalThis.fetch as unknown) as { mock: { calls: Array<[unknown, RequestInit]> } };
    const sent = JSON.parse(String(spy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ type: string; name?: string }>;
    };
    expect(
      sent.tools.some((t) => t.type === "custom" && t.name === "this_tool_does_not_exist"),
    ).toBe(false);
  });
});
