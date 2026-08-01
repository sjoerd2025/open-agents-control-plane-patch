// Basic API endpoint tests. We hit the Hono app directly with synthetic
// Request objects and the in-memory env from `helpers.ts`. The `/api/agents`
// and `/api/sessions` endpoints proxy to the Anthropic API — those are
// covered by smoke tests that stub global fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Sandbox module pulls in `cloudflare:workers`, which doesn't exist in
// Node. We replace it with stand-ins that return predictable values so the
// API surface can run end-to-end without booting workerd.
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

// IsolateRunner pulls in `cloudflare:workers` and the Anthropic SDK runner
// module (which transitively requires Node-only globs). Stub it for the
// API tests — backend resolution is exercised in the webhook integration
// suite where workerd is actually available.
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

// Webhooks transitively imports the Anthropic SDK runner module too via
// the new resolveBackend helper. Stub the helper here so api.ts's status,
// stop, and list endpoints can run without it. The test cases that hit
// these endpoints exercise the "no row" path where backend defaults to
// "microvm", so the stub is intentionally minimal.
vi.mock("../src/webhooks", () => ({
  resolveBackend: async () => ({ backend: "microvm", agentId: null }),
  drainWork: async () => [],
}));

import { createApiApp } from "../src/api";
import { ISOLATE_TOOL_NAMES } from "../src/tools/schemas";
import {
  recordWebhookEvent,
  setAgentBackend,
  upsertSession,
} from "../src/storage";
import { makeEnv, type FakeEnv } from "./helpers";

function call(env: FakeEnv, path: string, init?: RequestInit) {
  const app = createApiApp();
  return app.fetch(new Request(`https://example.com${path}`, init), env as unknown as Env);
}

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// /api/config
// ---------------------------------------------------------------------------

describe("GET /api/config", () => {
  it("reports configured ids and an empty missing list when secrets are present", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/config");
    expect(res.status).toBe(200);
    const body = await json<{ environmentId: string; missing: string[] }>(res);
    expect(body.environmentId).toBe("env_test");
    expect(body.missing).toEqual([]);
  });

  it("flags missing secrets without leaking values", async () => {
    const env = makeEnv({ ANTHROPIC_API_KEY: "", WEBHOOK_SECRET: "" });
    const body = await json<{ missing: string[] }>(await call(env, "/api/config"));
    expect(body.missing).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "WEBHOOK_SECRET"]));
  });
});

// ---------------------------------------------------------------------------
// /api/openapi.json
// ---------------------------------------------------------------------------

describe("GET /api/openapi.json", () => {
  it("returns a 3.1 spec covering the dashboard surface", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/openapi.json");
    expect(res.status).toBe(200);
    const body = await json<{
      openapi: string;
      paths: Record<string, unknown>;
      servers?: Array<{ url: string }>;
    }>(res);
    expect(body.openapi.startsWith("3.")).toBe(true);
    // Spot-check a handful of routes that downstream consumers (the
    // frontend's API Reference view, third-party clients) will hit.
    expect(body.paths).toHaveProperty("/api/config");
    expect(body.paths).toHaveProperty("/api/environments");
    expect(body.paths).toHaveProperty("/api/agents");
    expect(body.paths).toHaveProperty("/webhooks");
    // The handler injects the request origin so Scalar's "Try it" button
    // hits the same deployment the docs are loaded from.
    expect(body.servers?.[0]?.url).toBe("https://example.com");
  });
});

// ---------------------------------------------------------------------------
// /api/secrets — CRUD
// ---------------------------------------------------------------------------

