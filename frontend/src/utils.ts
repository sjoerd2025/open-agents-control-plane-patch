// Claude Platform URLs. The dashboard is workspace-scoped; we currently
// hard-code "default" because this app doesn't surface workspace selection.
export const CLAUDE_PLATFORM_BASE = "https://platform.claude.com";
const WORKSPACE = "default";

export function claudePlatformDashboardUrl() {
  return `${CLAUDE_PLATFORM_BASE}/dashboard`;
}

export function claudeAgentsIndexUrl() {
  return `${CLAUDE_PLATFORM_BASE}/workspaces/${WORKSPACE}/agents`;
}

export function claudeAgentUrl(id: string) {
  return `${CLAUDE_PLATFORM_BASE}/workspaces/${WORKSPACE}/agents/${encodeURIComponent(id)}`;
}

export function claudeSessionUrl(id: string) {
  return `${CLAUDE_PLATFORM_BASE}/workspaces/${WORKSPACE}/sessions/${encodeURIComponent(id)}`;
}

export function claudeEnvironmentUrl(id: string) {
  return `${CLAUDE_PLATFORM_BASE}/workspaces/${WORKSPACE}/environments/${encodeURIComponent(id)}`;
}

export function relTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function shortSessionId(id: string | undefined): string {
  if (!id) return "";
  const compact = id.replace(/^(session|sesn)_/, "");
  return compact.length > 12 ? compact.substring(0, 12) + "..." : compact;
}

// One semantic badge variant per logical state. Kumo's named variants
// (`success`, `warning`, `error`, `info`, `secondary`) drive the colours.
export type StatusIntent = "success" | "warning" | "danger" | "neutral";

export const intentBadgeVariant = {
  success: "success",
  warning: "warning",
  danger: "error",
  neutral: "secondary",
} as const;

export function containerBadgeIntent(status: string | undefined): StatusIntent {
  if (status === "running" || status === "healthy") return "success";
  if (status === "starting" || status === "stopping") return "warning";
  if (status === "stopped" || status === "stopped_with_code" || status === "terminated") return "danger";
  return "neutral";
}

export function sessionStatusIntent(status: string | undefined): StatusIntent {
  if (status === "running" || status === "idle") return "success";
  if (status === "closed") return "danger";
  return "neutral";
}

export function randomSessionTitle() {
  const adj = ["swift", "bright", "quiet", "bold", "lucky", "fuzzy", "cosmic", "amber", "vivid", "nimble"];
  const nouns = ["falcon", "river", "prism", "orbit", "spark", "grove", "delta", "quartz", "beacon", "cipher"];
  const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
  return `${pick(adj)}-${pick(nouns)}-${Math.floor(Math.random() * 9000) + 1000}`;
}

export function newPolicyId(): string {
  return "pol_" + Math.random().toString(36).slice(2, 11);
}

// The managed-agents beta returns `model` as `{id, speed}` on GET but
// still accepts a plain string on POST. Unwrap to the model id for
// display and for prefilling the form's select. Falls back to "" so
// callers can `|| default` cleanly.
export function modelId(
  model: string | { id?: string; speed?: string } | null | undefined,
): string {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.id ?? "";
}

// Copy a string to the clipboard. Prefers the modern async API, falls back
// to a hidden textarea + execCommand for older browsers and contexts where
// `navigator.clipboard` is unavailable (e.g. non-https iframes during
// local development). Throws on failure so callers can show an error toast.
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("execCommand copy returned false");
    }
  } finally {
    document.body.removeChild(ta);
  }
}
