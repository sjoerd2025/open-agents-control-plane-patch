// URL <-> View mapping for the React frontend.
//
// The app keeps using its `View` discriminated union internally so existing
// view components don't need to know about React Router. This module is the
// only place that knows how a `View` shows up in the address bar — every
// `navigate(view)` call ultimately walks through `routeTo`, and every URL
// the user lands on (back/forward, deep link, refresh) is rebuilt into a
// `View` by the route components in App.tsx.

import type { View } from "./App";

// Path templates kept in one place so adding/renaming routes is a single
// edit. Trailing slashes are intentionally avoided so React Router's
// matcher behaves predictably.
export const PATHS = {
  environments: "/sandboxes",
  envDetail: "/sandboxes/:sessionId",
  events: "/webhook-events",
  agents: "/agents",
  agentNew: "/agents/new",
  agentDetail: "/agents/:agentId",
  agentEdit: "/agents/:agentId/edit",
  sessions: "/sessions",
  sessionNew: "/sessions/new",
  sessionDetail: "/sessions/:sessionId",
  egress: "/egress-policies",
  secrets: "/secrets",
  vpc: "/vpc",
  doc: "/docs/:slug",
} as const;

// Path of the standalone Redoc API reference page. Served as a real
// static asset (not a React route) so navigating to it triggers a full
// browser page load — the browser back button then returns to whatever
// dashboard page the user came from. See `frontend/static/redoc.html`.
export const API_REFERENCE_URL = "/redoc.html";

// Build a `/docs/<slug>` URL. Kept here so the sidebar and DocView agree
// on encoding and prefix.
export function docPath(slug: string): string {
  return `/docs/${encodeURIComponent(slug)}`;
}

export function routeTo(view: View): string {
  switch (view.kind) {
    case "environments":
      return PATHS.environments;
    case "env-detail":
      return `/sandboxes/${encodeURIComponent(view.sessionId)}`;
    case "events":
      return PATHS.events;
    case "agents":
      return PATHS.agents;
    case "agent-detail":
      return `/agents/${encodeURIComponent(view.agentId)}`;
    case "agent-form":
      return view.agentId
        ? `/agents/${encodeURIComponent(view.agentId)}/edit`
        : PATHS.agentNew;
    case "sessions":
      return PATHS.sessions;
    case "session-detail":
      return `/sessions/${encodeURIComponent(view.sessionId)}`;
    case "session-form":
      return PATHS.sessionNew;
    case "egress":
      return PATHS.egress;
    case "secrets":
      return PATHS.secrets;
    case "vpc":
      return PATHS.vpc;
    case "doc":
      return docPath(view.slug);
    default: {
      const exhaustive: never = view;
      throw new Error(`Unknown view: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// Sidebar nav identifiers. Mirrors the `View['kind']` values that are
// reachable from the sidebar (top-level views only — detail/form views are
// considered children of their group). Doc pages share a single `doc:<slug>`
// id so the sidebar can highlight whichever doc the user is currently on.
export type NavId =
  | "environments"
  | "events"
  | "agents"
  | "sessions"
  | "egress"
  | "secrets"
  | "vpc"
  | `doc:${string}`
  | "api-docs";

// "api-docs" is a special nav id: clicking it triggers a top-level
// browser navigation to `/redoc.html` rather than a client-side React
// Router push, because the API reference page is rendered outside the
// SPA shell.

// Maps the current pathname to the highlighted sidebar entry. We match on
// path prefixes so e.g. /agents/foo/edit still highlights "Agents".
export function navIdForPath(pathname: string): NavId | null {
  if (pathname === PATHS.environments || pathname.startsWith(PATHS.environments + "/")) {
    return "environments";
  }
  if (pathname === PATHS.events) return "events";
  if (pathname === PATHS.agents || pathname.startsWith(PATHS.agents + "/")) {
    return "agents";
  }
  if (pathname === PATHS.sessions || pathname.startsWith(PATHS.sessions + "/")) {
    return "sessions";
  }
  if (pathname === PATHS.egress) return "egress";
  if (pathname === PATHS.secrets) return "secrets";
  if (pathname === PATHS.vpc) return "vpc";
  if (pathname.startsWith("/docs/")) {
    const slug = decodeURIComponent(pathname.slice("/docs/".length));
    return `doc:${slug}` as NavId;
  }
  return null;
}

export function pathForNav(id: NavId): string {
  if (id.startsWith("doc:")) {
    return docPath(id.slice("doc:".length));
  }
  switch (id) {
    case "environments":
      return PATHS.environments;
    case "events":
      return PATHS.events;
    case "agents":
      return PATHS.agents;
    case "sessions":
      return PATHS.sessions;
    case "egress":
      return PATHS.egress;
    case "secrets":
      return PATHS.secrets;
    case "vpc":
      return PATHS.vpc;
    case "api-docs":
      return API_REFERENCE_URL;
    default:
      return PATHS.environments;
  }
}
