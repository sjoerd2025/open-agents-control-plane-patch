// Egress proxy unit tests. We intentionally avoid spinning up the full
// Sandbox/Container runtime — these tests exercise the pure policy
// enforcement code (`applyEgressPolicy`, `compilePolicy`) so the logic stays
// fast to test and easy to reason about.
//
// Anything that requires the actual Sandbox SDK (interception, dispatch,
// container lifecycle) is covered by integration tests against a live
// deployment. We don't have a working Anthropic API in this environment, so
// those are tracked separately and not run from this file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEgressPolicy, compilePolicy } from "../src/egress/handler";
import {
  findPolicyForSession,
  matchesAnyHost,
  matchesHost,
} from "../src/egress/match";
import type { CompiledPolicy, EgressPolicy } from "../src/egress/types";

// --------------------------------------------------------------------------
// Fakes
// --------------------------------------------------------------------------

type FakeFetch = ReturnType<
  typeof vi.fn<[Request | string, RequestInit?], Promise<Response>>
>;

function installFakeFetch(): FakeFetch {
  const fake = vi.fn<[Request | string, RequestInit?], Promise<Response>>(
    async (input) => {
      const url = typeof input === "string" ? input : input.url;
      return new Response(JSON.stringify({ ok: true, fetched: url }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  // Replace the global fetch so applyEgressPolicy() and rewriting code paths
  // observe our fake.
  vi.stubGlobal("fetch", fake);
  return fake;
}

interface FakeWorker {
  fetchImpl: (req: Request) => Promise<Response>;
}

function fakeWorkerLoader(impls: Record<string, FakeWorker>) {
  const calls: Array<{ id: string }> = [];
  return {
    calls,
    loader: {
      get(id: string, _cb: () => Promise<unknown>) {
        calls.push({ id });
        const worker = impls[id];
        if (!worker) {
          throw new Error(`unexpected loader id: ${id}`);
        }
        return {
          getEntrypoint() {
            return { fetch: worker.fetchImpl };
          },
        };
      },
    },
  };
}

const baseRequest = (url: string, init?: RequestInit) => new Request(url, init);

const policyTemplate = (
  overrides: Partial<CompiledPolicy> = {},
): CompiledPolicy => ({
  policyId: "pol_test",
  policyName: "test",
  allow: [],
  deny: [],
  headerInjections: [],
  proxy: null,
  vpcRoutes: [],
  ...overrides,
});

// --------------------------------------------------------------------------
// matchesHost / matchesAnyHost
// --------------------------------------------------------------------------

describe("matchesHost", () => {
  it("matches exact hostnames case-insensitively", () => {
    expect(matchesHost("api.example.com", "api.example.com")).toBe(true);
    expect(matchesHost("API.example.com", "api.example.com")).toBe(true);
    expect(matchesHost("api.example.com", "API.EXAMPLE.com")).toBe(true);
  });

  it("matches wildcard subdomains but not the bare domain", () => {
    expect(matchesHost("*.example.com", "foo.example.com")).toBe(true);
    expect(matchesHost("*.example.com", "deep.nested.example.com")).toBe(true);
    expect(matchesHost("*.example.com", "example.com")).toBe(false);
    expect(matchesHost("*.example.com", "evilexample.com")).toBe(false);
  });

  it("rejects unrelated hosts", () => {
    expect(matchesHost("api.example.com", "api.evil.com")).toBe(false);
    expect(matchesHost("", "api.example.com")).toBe(false);
  });
});

describe("matchesAnyHost", () => {
  it("splits comma-separated entries and matches any", () => {
    expect(
      matchesAnyHost(
        "api.example.com, *.cdn.example.com",
        "img.cdn.example.com",
      ),
    ).toBe(true);
    expect(matchesAnyHost("api.example.com,foo.com", "foo.com")).toBe(true);
    expect(matchesAnyHost("api.example.com", "evil.com")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// findPolicyForSession
// --------------------------------------------------------------------------

describe("findPolicyForSession", () => {
  const dynamic: EgressPolicy = {
    id: "pol_dynamic",
    name: "dynamic",
    egressRules: [],
    applyTo: [{ field: "title", operator: "contains", value: "prod" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const all: EgressPolicy = {
    id: "pol_all",
    name: "catch-all",
    egressRules: [],
    applyTo: [],
    appliesToAll: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("matches a session whose field satisfies an applyTo matcher", () => {
    const found = findPolicyForSession([dynamic], "session_other", {
      title: "prod-runner-1",
    });
    expect(found).toBe(dynamic);
  });

  it("matches by the `id` field via an applyTo matcher", () => {
    const explicit: EgressPolicy = {
      id: "pol_explicit",
      name: "explicit",
      egressRules: [],
      applyTo: [{ field: "id", operator: "equals", value: "session_alpha" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([explicit], "session_alpha", {
        id: "session_alpha",
      }),
    ).toBe(explicit);
  });

  it("falls back to an appliesToAll policy when nothing else matches", () => {
    expect(
      findPolicyForSession([dynamic, all], "session_other", { title: "dev" }),
    ).toBe(all);
  });

  it("prefers a specific applyTo match over an appliesToAll fallback", () => {
    expect(
      findPolicyForSession([all, dynamic], "session_other", {
        title: "prod-runner-1",
      }),
    ).toBe(dynamic);
  });

  it("returns null when no policy applies", () => {
    const found = findPolicyForSession([dynamic], "session_other", {
      title: "dev",
    });
    expect(found).toBeNull();
  });

  it("supports the is-one-of operator with multiple values", () => {
    const policy: EgressPolicy = {
      ...dynamic,
      id: "pol_oneof",
      applyTo: [
        { field: "title", operator: "is-one-of", values: ["staging", "prod"] },
      ],
    };
    expect(findPolicyForSession([policy], "session_x", { title: "prod" })).toBe(
      policy,
    );
    expect(
      findPolicyForSession([policy], "session_x", { title: "dev" }),
    ).toBeNull();
  });

  // ------------------------------------------------------------------------
  // Cross-agent isolation guarantees. The frontend's "Apply to agent…" picker
  // writes `{field: "agent_id", operator: "equals", value: <id>}` matchers
  // (see frontend/src/views/EgressView.tsx:420), so the most common policy
  // shape is a per-agent equals match. None of these should leak across to a
  // sibling agent — even one whose id is a prefix/substring of the target.
  // ------------------------------------------------------------------------

  it("equals-on-agent_id never matches a sibling agent", () => {
    const policy: EgressPolicy = {
      id: "pol_per_agent",
      name: "per-agent",
      egressRules: [],
      applyTo: [
        { field: "agent_id", operator: "equals", value: "agent_alpha" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([policy], "sess_a", { agent_id: "agent_alpha" }),
    ).toBe(policy);
    // Prefix collision — agent_alpha2's id contains "agent_alpha" but isn't
    // equal to it. Must not pick up agent_alpha's policy.
    expect(
      findPolicyForSession([policy], "sess_b", { agent_id: "agent_alpha2" }),
    ).toBeNull();
    // Sibling id with no overlap.
    expect(
      findPolicyForSession([policy], "sess_c", { agent_id: "agent_beta" }),
    ).toBeNull();
    // Session that never resolved an agent yet — no agent_id key at all.
    expect(findPolicyForSession([policy], "sess_d", {})).toBeNull();
  });

  // ------------------------------------------------------------------------
  // False-positive guards. A matcher with no value can't usefully test
  // anything: `contains ""` and `matches ""` are true for every string, and
  // `equals ""` silently matches sessions where the field is missing. The
  // policy editor ships blank matchers as the default
  // (frontend/src/views/EgressView.tsx:91) so this is a real shape that
  // hits the wire when an operator forgets to fill the row out before
  // saving.
  // ------------------------------------------------------------------------

  it("rejects matchers whose value is empty (no field can be matched)", () => {
    const blank: EgressPolicy = {
      id: "pol_blank",
      name: "blank matcher",
      egressRules: [],
      applyTo: [{ field: "agent_id", operator: "equals", value: "" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([blank], "sess_a", { agent_id: "agent_alpha" }),
    ).toBeNull();
    expect(findPolicyForSession([blank], "sess_b", {})).toBeNull();
  });

  it("rejects empty `contains` matchers instead of matching every session", () => {
    const policy: EgressPolicy = {
      id: "pol_contains_blank",
      name: "blank contains",
      egressRules: [],
      applyTo: [{ field: "agent_id", operator: "contains", value: "" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([policy], "sess_a", { agent_id: "agent_alpha" }),
    ).toBeNull();
    expect(
      findPolicyForSession([policy], "sess_b", { agent_id: "agent_beta" }),
    ).toBeNull();
  });

  it("rejects empty `matches` matchers (empty regex matches every string)", () => {
    const policy: EgressPolicy = {
      id: "pol_regex_blank",
      name: "blank regex",
      egressRules: [],
      applyTo: [{ field: "agent_id", operator: "matches", value: "" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([policy], "sess_a", { agent_id: "agent_alpha" }),
    ).toBeNull();
  });

  it("rejects matchers whose field is empty", () => {
    const policy: EgressPolicy = {
      id: "pol_blank_field",
      name: "blank field",
      egressRules: [],
      applyTo: [{ field: "", operator: "equals", value: "agent_alpha" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([policy], "sess_a", { agent_id: "agent_alpha" }),
    ).toBeNull();
  });

  it("rejects is-one-of matchers with an empty values array", () => {
    const policy: EgressPolicy = {
      id: "pol_oneof_blank",
      name: "blank values",
      egressRules: [],
      applyTo: [{ field: "agent_id", operator: "is-one-of", values: [] }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([policy], "sess_a", { agent_id: "agent_alpha" }),
    ).toBeNull();
  });

  // ------------------------------------------------------------------------
  // Threading additional metadata. resolveSessionPolicy() composes the
  // `fields` object that matchers see (src/egress/resolve.ts). Anything you
  // add to that object becomes a matchable field — including nested objects
  // reached via dot-paths like `metadata.org_id`. These tests pin the
  // contract for callers extending the field set.
  // ------------------------------------------------------------------------

  it("matches on webhook-payload fields like organization_id and workspace_id", () => {
    const policy: EgressPolicy = {
      id: "pol_org",
      name: "per-org",
      egressRules: [],
      applyTo: [
        { field: "organization_id", operator: "equals", value: "org_acme" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([policy], "sess_a", {
        agent_id: "agent_alpha",
        organization_id: "org_acme",
        workspace_id: "ws_1",
      }),
    ).toBe(policy);
    expect(
      findPolicyForSession([policy], "sess_b", {
        agent_id: "agent_alpha",
        organization_id: "org_other",
      }),
    ).toBeNull();
  });

  it("matches on nested fields via dot-path (metadata.org_id)", () => {
    const policy: EgressPolicy = {
      id: "pol_nested",
      name: "nested metadata",
      egressRules: [],
      applyTo: [
        { field: "metadata.org_id", operator: "equals", value: "org_acme" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([policy], "sess_a", {
        metadata: { org_id: "org_acme", region: "us-east-1" },
      }),
    ).toBe(policy);
    expect(
      findPolicyForSession([policy], "sess_b", {
        metadata: { org_id: "org_other" },
      }),
    ).toBeNull();
    // Missing nested object doesn't crash and doesn't false-positive.
    expect(findPolicyForSession([policy], "sess_c", {})).toBeNull();
  });

  it("treats multi-matcher applyTo as AND (every matcher must satisfy)", () => {
    const policy: EgressPolicy = {
      id: "pol_and",
      name: "agent + org",
      egressRules: [],
      applyTo: [
        { field: "agent_id", operator: "equals", value: "agent_alpha" },
        { field: "organization_id", operator: "equals", value: "org_acme" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(
      findPolicyForSession([policy], "sess_a", {
        agent_id: "agent_alpha",
        organization_id: "org_acme",
      }),
    ).toBe(policy);
    // Right agent, wrong org → no match (without AND semantics this would
    // be a cross-tenant leak).
    expect(
      findPolicyForSession([policy], "sess_b", {
        agent_id: "agent_alpha",
        organization_id: "org_other",
      }),
    ).toBeNull();
  });
});

// --------------------------------------------------------------------------
// compilePolicy
// --------------------------------------------------------------------------

describe("compilePolicy", () => {
  it("collects allow/deny hosts and resolves header secrets", async () => {
    const policy: EgressPolicy = {
      id: "pol_compile",
      name: "compile",
      egressRules: [
        { type: "allow", host: "api.example.com" },
        { type: "deny", host: "evil.com" },
        {
          type: "header-injection",
          target: "api.example.com",
          header: "x-auth",
          secretName: "TOKEN",
        },
      ],
      sessionIds: [],
      applyTo: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const compiled = await compilePolicy(policy, async (name) =>
      name === "TOKEN" ? "secret-value" : null,
    );
    expect(compiled.allow).toEqual(["api.example.com"]);
    expect(compiled.deny).toEqual(["evil.com"]);
    expect(compiled.headerInjections).toEqual([
      {
        target: "api.example.com",
        header: "x-auth",
        secretValue: "secret-value",
      },
    ]);
    expect(compiled.proxy).toBeNull();
    expect(compiled.policyId).toBe("pol_compile");
  });

  it("skips header injections whose secret is missing", async () => {
    const policy: EgressPolicy = {
      id: "pol_skip",
      name: "skip",
      egressRules: [
        {
          type: "header-injection",
          target: "api.example.com",
          header: "x-auth",
          secretName: "MISSING",
        },
      ],
      sessionIds: [],
      applyTo: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const compiled = await compilePolicy(policy, async () => null);
    expect(compiled.headerInjections).toHaveLength(0);
  });

  it("captures proxy code and exposes secrets via env-style names", async () => {
    const policy: EgressPolicy = {
      id: "pol_proxy",
      name: "proxy",
      egressRules: [
        {
          type: "header-injection",
          target: "*",
          header: "x-api-key",
          secretName: "OPENAI",
        },
        {
          type: "proxy",
          code: "export default { fetch(req) { return fetch(req); } };",
        },
      ],
      sessionIds: [],
      applyTo: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const compiled = await compilePolicy(policy, async () => "sk-test");
    expect(compiled.proxy).not.toBeNull();
    expect(compiled.proxy?.policyId).toBe("pol_proxy");
    expect(compiled.proxy?.code).toContain("export default");
    expect(compiled.proxy?.secrets).toEqual({ X_API_KEY: "sk-test" });
  });
});

// --------------------------------------------------------------------------
// applyEgressPolicy
// --------------------------------------------------------------------------

describe("applyEgressPolicy", () => {
  let fakeFetch: FakeFetch;

  beforeEach(() => {
    fakeFetch = installFakeFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls through to fetch when no policy is attached", async () => {
    const res = await applyEgressPolicy(
      baseRequest("https://api.example.com/v1/me"),
      {},
      undefined,
    );
    expect(res.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("denies hosts on the deny list", async () => {
    const policy = policyTemplate({
      deny: ["*.evil.com", "blocked.example.com"],
    });
    const res = await applyEgressPolicy(
      baseRequest("https://api.evil.com/things"),
      {},
      { policy },
    );
    expect(res.status).toBe(403);
    expect(fakeFetch).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("egress denied");
    expect(body.reason).toMatch(/deny rule/);
  });

  it("denies hosts not in the allow list when one is set", async () => {
    const policy = policyTemplate({ allow: ["api.example.com"] });
    const res = await applyEgressPolicy(
      baseRequest("https://other.example.org/v1/x"),
      {},
      { policy },
    );
    expect(res.status).toBe(403);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  // Regression: without this bypass, an allow-list policy that omits
  // api.anthropic.com causes the control plane's tool-result POSTs to 403 and
  // tool calls (write/read/bash/…) sit as "running" forever in the
  // dashboard.
  it("always allows Anthropic control-plane traffic even when the allow list omits it", async () => {
    const policy = policyTemplate({ allow: ["api.example.com"] });
    const res = await applyEgressPolicy(
      baseRequest("https://api.anthropic.com/v1/sessions/sess_x/events"),
      {},
      { policy },
    );
    expect(res.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("respects an ANTHROPIC_BASE_URL override when bypassing for the control plane", async () => {
    const policy = policyTemplate({
      allow: ["api.example.com"],
      deny: ["anthropic.staging.example.net"],
    });
    const res = await applyEgressPolicy(
      baseRequest(
        "https://anthropic.staging.example.net/v1/sessions/sess_x/events",
      ),
      { ANTHROPIC_BASE_URL: "https://anthropic.staging.example.net" },
      { policy },
    );
    expect(res.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("does not bypass for hosts that merely look like Anthropic", async () => {
    const policy = policyTemplate({ allow: ["api.example.com"] });
    const res = await applyEgressPolicy(
      baseRequest("https://api.anthropic.com.evil.test/v1/events"),
      {},
      { policy },
    );
    expect(res.status).toBe(403);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("allows hosts that match the allow list", async () => {
    const policy = policyTemplate({
      allow: ["api.example.com", "*.cdn.example.com"],
    });
    const res1 = await applyEgressPolicy(
      baseRequest("https://api.example.com/me"),
      {},
      { policy },
    );
    expect(res1.status).toBe(200);
    const res2 = await applyEgressPolicy(
      baseRequest("https://img.cdn.example.com/file.png"),
      {},
      { policy },
    );
    expect(res2.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("deny wins over allow when a host is on both lists", async () => {
    const policy = policyTemplate({
      allow: ["api.example.com"],
      deny: ["api.example.com"],
    });
    const res = await applyEgressPolicy(
      baseRequest("https://api.example.com/me"),
      {},
      { policy },
    );
    expect(res.status).toBe(403);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("injects headers for matching target hosts only", async () => {
    const policy = policyTemplate({
      headerInjections: [
        {
          target: "api.example.com",
          header: "x-auth-token",
          secretValue: "sk-secret-1",
        },
      ],
    });

    await applyEgressPolicy(
      baseRequest("https://api.example.com/v1/me"),
      {},
      { policy },
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const sent = fakeFetch.mock.calls[0][0] as Request;
    expect(sent.headers.get("x-auth-token")).toBe("sk-secret-1");

    fakeFetch.mockClear();
    await applyEgressPolicy(
      baseRequest("https://other.example.com/v1/me"),
      {},
      { policy },
    );
    const otherSent = fakeFetch.mock.calls[0][0] as Request;
    expect(otherSent.headers.get("x-auth-token")).toBeNull();
  });

  it("strips Cloudflare-internal headers from forwarded requests", async () => {
    const policy = policyTemplate();
    await applyEgressPolicy(
      baseRequest("https://api.example.com/me", {
        headers: { "cf-ray": "abc", host: "fakehost", "x-keep": "yes" },
      }),
      {},
      { policy },
    );
    const sent = fakeFetch.mock.calls[0][0] as Request;
    expect(sent.headers.get("cf-ray")).toBeNull();
    expect(sent.headers.get("host")).toBeNull();
    expect(sent.headers.get("x-keep")).toBe("yes");
  });

  it("routes requests through a Dynamic Worker when a proxy rule is set", async () => {
    const policy = policyTemplate({
      proxy: {
        policyId: "pol_proxy",
        code: "export default { async fetch(r) { return new Response('forwarded'); } };",
        secrets: { TOKEN: "sk-test" },
      },
    });

    const proxyResponses: Request[] = [];
    const { calls, loader } = fakeWorkerLoader({
      proxy_pol_proxy: {
        async fetchImpl(req) {
          proxyResponses.push(req);
          return new Response("from-proxy", { status: 200 });
        },
      },
    });

    const res = await applyEgressPolicy(
      baseRequest("https://api.example.com/me"),
      { PROXY_LOADER: loader },
      { policy },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-proxy");
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("proxy_pol_proxy");
    expect(proxyResponses).toHaveLength(1);
  });

  it("returns 500 when the proxy is configured but no PROXY_LOADER binding is present", async () => {
    const policy = policyTemplate({
      proxy: { policyId: "pol_proxy", code: "export default {};", secrets: {} },
    });
    const res = await applyEgressPolicy(
      baseRequest("https://api.example.com/me"),
      {},
      { policy },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/egress proxy unavailable/);
  });

  it("returns 502 when the dynamic proxy throws", async () => {
    const policy = policyTemplate({
      proxy: {
        policyId: "pol_throws",
        code: "export default {};",
        secrets: {},
      },
    });
    const { loader } = fakeWorkerLoader({
      proxy_pol_throws: {
        async fetchImpl() {
          throw new Error("kaboom");
        },
      },
    });
    const res = await applyEgressPolicy(
      baseRequest("https://api.example.com/me"),
      { PROXY_LOADER: loader },
      { policy },
    );
    expect(res.status).toBe(502);
  });
});

// --------------------------------------------------------------------------
// VPC + Mesh
// --------------------------------------------------------------------------
// vpc-service rules dispatch the rewritten request through env[binding].fetch
// instead of going through global fetch.

describe("vpc-service routing", () => {
  let fakeFetch: FakeFetch;
  beforeEach(() => {
    fakeFetch = installFakeFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes matching hosts through the configured binding", async () => {
    const seen: Request[] = [];
    const fakeBinding = {
      async fetch(req: Request) {
        seen.push(req);
        return new Response("from-vpc", { status: 200 });
      },
    };
    const policy = policyTemplate({
      vpcRoutes: [{ host: "*.internal", binding: "INTERNAL_API" }],
    });

    const res = await applyEgressPolicy(
      baseRequest("https://vcs.internal/info"),
      { INTERNAL_API: fakeBinding },
      { policy },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-vpc");
    expect(seen).toHaveLength(1);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("falls through to fetch() for hosts that don't match any vpc-service rule", async () => {
    const fakeBinding = { fetch: vi.fn() };
    const policy = policyTemplate({
      vpcRoutes: [{ host: "*.internal", binding: "INTERNAL_API" }],
    });

    const res = await applyEgressPolicy(
      baseRequest("https://api.example.com/x"),
      { INTERNAL_API: fakeBinding },
      { policy },
    );
    expect(res.status).toBe(200);
    expect(fakeBinding.fetch).not.toHaveBeenCalled();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the binding is not present in env", async () => {
    const policy = policyTemplate({
      vpcRoutes: [{ host: "*.internal", binding: "MISSING" }],
    });
    const res = await applyEgressPolicy(
      baseRequest("https://svc.internal/x"),
      {},
      { policy },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/vpc binding unavailable/);
  });

  it("compiles vpc-service rules into vpcRoutes", async () => {
    const compiled = await compilePolicy(
      {
        id: "pol_vpc",
        name: "vpc",
        egressRules: [
          {
            type: "vpc-service",
            binding: "INTERNAL_API",
            hostname: "*.internal",
          },
          { type: "vpc-service", binding: "", hostname: "skipped.internal" }, // dropped
        ],
        sessionIds: [],
        applyTo: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      async () => null,
    );
    expect(compiled.vpcRoutes).toEqual([
      { host: "*.internal", binding: "INTERNAL_API" },
    ]);
  });
});

// --------------------------------------------------------------------------
// resolveSessionPolicy — the shared helper that both Sandbox.dispatch() and
// IsolateRunner.start() use to look up + compile the policy that applies to a
// session. Wraps listPolicies / getSessionData / findPolicyForSession /
// compilePolicy with a try/catch so dispatch never fails on KV/D1 hiccups.
// --------------------------------------------------------------------------

describe("resolveSessionPolicy", () => {
  beforeEach(async () => {
    // resolveSessionPolicy goes through the storage helper getSessionData,
    // so we need a working D1 fake. Re-using the API test helpers keeps the
    // schema in lockstep.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null when no policies exist", async () => {
    const { resolveSessionPolicy } = await import("../src/egress/resolve");
    const { makeEnv } = await import("./helpers");
    const env = makeEnv();
    const compiled = await resolveSessionPolicy(
      env as unknown as Env,
      "session_alpha",
    );
    expect(compiled).toBeNull();
  });

  it("returns null when policies exist but none match", async () => {
    const { resolveSessionPolicy } = await import("../src/egress/resolve");
    const { savePolicy } = await import("../src/egress/store");
    const { makeEnv } = await import("./helpers");
    const env = makeEnv();
    await savePolicy(env as unknown as Env, {
      id: "pol_other",
      name: "applies to nothing",
      egressRules: [],
      applyTo: [{ field: "id", operator: "equals", value: "session_zzz" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const compiled = await resolveSessionPolicy(
      env as unknown as Env,
      "session_alpha",
    );
    expect(compiled).toBeNull();
  });

  it("compiles the matched policy with secrets resolved from the SECRETS KV", async () => {
    const { resolveSessionPolicy } = await import("../src/egress/resolve");
    const { savePolicy } = await import("../src/egress/store");
    const { makeEnv } = await import("./helpers");
    const env = makeEnv();
    await env.SECRETS.put("secret:GH_TOKEN", "abc123");
    await savePolicy(env as unknown as Env, {
      id: "pol_match",
      name: "global",
      egressRules: [
        { type: "allow", host: "api.github.com" },
        {
          type: "header-injection",
          target: "api.github.com",
          header: "Authorization",
          secretName: "GH_TOKEN",
        },
      ],
      applyTo: [],
      appliesToAll: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const compiled = await resolveSessionPolicy(
      env as unknown as Env,
      "session_alpha",
    );
    expect(compiled).not.toBeNull();
    expect(compiled?.policyId).toBe("pol_match");
    expect(compiled?.allow).toEqual(["api.github.com"]);
    expect(compiled?.headerInjections).toEqual([
      {
        target: "api.github.com",
        header: "Authorization",
        secretValue: "abc123",
      },
    ]);
  });

  it("swallows storage errors and returns null so dispatch keeps working", async () => {
    const { resolveSessionPolicy } = await import("../src/egress/resolve");
    const { makeEnv } = await import("./helpers");
    const env = makeEnv();
    // Replace the EGRESS_POLICIES list() with one that throws — simulates a
    // transient KV failure during a webhook drain.
    const broken = {
      ...env.EGRESS_POLICIES,
      list: async () => {
        throw new Error("KV unavailable");
      },
    };
    const compiled = await resolveSessionPolicy(
      { ...env, EGRESS_POLICIES: broken } as unknown as Env,
      "session_alpha",
    );
    expect(compiled).toBeNull();
  });

  // End-to-end check that the matcher's `fields` blob is composed the way
  // src/egress/resolve.ts documents — sessionId as `id`, the webhook
  // payload's `data.*` keys spread on top, plus the cached `agent_id` from
  // the sessions row. This test exists so future contributors threading
  // *additional* fields through (e.g. `backend`, `vpc_bindings`,
  // `metadata.region`) have a working pattern to copy.
  it("threads webhook payload + cached agent_id through to the matcher", async () => {
    const { resolveSessionPolicy } = await import("../src/egress/resolve");
    const { savePolicy } = await import("../src/egress/store");
    const { upsertSession, recordSessionAgent } = await import(
      "../src/storage"
    );
    const { makeEnv } = await import("./helpers");
    const env = makeEnv();

    // Persist a session row whose `last_data_json` carries the webhook
    // payload fields the matcher will key on.
    await upsertSession(env.DB, "sess_acme", "session.message.created", {
      id: "sess_acme",
      organization_id: "org_acme",
      workspace_id: "ws_prod",
    });
    await recordSessionAgent(env.DB, "sess_acme", "agent_alpha", "isolate");

    // Two policies: one keyed on org+agent (must win), one keyed on a
    // different agent (must NOT match the acme session).
    await savePolicy(env as unknown as Env, {
      id: "pol_acme",
      name: "acme + alpha",
      egressRules: [{ type: "allow", host: "api.acme.example" }],
      applyTo: [
        { field: "organization_id", operator: "equals", value: "org_acme" },
        { field: "agent_id", operator: "equals", value: "agent_alpha" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    await savePolicy(env as unknown as Env, {
      id: "pol_beta",
      name: "different agent",
      egressRules: [{ type: "allow", host: "api.beta.example" }],
      applyTo: [
        { field: "agent_id", operator: "equals", value: "agent_beta" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const compiled = await resolveSessionPolicy(
      env as unknown as Env,
      "sess_acme",
    );
    expect(compiled?.policyId).toBe("pol_acme");
    expect(compiled?.allow).toEqual(["api.acme.example"]);
  });

  it("never picks up another agent's policy", async () => {
    const { resolveSessionPolicy } = await import("../src/egress/resolve");
    const { savePolicy } = await import("../src/egress/store");
    const { recordSessionAgent } = await import("../src/storage");
    const { makeEnv } = await import("./helpers");
    const env = makeEnv();

    // Session belongs to agent_alpha…
    await recordSessionAgent(env.DB, "sess_alpha", "agent_alpha", "isolate");
    // …but the only policy in KV targets agent_beta.
    await savePolicy(env as unknown as Env, {
      id: "pol_beta_only",
      name: "beta only",
      egressRules: [{ type: "deny", host: "*" }],
      applyTo: [
        { field: "agent_id", operator: "equals", value: "agent_beta" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const compiled = await resolveSessionPolicy(
      env as unknown as Env,
      "sess_alpha",
    );
    expect(compiled).toBeNull();
  });
});