describe("/api/secrets", () => {
  let env: FakeEnv;
  beforeEach(() => {
    env = makeEnv();
  });

  it("rejects bad keys", async () => {
    const res = await call(env, "/api/secrets/$%^bad", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty values", async () => {
    const res = await call(env, "/api/secrets/MY_KEY", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("round-trips a secret through PUT, GET, list, DELETE", async () => {
    const put = await call(env, "/api/secrets/API_TOKEN", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-test" }),
    });
    expect(put.status).toBe(200);

    const get = await call(env, "/api/secrets/API_TOKEN");
    expect(get.status).toBe(200);
    const body = await json<{ key: string; value: string }>(get);
    expect(body).toEqual({ key: "API_TOKEN", value: "sk-test" });

    const list = await json<{ items: Array<{ key: string }> }>(await call(env, "/api/secrets"));
    expect(list.items.map((i) => i.key)).toContain("API_TOKEN");

    const del = await call(env, "/api/secrets/API_TOKEN", { method: "DELETE" });
    expect(del.status).toBe(200);

    const after = await call(env, "/api/secrets/API_TOKEN");
    expect(after.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /api/environments + /api/webhook-events (D1-backed)
// ---------------------------------------------------------------------------

describe("/api/environments", () => {
  it("returns an empty page when D1 is empty", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/environments?page=1&limit=20");
    expect(res.status).toBe(200);
    const body = await json<{ items: unknown[]; total: number }>(res);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns sessions ordered by lastWebhookAt desc", async () => {
    const env = makeEnv();
    // Stub getContainerStatus by intercepting Sandbox calls — but our fake env
    // doesn't have a real Sandbox DO, so getContainerStatus will fall back to
    // "unknown" via its catch block. That's fine for this test.
    await upsertSession(env.DB, "session_alpha", "session.status_run_started");
    await new Promise((r) => setTimeout(r, 5));
    await upsertSession(env.DB, "session_beta", "session.status_idled");

    const res = await call(env, "/api/environments?page=1&limit=20");
    const body = await json<{ items: Array<{ sessionId: string; containerStatus: string }>; total: number }>(res);
    expect(body.total).toBe(2);
    expect(body.items[0].sessionId).toBe("session_beta");
    expect(body.items[1].sessionId).toBe("session_alpha");
    expect(body.items[0].containerStatus).toBe("unknown");
  });
});

describe("/api/webhook-events", () => {
  it("paginates events newest-first", async () => {
    const env = makeEnv();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await recordWebhookEvent(env.DB, {
        type: "event",
        id: `ev_${i}`,
        timestamp: new Date(now - (5 - i) * 1000).toISOString(),
        data: { type: "session.status_run_started", id: `session_${i}` },
      });
    }

    const res = await call(env, "/api/webhook-events?limit=2");
    const body = await json<{ items: Array<{ id: string }>; cursor: string | null; hasMore: boolean }>(res);
    expect(body.items.map((i) => i.id)).toEqual(["ev_4", "ev_3"]);
    expect(body.hasMore).toBe(true);

    const next = await call(env, `/api/webhook-events?limit=2&cursor=${body.cursor}`);
    const nextBody = await json<{ items: Array<{ id: string }> }>(next);
    expect(nextBody.items.map((i) => i.id)).toEqual(["ev_2", "ev_1"]);
  });

  it("returns 404 for unknown event ids", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/webhook-events/nope");
    expect(res.status).toBe(404);
  });

  it("clears all events on DELETE", async () => {
    const env = makeEnv();
    await recordWebhookEvent(env.DB, {
      type: "event",
      id: "ev_clear",
      timestamp: new Date().toISOString(),
      data: { type: "session.status_run_started", id: "session_clear" },
    });
    const del = await call(env, "/api/webhook-events", { method: "DELETE" });
    const body = await json<{ deleted: number }>(del);
    expect(body.deleted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// /api/egress-policies — CRUD + validation
// ---------------------------------------------------------------------------

describe("/api/egress-policies", () => {
  const samplePolicy = {
    id: "pol_test123",
    name: "production",
    egressRules: [{ type: "allow", host: "api.example.com" }],
    sessionIds: ["session_alpha"],
    applyTo: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("rejects invalid policy ids", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/egress-policies/not-a-pol-id", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(samplePolicy),
    });
    expect(res.status).toBe(400);
  });

  it("rejects bodies missing required fields", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/egress-policies/pol_test123", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "pol_test123" }),
    });
    expect(res.status).toBe(400);
  });

  it("round-trips a policy through PUT, GET, list, DELETE", async () => {
    const env = makeEnv();
    const put = await call(env, "/api/egress-policies/pol_test123", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(samplePolicy),
    });
    expect(put.status).toBe(200);

    const list = await json<{ items: Array<{ id: string }> }>(
      await call(env, "/api/egress-policies"),
    );
    expect(list.items.map((i) => i.id)).toEqual(["pol_test123"]);

    const get = await call(env, "/api/egress-policies/pol_test123");
    expect(get.status).toBe(200);
    const fetched = await json<{ name: string }>(get);
    expect(fetched.name).toBe("production");

    const del = await call(env, "/api/egress-policies/pol_test123", { method: "DELETE" });
    expect(del.status).toBe(200);

    const empty = await json<{ items: unknown[] }>(await call(env, "/api/egress-policies"));
    expect(empty.items).toEqual([]);
  });

  it("returns 404 for unknown policies", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/egress-policies/pol_missing");
    expect(res.status).toBe(404);
  });

  // ApplyTo-matcher validation. The policy editor seeds blank matcher rows
  // by default (`frontend/src/views/EgressView.tsx`), so a half-filled save
  // is the realistic shape we need to reject.
  describe("applyTo matcher validation", () => {
    it("rejects a matcher whose field is empty", async () => {
      const env = makeEnv();
      const res = await call(env, "/api/egress-policies/pol_test123", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...samplePolicy,
          applyTo: [{ field: "", operator: "equals", value: "agent_alpha" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/applyTo\[0\]\.field/);
    });

    it("rejects equals/contains/matches matchers whose value is empty", async () => {
      const env = makeEnv();
      for (const operator of ["equals", "contains", "matches"] as const) {
        const res = await call(env, "/api/egress-policies/pol_test123", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...samplePolicy,
            applyTo: [{ field: "agent_id", operator, value: "" }],
          }),
        });
        expect(res.status, `operator=${operator}`).toBe(400);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toMatch(new RegExp(`applyTo\\[0\\]\\.value.*${operator}`));
      }
    });

    it("rejects is-one-of matchers with an empty values array", async () => {
      const env = makeEnv();
      const res = await call(env, "/api/egress-policies/pol_test123", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...samplePolicy,
          applyTo: [{ field: "agent_id", operator: "is-one-of", values: [] }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects matchers with an unknown operator", async () => {
      const env = makeEnv();
      const res = await call(env, "/api/egress-policies/pol_test123", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...samplePolicy,
          applyTo: [{ field: "agent_id", operator: "starts-with", value: "x" }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects matches matchers whose value is not a valid regex", async () => {
      const env = makeEnv();
      const res = await call(env, "/api/egress-policies/pol_test123", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...samplePolicy,
          applyTo: [{ field: "agent_id", operator: "matches", value: "(" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/not a valid regex/);
    });

    it("accepts a well-formed equals matcher (the common per-agent shape)", async () => {
      const env = makeEnv();
      const res = await call(env, "/api/egress-policies/pol_test123", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...samplePolicy,
          applyTo: [
            { field: "agent_id", operator: "equals", value: "agent_alpha" },
          ],
        }),
      });
      expect(res.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// /api/vpc — bindings are sourced from `src/vpc.generated.ts`, which is
// produced by `scripts/sync-vpc-bindings.mjs` from wrangler.jsonc.
// Generation is covered indirectly by the integration build; here we just
// confirm the endpoint shape stays stable.
// ---------------------------------------------------------------------------

describe("/api/vpc", () => {
  it("returns the generated bindings list and a docs URL", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/vpc");
    expect(res.status).toBe(200);
    const body = await json<{ items: unknown[]; docsUrl: string }>(res);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.docsUrl).toContain("workers-vpc");
  });
});

// ---------------------------------------------------------------------------
// Anthropic-proxied endpoints — confirm we only forward valid ids and
// pass through Anthropic's response.
// ---------------------------------------------------------------------------

describe("Anthropic proxy endpoints", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/v1/agents")) {
        return new Response(JSON.stringify({ data: [{ id: "agent_1", name: "test" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards GET /api/agents to Anthropic", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/agents");
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ id: string }> }>(res);
    expect(body.data[0].id).toBe("agent_1");
  });

  it("rejects malformed agent ids before hitting Anthropic", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/agents/not_an_agent");
    expect(res.status).toBe(400);
  });

  it("rejects malformed session ids before hitting Anthropic", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/sessions/not_a_session");
    expect(res.status).toBe(400);
  });

  it("injects ENVIRONMENT_ID when POST /api/sessions omits it", async () => {
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await call(env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: { type: "agent", id: "agent_xyz", version: "1" },
        title: "test",
      }),
    });
    expect(res.status).toBe(200);
    const sentBody = String(fetchSpy.mock.calls[0][1]?.body ?? "");
    const sent = JSON.parse(sentBody) as { environment_id: string };
    expect(sent.environment_id).toBe("env_test");
  });

  it("preserves an explicit environment override", async () => {
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment_id: "env_explicit", agent: { id: "agent_x" } }),
    });
    const sentBody = String(fetchSpy.mock.calls[0][1]?.body ?? "");
    const sent = JSON.parse(sentBody) as { environment_id: string };
    expect(sent.environment_id).toBe("env_explicit");
  });

  // Regression for the "Isolate agent's sessions dispatch as MicroVM"
  // bug. When the user creates a session via our /api/sessions handler,
  // we now cache (sessionId, agentId, backend) in D1 immediately so
  // the webhook dispatcher's resolveBackend() hits the cached path on
  // first sight — no Anthropic round-trip needed. Before this fix,
  // resolveBackend depended on `client.beta.sessions.retrieve()`
  // succeeding and its embedded `session.agent.id` matching the
  // original agent_backends row, and any failure there silently
  // defaulted backend="microvm" — routing an Isolate session into
  // the container dispatcher (which doesn't register the workspace
  // tools, so the model saw `Tool 'cf_write' not found`).
  it("caches the session's agent and backend in D1 on create so webhook dispatch hits the cached path", async () => {
    const env = makeEnv();
    // Pre-seed the agent_backends row that POST /api/agents would have
    // written for an Isolate agent.
    await setAgentBackend(env.DB, "agent_iso", "isolate");

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({ id: "session_xyz", title: "t" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await call(env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: { type: "agent", id: "agent_iso", version: 1 },
        title: "test",
      }),
    });
    expect(res.status).toBe(200);

    // The sessions row should now carry agent_id + backend so the
    // first webhook for this session can skip the Anthropic round-trip
    // and dispatch into the IsolateRunner DO directly.
    const row = await env.DB
      .prepare(`SELECT agent_id, backend FROM sessions WHERE session_id = ?`)
      .bind("session_xyz")
      .first<{ agent_id: string; backend: string }>();
    expect(row).toBeTruthy();
    expect(row?.agent_id).toBe("agent_iso");
    expect(row?.backend).toBe("isolate");
  });

  // The simpler `agent: "agent_..."` string shape the SDK example
  // documents also has to be picked up by the cacher — not just the
  // `agent: { id: "..." }` object form the dashboard sends. Without
  // this branch a CLI client that follows the SDK example would skip
  // the cache and fall back to the legacy round-trip path.
  it("accepts the string `agent` shape from the SDK example", async () => {
    const env = makeEnv();
    await setAgentBackend(env.DB, "agent_iso", "isolate");

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "session_str", title: "t" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent_iso", title: "t" }),
    });

    const row = await env.DB
      .prepare(`SELECT agent_id, backend FROM sessions WHERE session_id = ?`)
      .bind("session_str")
      .first<{ agent_id: string; backend: string }>();
    expect(row?.agent_id).toBe("agent_iso");
    expect(row?.backend).toBe("isolate");
  });

  // web_fetch and web_search execute server-side at Anthropic and bypass
  // our sandbox egress proxy entirely. Force-disabling them in every
  // /api/agents payload prevents users from accidentally punching a hole
  // through their egress policy.
  it("force-disables server-side tools on agent create", async () => {
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "test",
        model: "claude-sonnet-4-6",
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
          },
        ],
      }),
    });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ configs?: Array<{ name: string; enabled: boolean }> }>;
    };
    const configs = sent.tools[0].configs || [];
    const byName = Object.fromEntries(configs.map((c) => [c.name, c.enabled]));
    expect(byName.web_fetch).toBe(false);
    expect(byName.web_search).toBe(false);
  });

  // The Isolate Sandbox backend fix — the form sends the same
  // `agent_toolset_20260401` wrapper for both backends, but the toolset
  // itself resolves to MicroVM tool names (bash/glob/etc) on Anthropic's
  // side. For Isolate agents we rewrite the upstream payload to explicit
  // `type: "custom"` entries with their JSON schemas so the model's tool
  // catalog matches what the Isolate dispatcher actually serves.
  it("rewrites Isolate Sandbox agent payloads to use custom tools, not the MicroVM toolset", async () => {
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
        // Echo back a fake agent so persistBackendThenForward can read the id.
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "isolate-test",
        model: "claude-sonnet-4-6",
        backend: "isolate",
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
            // Disable two tools, leave the rest enabled — the rewrite
            // should drop the wrapper and emit custom tools for everything
            // except `delete` and `execute`.
            configs: [
              { name: "delete", enabled: false },
              { name: "execute", enabled: false },
            ],
          },
        ],
      }),
    });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ type: string; name?: string }>;
    };
    // No more MicroVM toolset entries — they're the bug.
    expect(sent.tools.find((t) => t.type === "agent_toolset_20260401")).toBeUndefined();
    // Custom tools instead, named for the Isolate catalog. Read / write /
    // edit / grep keep the `cf_` prefix because the unprefixed forms are
    // reserved by Anthropic's `agent_toolset_20260401` and would clash;
    // everything else (list / find / delete / execute / run_file / etc.)
    // ships unprefixed.
    const customNames = sent.tools.filter((t) => t.type === "custom").map((t) => t.name);
    expect(customNames).toContain("cf_read");
    expect(customNames).toContain("cf_write");
    expect(customNames).toContain("cf_edit");
    expect(customNames).toContain("cf_grep");
    // No reserved unprefixed names ever leak through.
    expect(customNames).not.toContain("read");
    expect(customNames).not.toContain("write");
    expect(customNames).not.toContain("edit");
    expect(customNames).not.toContain("grep");
    // The two we disabled should be absent.
    expect(customNames).not.toContain("delete");
    expect(customNames).not.toContain("execute");
  });

  it("registers all Isolate custom tools when the form sends default_config.enabled=false", async () => {
    // Regression for the "No MCPs or tools configured" bug.
    //
    // The frontend's Isolate save path emits the toolset wrapper with
    // `default_config.enabled: false` (its job is to keep Anthropic's
    // stock filesystem tools off; Isolate replaces them with its own
    // custom catalog). Earlier readEnabledIsolateTools mistook that
    // signal for "user wants nothing enabled" and shipped agents with
    // an empty tools array. Verify the fix: with no cf_*-prefixed
    // disables in `configs`, the full catalog comes through.
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "isolate-default-disabled",
        model: "claude-sonnet-4-6",
        backend: "isolate",
        tools: [
          {
            type: "agent_toolset_20260401",
            // Form shape for Isolate: wrapper default-disabled, configs
            // hold filesystem-tool disables (defensive belt-and-braces;
            // the wrapper itself is stripped server-side anyway) plus
            // server-side toggles. NO cf_*-prefixed entries here
            // — the user accepted defaults.
            default_config: { enabled: false, permission_policy: { type: "always_allow" } },
            configs: [
              { name: "bash", enabled: false },
              { name: "edit", enabled: false },
              { name: "read", enabled: false },
              { name: "write", enabled: false },
              { name: "glob", enabled: false },
              { name: "grep", enabled: false },
              { name: "web_fetch", enabled: false },
              { name: "web_search", enabled: false },
            ],
          },
        ],
      }),
    });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ type: string; name?: string }>;
    };
    const customNames = sent.tools.filter((t) => t.type === "custom").map((t) => t.name);
    // Sanity check: every core workspace tool is present, prefixed or
    // not as the registry says.
    expect(customNames).toContain("cf_read");
    expect(customNames).toContain("cf_write");
    expect(customNames).toContain("cf_edit");
    expect(customNames).toContain("list");
    expect(customNames).toContain("find");
    expect(customNames).toContain("cf_grep");
    expect(customNames).toContain("delete");
    // None of Anthropic's reserved unprefixed names leaked through.
    expect(customNames).not.toContain("read");
    expect(customNames).not.toContain("write");
    expect(customNames).not.toContain("edit");
    expect(customNames).not.toContain("grep");
  });

  it("respects per-tool disables when default_config.enabled=false", async () => {
    // Companion to the above: when the form unchecks a specific
    // Isolate tool it sends `{ name: "<tool>", enabled: false }`
    // alongside the filesystem-tool disables. The full catalog comes
    // through MINUS the explicitly disabled name(s).
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "isolate-partial-disable",
        model: "claude-sonnet-4-6",
        backend: "isolate",
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: false, permission_policy: { type: "always_allow" } },
            configs: [
              { name: "bash", enabled: false },
              { name: "delete", enabled: false },
              { name: "execute", enabled: false },
            ],
          },
        ],
      }),
    });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ type: string; name?: string }>;
    };
    const customNames = sent.tools.filter((t) => t.type === "custom").map((t) => t.name);
    expect(customNames).toContain("cf_read");
    expect(customNames).not.toContain("delete");
    expect(customNames).not.toContain("execute");
  });

  it("preserves the stock toolset for MicroVM agents with no custom tools picked", async () => {
    // A fresh MicroVM agent without any custom-tool selections keeps
    // the stock `agent_toolset_20260401` wrapper unchanged. No
    // `type: "custom"` entries get added and no legacy `mcp_toolset`
    // / `mcp_servers` entries leak through.
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "microvm-stock-only",
        model: "claude-sonnet-4-6",
        backend: "microvm",
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
          },
        ],
      }),
    });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ type: string; mcp_server_name?: string }>;
      mcp_servers?: Array<{ name: string }>;
    };
    expect(sent.tools.some((t) => t.type === "agent_toolset_20260401")).toBe(true);
    expect(sent.tools.some((t) => t.type === "custom")).toBe(false);
    expect(sent.tools.some((t) => t.type === "mcp_toolset")).toBe(false);
    expect(sent.mcp_servers ?? []).toEqual([]);
  });

  it("emits type:\"custom\" entries when the form selects Cloudflare-backed tools on MicroVM", async () => {
    // The form lists checked tool names alongside the stock tools in
    // the agent_toolset_20260401.configs array. The worker sifts the
    // custom names out, looks up each in the registry, and emits
    // a `type: "custom"` entry with the MicroVM-flavoured description
    // / schema. Stock names stay in the toolset for the SDK's in-
    // container dispatcher to answer.
    const env = makeEnv({
      // CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID gate Browser
      // Rendering; without them cf_web_fetch / screenshot would
      // drop out of the catalog and the test below would fail.
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "test-account",
    });
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "microvm-with-customs",
        model: "claude-sonnet-4-6",
        backend: "microvm",
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
            // Form serialises the user's picks here. Stock names stay
            // in this list; the Cloudflare-side names get hoisted out
            // into type:"custom" entries by the worker.
            configs: [
              { name: "cf_web_fetch", enabled: true },
              { name: "screenshot", enabled: true },
            ],
          },
        ],
      }),
    });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ type: string; name?: string; configs?: Array<{ name: string }> }>;
      mcp_servers?: Array<{ name: string }>;
    };
    const customNames = sent.tools.filter((t) => t.type === "custom").map((t) => t.name);
    expect(customNames).toContain("cf_web_fetch");
    expect(customNames).toContain("screenshot");
    // Stock toolset still around, with the Cloudflare-side names removed.
    const wrapper = sent.tools.find((t) => t.type === "agent_toolset_20260401");
    const wrapperNames = (wrapper?.configs ?? []).map((c) => c.name);
    expect(wrapperNames).not.toContain("cf_web_fetch");
    expect(wrapperNames).not.toContain("screenshot");
    // No legacy MCP plumbing on the wire.
    expect(sent.tools.some((t) => t.type === "mcp_toolset")).toBe(false);
    expect(sent.mcp_servers ?? []).toEqual([]);
  });

  it("does not emit unrelated type:\"custom\" entries for Isolate agents that selected the stock toolset wrapper", async () => {
    // Isolate agents register tools via the dispatcher in the DO,
    // which reads names from `agent_toolset_20260401.configs`. Without
    // any explicit picks the worker still surfaces the full default
    // isolate catalog. This test pins down "no leak of MicroVM-shape
    // entries" — every emitted `type: "custom"` belongs to the Isolate
    // catalog (a registered name from `ISOLATE_TOOL_NAMES`).
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "isolate-no-mcp",
        model: "claude-sonnet-4-6",
        backend: "isolate",
        tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true } }],
      }),
    });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ type: string; name?: string }>;
      mcp_servers?: Array<{ name: string }>;
    };
    expect(sent.tools.some((t) => t.type === "mcp_toolset")).toBe(false);
    expect(sent.mcp_servers ?? []).toEqual([]);
    const customNames = sent.tools.filter((t) => t.type === "custom").map((t) => t.name);
    for (const name of customNames) {
      expect(ISOLATE_TOOL_NAMES.has(name ?? "")).toBe(true);
    }
  });

  it("preserves explicit server-side tool enables on agent update — opt-in is the user's choice", async () => {
    // When a caller explicitly sets `enabled: true` for web_fetch /
    // web_search the worker no longer rewrites it. The agent form
    // surfaces a warning callout before checking these boxes; the
    // worker trusts whatever the form sends. If the caller doesn't
    // mention them at all, the worker safe-defaults them off — that's
    // the next test.
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/agents/agent_xyz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
            configs: [
              { name: "web_fetch", enabled: true },
              { name: "web_search", enabled: true },
            ],
          },
        ],
      }),
    });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ configs?: Array<{ name: string; enabled: boolean }> }>;
    };
    const configs = sent.tools[0].configs || [];
    const byName = Object.fromEntries(configs.map((c) => [c.name, c.enabled]));
    expect(byName.web_fetch).toBe(true);
    expect(byName.web_search).toBe(true);
  });

  it("persists the agent's backend in agent_backends on create", async () => {
    // Regression test: an Isolate selection in the dashboard must land
    // in the agent_backends D1 table. Without it, resolveBackend()
    // would default to "microvm" on the next webhook and the model
    // would hit the MicroVM dispatcher (no workspace tools registered)
    // — the symptom that produced the `cf_write not found` error.
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      // Upstream returns the canonical agent shape. The handler reads
      // the id off this body to write the backend mapping.
      return new Response(
        JSON.stringify({ id: "agent_iso_abc123", name: "iso", tools: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "iso-test",
        model: "claude-sonnet-4-6",
        backend: "isolate",
        tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true } }],
      }),
    });
    expect(res.status).toBe(200);

    // Confirm the agent_backends row landed with "isolate". Reads the
    // value back via the public endpoint so we exercise the same path
    // resolveBackend() does.
    const lookup = await call(env, "/api/agents/agent_iso_abc123/backend");
    expect(lookup.status).toBe(200);
    const body = await json<{ agentId: string; backend: string }>(lookup);
    expect(body).toEqual({ agentId: "agent_iso_abc123", backend: "isolate" });
  });

  it("returns 500 when the upstream agent is created but backend persistence fails", async () => {
    // If the upstream call succeeds but we can't tag the agent with its
    // backend, dispatch will default to MicroVM on the next webhook —
    // exactly the trap that caused `cf_write not found` for an
    // "Isolate" selection. Make the failure loud so the frontend can
    // tell the operator instead of silently shipping a misconfigured
    // agent.
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      // Upstream is OK but returns no id — persistBackendFromResponse
      // can't write the row.
      return new Response(JSON.stringify({ name: "no-id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await call(env, "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "iso-test",
        model: "claude-sonnet-4-6",
        backend: "isolate",
        tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true } }],
      }),
    });
    expect(res.status).toBe(500);
    const body = await json<{ error: string; message: string }>(res);
    expect(body.error).toBe("agent_persist_failed");
    expect(body.message).toMatch(/PUT \/api\/agents/);
  });

  it("safe-defaults server-side tools off when caller doesn't mention them", async () => {
    // Stale clients that don't yet know about web_fetch / web_search
    // would never send a config entry for them; the toolset's
    // default_config.enabled = true would silently turn them on. The
    // worker appends explicit `enabled: false` entries when neither
    // side has spoken so a stale client can't quietly punch a hole
    // through the egress policy.
    const env = makeEnv();
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(String(init?.body ?? ""), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await call(env, "/api/agents/agent_xyz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: true },
            // No mention of web_fetch / web_search at all.
            configs: [{ name: "bash", enabled: true }],
          },
        ],
      }),
    });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "")) as {
      tools: Array<{ configs?: Array<{ name: string; enabled: boolean }> }>;
    };
    const configs = sent.tools[0].configs || [];
    const byName = Object.fromEntries(configs.map((c) => [c.name, c.enabled]));
    expect(byName.web_fetch).toBe(false);
    expect(byName.web_search).toBe(false);
    // Untouched user-supplied configs survive the safe-default pass.
    expect(byName.bash).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

describe("404", () => {
  it("returns 404 for unknown /api/* paths", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/does-not-exist");
    expect(res.status).toBe(404);
  });
});
