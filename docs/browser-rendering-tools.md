# Browser Tools

Give an agent the ability to read the live web — and drive a real
Chromium instance— through
[Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/).

Requests are billed to and observable on your Cloudflare account
(Workers Logs, Logpush, the Browser Run dashboard).

The built-in `web_fetch` runs on Anthropic's infrastructure — your
account never sees the request and you have no audit trail. **Prefer
the `cf_*` tools below when both are available.**

> **Note on egress policies.** The session's egress policy wraps
> fetches issued from *inside* the sandbox (the container on MicroVM,
> the dynamic Worker spawned by `execute` / `run_file` on Isolate).
> `cf_*` tools dispatch from the parent Worker DO, and Browser
> Rendering does the actual outbound from its own infrastructure, so
> requests made through these tools do **not** traverse the egress
> policy. The audit trail lives on the Cloudflare platform instead.

## What ships

### Content fetching

Available on both sandbox backends. Each tool gates on Browser
Rendering being wired up (see [Setup](#setup) below).

| Tool | Purpose |
| --- | --- |
| `cf_web_fetch` | Fetch a URL; auto-detects PDFs; preferred over the built-in `web_fetch` |
| `fetch_to_markdown` | URL → clean markdown for prose extraction |
| `browse` | URL → rendered HTML for inspection or scraping |
| `screenshot` | Capture a PNG of a URL (saved to the workspace on Isolate; returned inline on MicroVM) |

### CDP control (Isolate only)

Direct access to the
[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
through Browser Run. Use these for scripted browsing flows the
content-fetching tools don't cover (clicks, form fills, multi-page
navigation). Requires both the `LOADER` and `BROWSER` bindings.

| Tool | Purpose |
| --- | --- |
| `browser_search` | Query the CDP spec for commands, events, and types |
| `browser_execute` | Run CDP commands against a live browser session |

## Two paths to Browser Run

Cloudflare exposes Browser Run two ways and both are first-class.
The control plane accepts either; configure whichever fits your account.

### Path A — REST API ("Quick Actions")

Authenticate with an API token. Hosted, includes a server-side
HTML→markdown converter, and supports operations the binding doesn't
expose directly (PDF, scrape, snapshot).

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

The token needs the **Account → Browser Rendering → Edit** permission.

### Path B — Workers Binding + Puppeteer

The `BROWSER` binding is declared in `wrangler.jsonc` by default — no
secrets to set, the binding itself is the credential. The control
plane drives Chrome through
[`@cloudflare/puppeteer`](https://www.npmjs.com/package/@cloudflare/puppeteer).
For markdown on the binding path the control plane rounds-trips HTML through
`env.AI.toMarkdown()` if the Workers AI binding is also present;
otherwise it returns raw HTML with a clear note.

### When to pick which

- The REST path is faster (no puppeteer overhead) and supports
  `/markdown` natively. Pick this when you have API token + account id
  already configured (you likely do — the snapshot system uses the
  same secrets).
- The binding path is more self-contained — no secrets, no API tokens.
  Pick this when you'd rather not mint a Cloudflare API token.

The control plane prefers REST when both are configured. Falling back to the
binding is automatic; no agent-side code change needed.

## Setup

The `BROWSER` binding ships declared in `wrangler.jsonc` by default,
so the binding path works out of the box. To use the REST path
instead (faster, supports PDF/scrape), set both secrets:

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

CDP control (`browser_search` / `browser_execute`) also requires the
`LOADER` Worker Loader binding, which is declared by default too.

Then deploy:

```sh
npm run deploy
```

The agent form on the dashboard automatically surfaces each tool as a
toggle. Tools whose binding isn't configured render disabled with a
tooltip explaining what's missing.

## Tool reference

### `cf_web_fetch`

```ts
{
  url: string,
  format?: "markdown" | "html",   // default: "markdown"
  max_chars?: number,             // default: 200_000
}
```

Returns a JSON document block matching Anthropic's built-in
`web_fetch_tool_result` shape:

```json
{
  "url": "<final URL after redirects>",
  "title": "<page title>",
  "retrieved_at": "<ISO timestamp>",
  "content": {
    "type": "document",
    "media_type": "text/markdown" | "text/html" | "application/pdf",
    "encoding": "base64",          // PDF only
    "data": "...",                 // truncated string or base64 bytes
    "size_bytes": 0                // PDF only
  }
}
```

PDFs are detected via HEAD content-type or `.pdf` extension and
returned as base64 — Browser Run's markdown endpoint can't
extract PDF text, so the control plane bypasses BR for PDFs and
fetches the URL directly from the parent Worker DO. Same posture as
the BR-mediated path: visible on your Cloudflare account but not
subject to the per-session egress policy (which only wraps in-sandbox
fetches).

### `fetch_to_markdown`

```ts
{ url: string }
```

Returns markdown directly (truncated at 200 KB). Best for prose
extraction — articles, docs, blog posts.

### `browse`

```ts
{ url: string }
```

Returns the rendered HTML after JavaScript execution (truncated at
200 KB). Best for inspecting structure or scraping attributes that
client-side rendering produced.

### `screenshot`

```ts
{
  url: string,
  full_page?: boolean,           // default false (viewport-only)
  viewport_width?: number,       // default 1280
  viewport_height?: number,      // default 800
  path?: string,                 // Isolate-only; workspace path to save the PNG
}
```

On Isolate: writes the PNG to the workspace at `path` (default
`/screenshot.png`) and returns a confirmation string with the byte
count.

On MicroVM: returns the PNG inline as a content block (the
type:"custom" tool result carries `image` blocks alongside text). Save
to disk with the agent's built-in `write` tool if you need to persist
it under `/workspace`.

### `browser_search`

```ts
{ code: string }
```

Runs a JS arrow function with access to a CDP spec search helper. Use
this when you need to discover what CDP command does what — handy for
the model when it's writing the next `browser_execute` call.

Available on both backends. Requires the parent Worker to have
`LOADER` (Worker Loader) and `BROWSER` (Browser Run) bindings —
the factory spins up a fresh Worker isolate via `LOADER` and calls
`BROWSER` directly, so the MicroVM container is uninvolved.

### `browser_execute`

```ts
{ code: string }
```

Runs a JS arrow function against a live browser session. Each call
opens a fresh session, exposes a `cdp` helper for issuing commands,
and closes the session on completion. The control plane doesn't share
sessions across calls — each tool invocation is fully isolated.

Available on both backends under the same `LOADER` + `BROWSER`
requirement as `browser_search`.

## Why `cf_*` over the built-in `web_fetch`

- **Observable.** Every fetch shows up in Workers Logs and Logpush on
  your account, plus the Browser Run dashboard. The built-in
  fetches happen on Anthropic's infrastructure and you never see them.
- **Renders JavaScript.** Browser Run drives a real Chrome.
  Many modern sites are useless to the built-in `web_fetch` because
  they render content client-side.
- **Cost transparency.** Browser Run billing flows through your
  account.

The "prefer cf_* when present" preference is baked into the Isolate
and MicroVM system prompts so the model reaches for the right tool
automatically.

## Troubleshooting

- **"error: browser rendering binding not configured"** — neither path
  is wired up. Set `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` or
  add the `BROWSER` binding.
- **REST returns 401** — the API token doesn't have the **Browser
  Rendering → Edit** permission, or it's scoped to the wrong account.
- **Binding path returns raw HTML when markdown was requested** — the
  AI binding isn't configured. Uncomment `ai` in `wrangler.jsonc` for
  the binding path's HTML→markdown conversion.
- **CDP tools return "endpoint requires CLOUDFLARE_API_TOKEN"** — the
  `browser_search` / `browser_execute` tools need the `LOADER` binding
  for the sandboxed JS host AND a browser path. Add the missing binding.
- **PDF returns garbled text** — PDFs route around Browser Run
  and use a direct fetch. If the PDF is gated behind authentication,
  the agent has to fetch it through a different path (e.g.
  `call_service` to a private service that already has access).
