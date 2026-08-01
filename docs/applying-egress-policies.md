# Applying Egress Policies

An **egress policy** controls outbound requests from an agent's sandbox.

Policies attach to a session before the agent starts, so there's no 
window where an unconstrained sandbox can reach an unintended endpoint.

## What policies can do

A policy is a list of rules evaluated on every outbound request.
Rules fall into five types:

### Allow and Deny Lists

You can choose which hosts a sandbox can access. For instance, you
might know that an agent should only speak to github.com and npmjs.org
to run a `git clone` and an `npm install`, any other external requests
would be incorrect behavior. You can easily allow those two destinations
and allow all other sites.

Or you may be worried about an agent being used for cryptomining via
a prompt-injection attack. You can deny known crypto pools, while
allowing all other sites.

If you set an allow list, other destinations are blocked by default.
If you set a deny list, public access is allowed by default.

You can use globs to match multiple destinations.

### Secret Injection

You can add headers to outbound requests targeting specific hosts.

Set a secret in the "Secrets" panel, this will store the secret in Workers KV
which is encrypted at rest and in transit. Then once a request leaves the
agent's sandbox, it is intercepted and the secret can be applied to a specific
header.

This allows you to access private sites while never exposing sensitive material
to the agent itself.

### Private Service Connections

You can connect to services that are not exposed to the public internet via
Workers VPC and Workers Mesh. This allows your sandboxes to access services
in any cloud or on-prem datacenter over a private network.

See [Connecting to Private Services](./connecting-to-private-services.md) for
details.

### Custom proxies

You can run a small piece of custom code on each request to do whatever you want.

This can be used to route differently per-tenant, add observability to calls,
read and/or modify the request body, block endpoints based on advanced criteria,
call the other Cloudflare Workers services, or do advanced policy checks.

## How it fits together

Both MicroVM and Isolate based sandboxes have an outbound Worker proxy
injected that controls egress.

```
Sandbox → fetch(req) → applyEgressPolicy(req, env, params)
                          ├── deny match?            → 403
                          ├── allow list non-empty?  → host must match
                          ├── header-injection match → set header
                          ├── vpc-service match      → env[binding].fetch(req)
                          ├── proxy fn configured?   → Dynamic Worker.fetch(req)
                          └── otherwise              → fetch(req)
```

The order of these checks matters. A deny rule overrides any matching
allow rule. If the allow list is non-empty, every request must match
one of its entries. Header injection runs before VPC routing, so an
injected header is in place by the time the request reaches the
binding. The Dynamic Worker proxy runs last, which means the allow
and deny rules still apply to anything the proxy itself tries to
fetch.

## Setting it up

### 1. Create a policy

Use the dashboard (**Egress Policies → New**) or PUT it directly:

```sh
curl -X PUT https://<worker>/api/egress-policies/pol_billing \
  -H 'content-type: application/json' \
  -d @- <<'JSON'
{
  "id": "pol_billing",
  "name": "Billing agents",
  "egressRules": [
    { "type": "allow", "host": "api.stripe.com" },
    { "type": "header-injection",
      "target": "api.stripe.com",
      "header": "Authorization",
      "secretName": "STRIPE_KEY" }
  ],
  "applyTo": [],
  "appliesToAll": true,
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:00:00Z"
}
JSON
```

### 2. Add any secrets it references

Header-injection rules look up secrets from the `SECRETS` KV namespace
at policy-compile time. Set them via the dashboard
(**Secrets → New**) or directly:

```sh
curl -X PUT https://<worker>/api/secrets/STRIPE_KEY \
  -H 'content-type: application/json' \
  -d '{"value":"sk_live_..."}'
```

The agent never sees the value — it's bound only to outbound requests
matching the rule's `target` host.

### 3. (Optional) Write a proxy function

`proxy` rules ship a JavaScript module that runs as a Dynamic Worker.
The proxy gets a sanitised env containing every header-injection
secret from the same policy, exposed as uppercased keys:

```ts
// stored in EgressRule.code; runs in a fresh Dynamic Worker per request
export default {
  async fetch(req: Request, env: Record<string, string>): Promise<Response> {
    const url = new URL(req.url);

    if (url.hostname === "internal-only.example.com") {
      const fwd = new Request(req);
      fwd.headers.set("X-Forwarded-By", "egress-proxy");
      fwd.headers.set("Authorization", env.AUTHORIZATION);
      return fetch(fwd);
    }

    return new Response("blocked by proxy", { status: 403 });
  },
};
```

