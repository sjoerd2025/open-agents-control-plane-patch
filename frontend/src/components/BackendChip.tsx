import type { AgentBackend } from "../api";

// Pill rendering an agent's backend (MicroVM Sandbox vs Isolate Sandbox).
// Reused by the agents index, the agent detail page, and the environment
// detail page so the visual treatment stays consistent.
export function BackendChip({ backend }: { backend: AgentBackend }) {
  const label = backend === "isolate" ? "Isolate" : "MicroVM";
  const title =
    backend === "isolate"
      ? "Isolate Sandbox — SQLite-backed virtual filesystem in a Cloudflare Workers isolate. No shell."
      : "MicroVM Sandbox — full container with bash + filesystem, powered by the Cloudflare Sandbox SDK.";
  // We piggyback on existing tag-chip styles to avoid adding new CSS.
  // Color is inlined for the two known values; unknown backends fall back
  // to the default chip colour.
  const color =
    backend === "isolate"
      ? { borderColor: "var(--color-accent-purple, #8b5cf6)", color: "var(--color-accent-purple, #8b5cf6)" }
      : undefined;
  return (
    <span className="tag-chip mono" style={{ fontSize: "0.7rem", ...color }} title={title}>
      {label}
    </span>
  );
}
