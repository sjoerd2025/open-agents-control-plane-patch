// Thin API client. Returns parsed JSON or throws on non-2xx.

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    if (
      body &&
      typeof body === "object" &&
      "error" in (body as Record<string, unknown>)
    ) {
      message = String((body as Record<string, unknown>).error);
    }
    throw new ApiError(res.status, body, message);
  }
  return body as T;
}

export interface ConfigCapabilities {
  // Whether MicroVM `/workspace` snapshots are being persisted. False
  // when the BACKUP_BUCKET R2 binding is absent, which means container
  // hibernation will silently lose state.
  snapshots: boolean;
  // How snapshots are routed when they ARE enabled. "presigned" is the
  // production path (R2 access keys + account id present); "localBucket"
  // is the dev fallback that talks to the R2 binding directly; "disabled"
  // means no binding at all.
  snapshotsMode: "presigned" | "localBucket" | "disabled";
  browserRendering: boolean;
  workersAi: boolean;
  emailSend: boolean;
  emailInbox: boolean;
  // True when at least one persisted agent uses the MicroVM backend (or
  // no agents exist yet — `microvm` is the default). Lets the dashboard
  // hide the snapshots warning on Isolate-only deployments. Optional so
  // older worker deploys still parse.
  hasMicrovmAgents?: boolean;
}

export interface ConfigResponse {
  environmentId: string | null;
  anthropicBaseURL: string;
  missing: string[];
  // Optional so older worker deploys still parse — frontend code that
  // reads these flags should fall back to `undefined`-tolerant logic.
  capabilities?: ConfigCapabilities;
}

// Backend identifier persisted on each agent.
//   "microvm" — Cloudflare Sandbox SDK (containers / microVMs)
//   "isolate" — Cloudflare Workers isolate + SQLite Workspace (no shell)
export type AgentBackend = "microvm" | "isolate";

// Tool catalog entry returned by `/api/tool-catalog`. The fields the
// dashboard renders are the same across every group; `available` and
// `requires` are only set for binding-gated tools so the form can
// disable / hint accordingly.
export interface ToolCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  available?: boolean;
  requires?: string | null;
  // Set on `isolatePower` entries that the MicroVM backend can also
  // host (browser CDP tools today). Used by the agent form to surface
  // these in the MicroVM tool catalog alongside cf_* tools.
  microvmEligible?: boolean;
}

export interface ToolCatalogResponse {
  microvmStock: ToolCatalogEntry[];
  serverSide: ToolCatalogEntry[];
  isolateWorkspace: ToolCatalogEntry[];
  isolatePower: ToolCatalogEntry[];
  cfTools: ToolCatalogEntry[];
  custom: ToolCatalogEntry[];
}

// Workspace file/directory entry returned by the Isolate Sandbox browse
// endpoints. Mirrors the `FileInfo` shape the control plane DO marshals across the
// RPC boundary — kept as a plain object so the wire format stays trivial.
export interface WorkspaceEntry {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  lastWebhookAt: string;
  lastWebhookType: string;
  containerStatus?: string;
  backend?: AgentBackend;
}