The Worker is loaded on demand via the `PROXY_LOADER` Worker Loader
binding, keyed by policy id, and reused across requests.

## Matching policies to sessions

Each policy has an `applyTo` list of matchers that decide which
sessions it applies to. The matchers compare attributes the webhook
carries about a session — by default `id`, `organization_id`, and
`workspace_id`, but anything Anthropic sends gets recorded and
becomes available.

Each matcher has three parts:

- **Field** — the attribute name to look at, e.g. `id` or
  `organization_id`.
- **Operator** — `equals`, `contains`, `matches` (regex), or
  `is-one-of`.
- **Value** — the string to compare against (or `values`, an array,
  for `is-one-of`).

Matchers within one policy are **AND**-ed: every matcher must be true
for the policy to apply. Specific policies (with at least one `applyTo`
matcher) are tried first; the first one whose matchers all pass wins.
If none match, the first `appliesToAll` catch-all policy is used.

To set this up in the dashboard, open the policy editor and add one
or more rows under **Apply to**. Pick the field from the dropdown
(the suggestions come from attributes seen on recent webhooks),
choose an operator, and enter the value.

To make a policy the catch-all default for any session that doesn't
match a more specific policy, leave **Apply to** empty and check
**Applies to all**. Sessions that don't match any policy and have no
catch-all run with no egress restrictions.

A few common shapes:

- **Per-agent policy.** `agent_id matches "<AGENT_ID>"` —
  apply policy only to specific agents`.
- **Per-organization policy.** `organization_id is-one-of
  ["org_acme", "org_globex"]` — apply this policy to two specific
  Anthropic organizations.
- **Per-environment policy.** `id matches "session_prod_.*"` —
  match every session whose id starts with `session_prod_`.
- **Catch-all default.** No matchers, **Applies to all** checked.

## Defaults and gotchas

- **Empty allow list ≠ deny all.** It means "no allow filtering — any
  host not denied is allowed." Set `allow: ["*"]` if you want explicit
  pass-through; set `allow: ["foo.example"]` to deny everything else.
- **Deny always wins.** Adding `deny: "evil.example"` overrides any
  allow.
- **Server-side tools bypass egress.** `web_fetch` and `web_search` run
  on Anthropic's infrastructure and are not subject to your policy.
  The dashboard auto-disables them unless explicitly enabled and warns
  before you opt in.
- **`cf_*` tools bypass egress too.** `cf_web_fetch`, `browse`,
  `fetch_to_markdown`, `screenshot`, and friends dispatch from the
  parent Worker DO; Browser Rendering does the actual outbound from
  its own infrastructure. None of that traffic flows through
  `applyEgressPolicy`. The trade-off is observability: these requests
  *are* logged on your Cloudflare account (Workers Logs, Logpush, BR
  dashboard) even though the policy can't shape them. Use VPC bindings
  + `call_service` for internal hosts that you need to keep off the
  public internet.
- **Anthropic control-plane is always allowed.** The control plane inside the
  sandbox uses `api.anthropic.com` (or whatever `ANTHROPIC_BASE_URL` you
  set) for heartbeats, the events stream, and posting tool results.
  `applyEgressPolicy` short-circuits to a passthrough fetch for that
  host before any `deny` / `allow` / header-injection / proxy / VPC rule
  runs, so a tight allow list can't accidentally strand the agent. If
  you genuinely want to block them, you have to do it at the
  Anthropic-side webhook / org level, not via this policy.

## API reference

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/api/egress-policies` | list all policies |
| `GET` | `/api/egress-policies/:id` | fetch one |
| `PUT` | `/api/egress-policies/:id` | upsert |
| `DELETE` | `/api/egress-policies/:id` | delete |
| `GET` | `/api/egress-policies/data-fields` | known matcher field names |
| `GET` | `/api/secrets` | list named secrets |
| `PUT` | `/api/secrets/:key` | set / update a secret |
| `DELETE` | `/api/secrets/:key` | remove a secret |

Source: `src/api/index.ts`.
