# Connecting to Private Services

Run an agent that can talk to your internal Postgres in AWS, an order
service in GCP, or anything sitting behind your firewall on-prem —
without exposing those services to the public internet.

This is **Workers VPC**: the Cloudflare Worker that hosts the agent
sandbox connects into your VPC over a Cloudflare-managed tunnel and the
agent uses that connection like any other binding.

## What you can do

Two paths from agent to private service, both backed by the same
`vpc_services` bindings declared in `wrangler.jsonc`:

1. **The `call_service` tool.** A built-in tool that lists every VPC
   service binding and lets the agent pick by name. Easiest for the
   model to use; works the same on both backends — the tool body runs
   inside the Durable Object's custom-tool dispatcher with direct
   binding access.
2. **Plain `fetch()` + a `vpc-service` egress rule.** Agent code calls
   `fetch("https://api.internal.example.com/...")` and the egress
   handler routes the request through the binding instead of public
   DNS. Great when the agent is using a vendor SDK that takes a
   hostname.

Both end up at `env[BINDING].fetch(req)`, which Cloudflare's VPC data
plane delivers to your service.

## Why use one

- **Reach private databases.** Hyperdrive + a `vpc_services` binding
  to your Postgres so the agent can query it without opening 5432 to
  the internet.
- **Internal-only APIs.** Order management, identity providers,
  feature flag services — anything you don't want on the public
  internet but the agent needs to call.
- **Compliance.** Auditors are happier when traffic between the agent
  and your data plane never leaves your private network.
- **Cross-cloud.** Workers VPC reaches AWS, GCP, Azure, and on-prem
  through Magic WAN. The agent doesn't care which.

## Setup

### 1. Declare the binding

Edit `wrangler.jsonc`:

```jsonc
"vpc_services": [
  {
    "binding": "INTERNAL_API",
    "service_id": "00000000-0000-0000-0000-000000000000"
  }
]
```