export interface SessionPage {
  items: SessionRecord[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface WebhookEvent {
  type: "event";
  id: string;
  // Anthropic uses `created_at`; older payloads used `timestamp`. We surface
  // whichever one is set in the event.
  created_at?: string;
  timestamp?: string;
  data: {
    type: string;
    id: string;
    organization_id?: string;
    workspace_id?: string;
  };
}

export interface WebhookEventPage {
  items: WebhookEvent[];
  cursor: string | null;
  hasMore: boolean;
}

export interface SecretItem {
  key: string;
  updatedAt: string | null;
}

export interface EgressPolicy {
  id: string;
  name: string;
  egressRules: EgressRule[];
  applyTo: ApplyToMatcher[];
  // Catch-all flag — when true, this policy applies to every sandbox.
  // Mutually exclusive with `applyTo`; the form prevents combining them.
  appliesToAll?: boolean;
  // Legacy field kept optional for back-compat with stored policies. The UI
  // no longer reads or writes this.
  sessionIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export type EgressRule =
  | { type: "allow"; host: string }
  | { type: "deny"; host: string }
  | {
      type: "header-injection";
      target: string;
      header: string;
      secretName: string;
    }
  | { type: "proxy"; code: string }
  | { type: "vpc-service"; binding: string; hostname: string };

export interface ApplyToMatcher {
  field: string;
  operator: "equals" | "contains" | "matches" | "is-one-of";
  value?: string;
  values?: string[];
}

export interface VpcBinding {
  binding: string;
  type: "network" | "service";
  id: string;
  description?: string;
}

export interface VpcResponse {
  items: VpcBinding[];
  docsUrl: string;
}

export const api = {
  config: () => request<ConfigResponse>("/api/config"),

  // Sandboxes / sessions tracked by webhook ingestion.
  environments: (page: number, limit: number) =>
    request<SessionPage>(`/api/environments?page=${page}&limit=${limit}`),
  environmentStatus: (sessionId: string) =>
    request<{
      sessionId: string;
      containerStatus: string;
      backend?: AgentBackend;
    }>(`/api/environments/${encodeURIComponent(sessionId)}/status`),
  drainEnvironments: () =>
    request<{ status: string; spawned: unknown[] }>("/api/environments/drain", {
      method: "POST",
    }),
  stopEnvironment: (sessionId: string) =>
    request<{ sessionId: string; status: string }>(
      `/api/environments/${encodeURIComponent(sessionId)}/stop`,
      { method: "POST" },
    ),

  // Workspace browser (Isolate Sandbox only). MicroVM sessions return 409.
  workspaceList: (sessionId: string, path = "/") =>
    request<{ path: string; entries: WorkspaceEntry[] }>(
      `/api/environments/${encodeURIComponent(sessionId)}/workspace?path=${encodeURIComponent(path)}`,
    ),
  workspaceFile: (sessionId: string, path: string) =>
    request<{ entry: WorkspaceEntry; content: string }>(
      `/api/environments/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(path)}`,
    ),
  workspaceInfo: (sessionId: string) =>
    request<{
      fileCount: number;
      directoryCount: number;
      totalBytes: number;
      r2FileCount: number;
    }>(`/api/environments/${encodeURIComponent(sessionId)}/workspace/info`),

  // Webhook events
  webhookEvents: (cursor?: string | null, limit = 50) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    return request<WebhookEventPage>(`/api/webhook-events?${qs}`);
  },
  webhookEvent: (eventId: string) =>
    request<WebhookEvent>(`/api/webhook-events/${encodeURIComponent(eventId)}`),
  clearWebhookEvents: () =>
    request<{ deleted: number }>("/api/webhook-events", { method: "DELETE" }),

  // Secrets
  listSecrets: (cursor?: string | null) => {
    const qs = new URLSearchParams({ limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    return request<{
      items: SecretItem[];
      cursor: string | null;
      hasMore: boolean;
    }>(`/api/secrets?${qs}`);
  },
  putSecret: (key: string, value: string) =>
    request<{ key: string; status: string }>(
      `/api/secrets/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      },
    ),
  deleteSecret: (key: string) =>
    request<{ key: string; status: string }>(
      `/api/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    ),

  // Egress policies
  listPolicies: () =>
    request<{ items: EgressPolicy[] }>("/api/egress-policies"),
  policyDataFields: () =>
    request<{ items: string[] }>("/api/egress-policies/data-fields"),
  getPolicy: (id: string) =>
    request<EgressPolicy>(`/api/egress-policies/${encodeURIComponent(id)}`),
  savePolicy: (policy: EgressPolicy) =>
    request<EgressPolicy>(
      `/api/egress-policies/${encodeURIComponent(policy.id)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policy),
      },
    ),
  deletePolicy: (id: string) =>
    request<{ id: string; status: string }>(
      `/api/egress-policies/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  // VPC + Mesh
  vpc: () => request<VpcResponse>("/api/vpc"),

  // Isolate Sandbox defaults (recommended system prompt, etc).
  isolateDefaults: () =>
    request<{ systemPrompt: string }>("/api/isolate/defaults"),
  // MicroVM Sandbox defaults — analogous to isolateDefaults but covers
  // the container backend's quirks (shell, $ANTHROPIC_SESSION_ID env
  // var, /workspace persistence).
  microvmDefaults: () =>
    request<{ systemPrompt: string }>("/api/microvm/defaults"),
  // User-defined custom tools — pulled at runtime from src/tools/custom-tools.ts.
  // `available` reflects whether the tool's `requires` predicate
  // currently passes against the deployed env so we can grey out
  // toggles for tools whose binding isn't configured.
  customTools: () =>
    request<{
      tools: Array<{ name: string; description: string; available: boolean }>;
    }>("/api/custom-tools"),

  // Full agent tool catalog. Single source of truth for the checkbox
  // grid in the agent form — backend changes (new cf_* tool, new
  // user-defined custom, etc.) surface in the UI automatically on the
  // next deploy without a frontend edit. `available: false` entries
  // still render but are greyed out so operators can see why the
  // checkbox is disabled.
  toolCatalog: () => request<ToolCatalogResponse>("/api/tool-catalog"),

  // Anthropic-proxied APIs
  agents: () => request<{ data: AnthropicAgent[] }>("/api/agents"),
  agent: (id: string) => request<AnthropicAgent>(`/api/agents/${id}`),
  agentBackend: (id: string) =>
    request<{ agentId: string; backend: AgentBackend }>(
      `/api/agents/${encodeURIComponent(id)}/backend`,
    ),
  saveAgent: (id: string | null, body: unknown) =>
    request<AnthropicAgent>(id ? `/api/agents/${id}` : "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),

  sessions: (backend?: AgentBackend) => {
    const qs = backend ? `?backend=${encodeURIComponent(backend)}` : "";
    return request<{ data: AnthropicSession[] }>(`/api/sessions${qs}`);
  },
  session: (id: string) => request<AnthropicSession>(`/api/sessions/${id}`),
  createSession: (body: unknown) =>
    request<AnthropicSession>("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  sessionEvents: (id: string) =>
    request<{ data: AnthropicEvent[] }>(`/api/sessions/${id}/events`),
  sendSessionMessage: (id: string, text: string) =>
    request<unknown>(`/api/sessions/${id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      }),
    }),
  archiveSession: (id: string) =>
    request<unknown>(`/api/sessions/${id}/archive`, { method: "POST" }),
};

export interface AnthropicAgent {
  id: string;
  name: string;
  // The managed-agents beta started returning `model` as an object
  // (`{id, speed}`) where it used to be a plain string. We keep the
  // union so older fixtures and any future fallback still type-check,
  // but `modelId()` in utils.ts should be used at every render site.
  model: string | { id: string; speed?: string };
  version: string;
  system?: string;
  tools?: Array<{
    type?: string;
    name?: string;
    // The agent_toolset_20260401 wrapper carries a `default_config` plus a
    // per-tool `configs` array. We read both so we can faithfully
    // round-trip server-side tool toggles (web_fetch / web_search) which
    // default-on inside the toolset but are opt-in at the form level.
    default_config?: {
      enabled?: boolean;
      permission_policy?: { type?: string };
    };
    configs?: Array<{ name: string; enabled?: boolean }>;
    // mcp_toolset blocks reference an MCP server by name; the form uses
    // this to detect the cf_* MCP toolset and reflect the user's per-tool
    // selection.
    mcp_server_name?: string;
  }>;
  // Local addition — populated by /api/agents and /api/agents/:id from the
  // agent_backends D1 table. Defaults to "microvm" when no row is present.
  backend?: AgentBackend;
}

export interface AnthropicSession {
  id: string;
  title?: string;
  status: string;
  // Anthropic returns the resolved agent under a nested `agent` object
  // (snapshot at session-creation time). The frontend reads `agent.id`
  // when linking from a session back to its agent.
  agent?: {
    id: string;
    name?: string;
    version?: number;
  };
  created_at?: string;
  updated_at?: string;
  // Surfaced by the worker — joined from the local sessions table on the
  // way out. Falls back to "microvm" when no cached backend is known yet.
  backend?: AgentBackend;
}

// Tool-use / tool-result blocks can appear either as the event's own
// `type` (older shape: ev.type = "tool_use", ev.name = "write") or
// nested inside `ev.content[]` (newer agent-event shape:
// ev.type = "agent.message_added", ev.content = [{ type: "tool_use",
// name: "write", input: {...} }]). We type both so the renderer can
// surface the tool name regardless of where it lives.
export interface AnthropicEvent {
  type: string;
  created_at?: string;
  content?: Array<{
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    is_error?: boolean;
    content?: unknown;
  }>;
  name?: string;
  input?: unknown;
  error?: { message?: string };
}