VPC services live in the Cloudflare dashboard under **Workers & Pages
→ Workers VPC**. Create them there first; their ids go in the config
above. See the [Workers VPC docs](https://developers.cloudflare.com/workers-vpc/)
for how to set up a tunnel and connect a target network.

### 2. Sync the dashboard's view of bindings

The Worker can't read `wrangler.jsonc` at runtime, so the prebuild
script `scripts/sync-vpc-bindings.mjs` parses it and writes the list
into `src/vpc.generated.ts`. Run it after editing the config:

```sh
npm run vpc:sync
```

`npm run build` runs this automatically.

### 3. Deploy

```sh
npm run deploy
```

That's it. The next session has the bindings attached.

## Two ways the agent calls a private service

### Path 1: the `call_service` tool

The agent picks a binding from a runtime enum and the tool dispatches
into it. From `src/tools/cf/vpc.ts`:

```ts
// Tool input
{
  binding: "INTERNAL_API",
  method: "GET",
  path: "/v1/orders/123",
  headers: { Accept: "application/json" }
}
```

The tool synthesises a URL like `http://service.local/v1/orders/123`
and calls `env.INTERNAL_API.fetch(...)`. The model sees a clean enum of
allowed bindings, never the underlying service ids. The tool body
runs the same way on both backends — inside the session's Durable
Object with direct `env` access.

The synthetic URL host is ignored — the VPC binding routes to
whatever Host/Port you configured on the VPC Service itself.

### Path 2: a `vpc-service` egress rule

Add a rule mapping a hostname to the binding:

```jsonc
{
  "type": "vpc-service",
  "binding": "INTERNAL_API",
  "hostname": "api.internal.example.com"
}
```

Now any `fetch("https://api.internal.example.com/...")` call from the
agent goes via `env.INTERNAL_API.fetch()` instead of public DNS.

This is the right choice when:

- You're using a vendor SDK that takes a base URL.
- The hostname needs to look "real" for downstream verification (TLS
  SNI, vhost routing).
- You want the same hostname to work in both staging and production
  because the binding name stays the same.

The rule's `hostname` is the **matcher**, not the destination. The
destination is whatever you set on the VPC Service in the dashboard
(or via `wrangler vpc service update`). See the gotchas section.

## Inspecting bindings

The dashboard's **VPC + Mesh** page reads the synced list:

```sh
curl https://<worker>/api/vpc
# → { "items": [{ "binding": "INTERNAL_API", "type": "service", "id": "..." }],
#     "docsUrl": "..." }
```

Use this to verify the prebuild step picked up your edits before
deploying.

## Gotchas

Most VPC binding failures end up surfacing as
`{"error":"vpc binding threw","message":"handshake timeout"}` or
`connection_refused`. The fix is almost always one of these:

- **Workers VPC uses cloudflared's warp-routing service, not its
  ingress.** `cloudflared tunnel --url http://localhost:8080 run NAME`
  only handles requests addressed to a **public hostname** route — it
  does not catch VPC binding traffic. Workers VPC sends every request
  to cloudflared's `warp-routing` service, which dials the
  `Host:Port` configured on the VPC Service **directly**. Look for
  `originService=warp-routing` in `cloudflared` logs to confirm
  you're on this path.
- **The VPC Service Host must resolve to something cloudflared can
  reach.** Cloudflared resolves the Host on the tunnel machine, not
  on Cloudflare's edge. If you put `acme.com` there as a placeholder,
  cloudflared resolves it to the real IANA placeholder IP and times
  out. Use a real internal hostname (`internal-api.local`,
  `db.private`), an IP (`10.0.1.50`, `127.0.0.1`), or set a custom
  DNS resolver on the VPC Service so the lookup succeeds.
- **The VPC Service ports are where cloudflared dials.** Defaults are
  HTTP 80 / HTTPS 443. If your service listens on 8080 or 8787, set
  the HTTP port to match — cloudflared isn't going to "follow" your
  `--url` flag.
- **`vpc-service` rule hostname is the matcher, not the destination.**
  The hostname on the rule only decides which `fetch()` calls get
  routed through the binding. The destination is the Host/Port on the
  VPC Service. They're independent — set the rule to whatever the
  agent will fetch, and the VPC Service to whatever cloudflared should
  dial.
- **TLS verification can be disabled when the destination is HTTP-only.**
  The setting only matters for `https://` URLs. For an HTTP-only
  internal service, leave it on the default — the failure won't be
  TLS-related.
- **QUIC, not HTTP/2.** Workers VPC requires `cloudflared` to use the
  QUIC transport (UDP/7844). The default is QUIC; if your firewall
  blocks outbound UDP, cloudflared falls back to HTTP/2 and DNS
  resolution from Workers VPC breaks. The `cloudflared` log line
  `Switching to fallback protocol http2` is the signal.

### Other things to know

- **"binding not available."** Either the binding isn't declared in
  `wrangler.jsonc` or the prebuild script wasn't re-run. Check
  `GET /api/vpc`.
- **Egress policy blocks the call.** If the policy has an allow list,
  it's evaluated against the request's hostname. Add the private
  hostname to the allow list, or use a `vpc-service` rule which
  dispatches via the binding before hostname-allow filtering applies.
- **Session won't accept new `user.message` events** with the error
  `waiting on responses to events`. The session has an orphaned
  `agent.custom_tool_use` from a prior run where the dispatcher
  didn't pick up the work. Send a `{"type":"user.interrupt"}` event
  to clear it, then post your message. If that doesn't work, start a
  fresh session — cheaper than debugging.

## Try VPC end-to-end with a laptop tunnel

The fastest way to convince yourself the Workers VPC integration works
is to expose a service running on your laptop, point a `vpc_services`
binding at it, and call it from an agent. Five-minute end-to-end:

**1. Run something locally on port 8080.**

```sh
python3 -m http.server 8080
```

**2. Create a Cloudflare Tunnel.**

```sh
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel login
cloudflared tunnel create laptop-dev
```

Then run it (the `--url` flag here is harmless but unused by VPC
traffic — keep it if you also want a public hostname for the same
service):

```sh
cloudflared tunnel run laptop-dev
```

**3. Provision a Workers VPC service against the tunnel.**

Cloudflare dashboard → **Workers & Pages → Workers VPC → Services →
Create service**. Pick **Cloudflare Tunnel** as the source, choose
`laptop-dev`, and set:

- **Host / IP**: `localhost` (this is what cloudflared dials on your
  machine — must be reachable from where cloudflared is running)
- **HTTP port**: `8080` (match your local server)
- **TLS verification**: `disabled` (your localhost server has no
  cert; only matters for `https://` fetches)

Copy the service id (a UUID).

**4. Bind the service in `wrangler.jsonc`.**

```jsonc
"vpc_services": [
  { "binding": "LAPTOP", "service_id": "<paste-the-uuid>" }
]
```

```sh
npm run vpc:sync       # discovers the new binding for the dashboard
npx wrangler types     # regenerates Env so `LAPTOP` is typed
npm run deploy
```

**5. Call it from an agent.**

In the dashboard, open or create an Isolate-backed agent with the
`call_service` tool enabled. Start a session and ask it:

```
Use call_service with binding "LAPTOP" and path "/" and tell me
what status code came back.
```

The agent's request flows: agent → Worker → `env.LAPTOP.fetch()` →
Cloudflare Tunnel → cloudflared → `localhost:8080`. Watch
`cloudflared` and the Python server in your terminal for the inbound
request.

**6. (Optional) test the `fetch()` + egress-rule path.**

Add a `vpc-service` egress rule (Egress Policies → New) that maps a
hostname to the same binding:

```jsonc
{ "type": "vpc-service", "binding": "LAPTOP", "hostname": "laptop.internal" }
```

Then any `fetch("http://laptop.internal/...")` from the sandbox routes
through the binding instead of public DNS. The hostname here is a
matcher only — it doesn't need to exist anywhere. Pick whatever string
the agent's code will use.

When you're done, kill `cloudflared`, delete the tunnel, and remove
the binding from `wrangler.jsonc`.
