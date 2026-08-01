import { useEffect, useMemo, useRef, useState } from "react";
import { Robot } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { AppBreadcrumbs } from "../components/AppBreadcrumbs";
import {
  api,
  type AgentBackend,
  type ToolCatalogEntry,
  type ToolCatalogResponse,
} from "../api";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import type { View } from "../App";
import { useToasts } from "../toasts";
import { modelId } from "../utils";

// Empty placeholder used until `/api/tool-catalog` resolves. The form
// renders a "loading" hint instead of an empty checkbox grid in that
// window so an operator visiting the page doesn't see a confusingly
// blank tools section.
const EMPTY_CATALOG: ToolCatalogResponse = {
  microvmStock: [],
  serverSide: [],
  isolateWorkspace: [],
  isolatePower: [],
  cfTools: [],
  custom: [],
};

const MODELS = ["claude-sonnet-4-6", "claude-opus-4-6"];

// Separator between the defaults preamble and any user-added content.
// Used both to assemble the prompt when the checkbox is toggled on
// and to strip it back off when toggled off. Same shape for both
// backends so the helpers below can share it.
const DEFAULTS_SEP = "\n\n";

export function AgentFormView({ agentId, navigate }: { agentId?: string; navigate: (v: View) => void }) {
  const { push } = useToasts();
  const [name, setName] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [backend, setBackend] = useState<AgentBackend>("microvm");

  // Cached defaults text per backend (fetched lazily on first need).
  // Held in refs so toggling the checkbox or switching backends doesn't
  // refetch. The fetcher returns the cached string when present.
  const isolateDefaultsRef = useRef<string | null>(null);
  const microvmDefaultsRef = useRef<string | null>(null);
  const [includeIsolateDefaults, setIncludeIsolateDefaults] = useState(false);
  const [includeMicrovmDefaults, setIncludeMicrovmDefaults] = useState(false);

  // The full agent tool catalog (fetched once on mount from
  // `/api/tool-catalog`). Replaces the hand-maintained tool lists this
  // file used to carry — adding a new cf_* tool or user-defined custom
  // is now a backend-only change, the form picks it up on the next
  // render.
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogResponse>(EMPTY_CATALOG);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  const fetchDefaults = async (which: AgentBackend): Promise<string> => {
    if (which === "isolate") {
      if (isolateDefaultsRef.current) return isolateDefaultsRef.current;
      const { systemPrompt: prompt } = await api.isolateDefaults();
      isolateDefaultsRef.current = prompt;
      return prompt;
    }
    if (microvmDefaultsRef.current) return microvmDefaultsRef.current;
    const { systemPrompt: prompt } = await api.microvmDefaults();
    microvmDefaultsRef.current = prompt;
    return prompt;
  };

  // Toggle the defaults preamble on/off. Adding prepends `defaults\n\n`;
  // removing strips that exact prefix from the current prompt so the
  // user's own additions are preserved verbatim. Same shape for both
  // backends; the only difference is which preamble string is used and
  // which "include defaults" piece of state flips.
  const toggleDefaults = async (which: AgentBackend, next: boolean) => {
    try {
      const defaults = await fetchDefaults(which);
      if (which === "isolate") setIncludeIsolateDefaults(next);
      else setIncludeMicrovmDefaults(next);
      setSystemPrompt((cur) => {
        if (next) {
          if (cur.startsWith(defaults)) return cur;
          return defaults + (cur.length > 0 ? DEFAULTS_SEP + cur : "");
        }
        if (cur.startsWith(defaults + DEFAULTS_SEP)) {
          return cur.slice((defaults + DEFAULTS_SEP).length);
        }
        if (cur.startsWith(defaults)) return cur.slice(defaults.length);
        return cur;
      });
    } catch (err) {
      push((err as Error).message, "error");
    }
  };
  // Tool selection is keyed by backend — switching backends resets the
  // checklist to that backend's full set, since tool names overlap but
  // mean different things (e.g. read on MicroVM is the host filesystem,
  // read on Isolate is the workspace).
  //
  // Server-side tools (web_fetch, web_search) live in the same Set but
  // are intentionally NOT included in the default-on selection — they
  // bypass the egress proxy, so opting in must be a deliberate action.
  const [tools, setTools] = useState<Set<string>>(new Set());

  // Fetch the full tool catalog once on mount. The endpoint is cheap
  // (no D1 queries — just iterates static registries and runs binding
  // predicates) but we still de-duplicate by stashing the result in
  // state. Failure falls through to the empty catalog so the rest of
  // the form still works — the user just sees no toggles.
  useEffect(() => {
    api
      .toolCatalog()
      .then((catalog) => {
        setToolCatalog(catalog);
        setCatalogLoaded(true);
      })
      .catch(() => {
        setCatalogLoaded(true);
      });
  }, []);

  // Catalog is the backend's built-in tool list with any user-defined
  // custom tools appended. The Sandbox / IsolateRunner DO runs a
  // custom-tool dispatcher for cf_* + user-defined entries; the
  // dispatcher closes over `env` so tools have direct access to
  // bindings without any cross-runtime hop. We render unavailable
  // tools (failing `requires` predicate) with a "binding not
  // configured" hint via the `available` flag.
  const annotate = (entry: ToolCatalogEntry): ToolCatalogEntry => {
    if (entry.available === false) {
      return {
        ...entry,
        description: `${entry.description} (binding not configured — tool will not be available)`,
      };
    }
    return entry;
  };
  // Power tools from the Isolate registry that the MicroVM backend can
  // also host. Today this is just the browser CDP tools (browser_search
  // / browser_execute) — their factory spins up an isolate via the
  // parent Worker's LOADER binding and talks to BROWSER directly, so
  // the container is uninvolved. The worker registers the same tools on
  // the Sandbox DO; see `src/microvm/sandbox.ts`.
  const microvmPowerTools = useMemo(
    () => toolCatalog.isolatePower.filter((t) => t.microvmEligible),
    [toolCatalog],
  );

  const catalog: ToolCatalogEntry[] = useMemo(() => {
    const base =
      backend === "isolate"
        ? [
            ...toolCatalog.isolateWorkspace,
            ...toolCatalog.isolatePower,
            ...toolCatalog.cfTools,
          ]
        : [...toolCatalog.microvmStock, ...microvmPowerTools, ...toolCatalog.cfTools];
    return [...base, ...toolCatalog.custom].map(annotate);
  }, [backend, toolCatalog, microvmPowerTools]);

  // Server-side tools share the same toolset wrapper as MicroVM
  // filesystem tools (agent_toolset_20260401) on the wire, so we
  // serialise them together. Computed here so save() and the form
  // both reach for the same source of truth.
  const serverSideNames = useMemo(
    () => toolCatalog.serverSide.map((t) => t.name),
    [toolCatalog],
  );

  // Names that ride the `agent_toolset_20260401` wrapper on MicroVM —
  // stock filesystem/bash tools + server-side tools. The save() path
  // uses this to decide whether each catalog entry rides the wrapper
  // or becomes a `type: "custom"` entry alongside it.
  const microvmStockNames = useMemo(
    () => new Set([...toolCatalog.microvmStock, ...toolCatalog.serverSide].map((t) => t.name)),
    [toolCatalog],
  );

  // Default selection: every tool in the current backend's catalog
  // EXCEPT server-side tools (those need an explicit opt-in). Applied
  // on first catalog load when we're creating a new agent, and on
  // backend switches. We skip if the agentId is set — the edit flow
  // pulls the stored selection out of the saved agent payload below.
  useEffect(() => {
    if (!catalogLoaded || agentId) return;
    const all =
      backend === "isolate"
        ? [
            ...toolCatalog.isolateWorkspace,
            ...toolCatalog.isolatePower,
            ...toolCatalog.cfTools,
            ...toolCatalog.custom,
          ]
        : [
            ...toolCatalog.microvmStock,
            ...microvmPowerTools,
            ...toolCatalog.cfTools,
            ...toolCatalog.custom,
          ];
    setTools(new Set(all.map((t) => t.name)));
  }, [catalogLoaded, backend, toolCatalog, microvmPowerTools, agentId]);

  useEffect(() => {
    if (!agentId) {
      // New agent: pre-fill the relevant defaults preamble so users see
      // a working baseline they can edit. Default-on for both backends;
      // unchecking the box strips the preamble out.
      toggleDefaults(backend, true).catch(() => {});
      return;
    }
    Promise.all([
      api.agent(agentId),
      api.agentBackend(agentId).catch(() => null),
    ])
      .then(async ([a, b]) => {
        setName(a.name || "");
        setModel(modelId(a.model) || "claude-sonnet-4-6");
        const resolvedBackend: AgentBackend = b?.backend === "isolate" ? "isolate" : "microvm";
        setBackend(resolvedBackend);

        // Detect whether the saved system prompt starts with the
        // canonical defaults block for its backend so the matching
        // checkbox reflects reality on edit.
        const stored = a.system || "";
        try {
          const defaults = await fetchDefaults(resolvedBackend);
          if (stored.startsWith(defaults)) {
            if (resolvedBackend === "isolate") setIncludeIsolateDefaults(true);
            else setIncludeMicrovmDefaults(true);
          }
        } catch {
          // Defaults endpoint is non-critical; fall through with the
          // stored prompt as-is.
        }
        setSystemPrompt(stored);

        // The toolset wrapper carries server-side tools for both
        // backends. Read them up front so we can preserve the user's
        // opt-in state across edits.
        const ts = (a.tools || []).find((t) => t.type === "agent_toolset_20260401");
        const enabledServerSide = new Set<string>();
        if (ts) {
          const defaultEnabled =
            ts.default_config && (ts.default_config.enabled ?? true) !== false;
          const explicitConfigs = ts.configs || [];
          for (const name of serverSideNames) {
            const cfg = explicitConfigs.find((c) => c.name === name);
            // Toolset default is on; only explicit `enabled: false` turns
            // a tool off. We treat absence as "use the default".
            const enabled =
              cfg?.enabled === false
                ? false
                : cfg?.enabled === true
                  ? true
                  : defaultEnabled;
            if (enabled) enabledServerSide.add(name);
          }
        }

        // Both backends now express custom tools (cf_*, user-defined,
        // and on Isolate also cf_*) as `type: "custom"` entries
        // in the upstream payload. We don't filter against any
        // hardcoded catalog — the form's catalog memo controls which
        // checkboxes exist, so unknown names simply have nothing to
        // render against.
        const customNames = new Set(
          (a.tools || [])
            .filter((t) => t.type === "custom" && typeof t.name === "string")
            .map((t) => t.name as string),
        );

        if (resolvedBackend === "isolate") {
          // Isolate has no stock toolset — everything is custom.
          setTools(new Set([...customNames, ...enabledServerSide]));
        } else {
          // MicroVM: stock toolset wrapper is default-enabled; honour
          // explicit `enabled: false` to disable individual stock
          // tools. Custom tools come straight from the type:"custom"
          // entries.
          const disabled = ts
            ? (ts.configs || []).filter((c) => c.enabled === false).map((c) => c.name)
            : [];
          const stockNames = toolCatalog.microvmStock.map((t) => t.name);
          setTools(
            new Set([
              ...stockNames.filter((t) => !disabled.includes(t)),
              ...customNames,
              ...enabledServerSide,
            ]),
          );
        }
      })
      .catch((err: Error) => push(err.message, "error"));
  }, [agentId, push]);

  // Reset catalog selection on backend switch — it's safer than mapping
  // by name since "read" etc. mean different things across backends.
  // Server-side toggles (web_fetch / web_search) are preserved because
  // they're identical across backends. Switching backends also swaps
  // the defaults preamble — strip the previous backend's block and
  // apply the new one. Without this, an isolate→microvm switch would
  // leave the Isolate preamble in place and the user wouldn't see the
  // MicroVM-specific guidance.
  const onBackendChange = (next: AgentBackend) => {
    const prevBackend = backend;
    setBackend(next);
    const allTools =
      next === "isolate"
        ? [
            ...toolCatalog.isolateWorkspace,
            ...toolCatalog.isolatePower,
            ...toolCatalog.cfTools,
            ...toolCatalog.custom,
          ]
        : [
            ...toolCatalog.microvmStock,
            ...microvmPowerTools,
            ...toolCatalog.cfTools,
            ...toolCatalog.custom,
          ];
    setTools((prev) => {
      const carry = serverSideNames.filter((n) => prev.has(n));
      return new Set([...allTools.map((t) => t.name), ...carry]);
    });
    // Strip the old backend's defaults preamble (if present), then
    // apply the new one. Skip the strip when neither defaults box was
    // checked so we don't touch a user's hand-written prompt.
    (async () => {
      if (prevBackend !== next) {
        if (prevBackend === "isolate" && includeIsolateDefaults) {
          await toggleDefaults("isolate", false);
        } else if (prevBackend === "microvm" && includeMicrovmDefaults) {
          await toggleDefaults("microvm", false);
        }
      }
      const alreadyOn =
        next === "isolate" ? includeIsolateDefaults : includeMicrovmDefaults;
      if (!alreadyOn) await toggleDefaults(next, true);
    })().catch(() => {});
  };

  const save = async () => {
    if (!name.trim()) {
      push("Agent name is required.", "error");
      return;
    }
    // Both backends use `type: "custom"` entries for cf_* + user-
    // defined tools. The worker re-hydrates description / schema from
    // the registry on save, so we only need to carry tool NAMES on the
    // wire here. For MicroVM, stock tools (bash/read/etc.) ride the
    // `agent_toolset_20260401` wrapper handled by the SDK's in-
    // container dispatcher; for Isolate, the wrapper is stripped
    // server-side and the dispatcher reads `type: "custom"` entries
    // back.
    const catalogChecked = catalog.map((t) => t.name).filter((n) => tools.has(n));
    const catalogUnchecked = catalog.map((t) => t.name).filter((n) => !tools.has(n));
    const serverSideEnabled = serverSideNames.filter((n) => tools.has(n));
    const serverSideDisabled = serverSideNames.filter((n) => !tools.has(n));

    const toolPayload: Array<Record<string, unknown>> = [];

    if (
      catalogChecked.length > 0 ||
      serverSideEnabled.length > 0 ||
      // Always emit the toolset wrapper for MicroVM agents so the
      // toolset's stock tools follow our default-on semantics. For
      // Isolate agents the wrapper is only added when there's actually
      // something to wire (server-side opt-in).
      backend === "microvm"
    ) {
      const toolset: Record<string, unknown> = {
        type: "agent_toolset_20260401",
        default_config:
          backend === "microvm"
            ? { enabled: true, permission_policy: { type: "always_allow" } }
            : // Isolate: the dispatcher implements its own custom
              // tools; the toolset wrapper is here only to carry
              // server-side tools, so default-disable everything else.
              { enabled: false, permission_policy: { type: "always_allow" } },
      };
      const configs: Array<{ name: string; enabled: boolean }> = [];
      if (backend === "microvm") {
        // MicroVM: explicit disables for unchecked stock tools only.
        // Custom names (cf_*, user-defined) go in separate `type:
        // "custom"` entries emitted below.
        for (const n of catalogUnchecked) {
          if (microvmStockNames.has(n)) configs.push({ name: n, enabled: false });
        }
      } else {
        // Isolate: the wrapper itself is stripped server-side — the
        // dispatcher's customs replace it. We emit explicit
        // `enabled: false` for every unchecked name so the worker's
        // `readEnabledIsolateTools` knows what to subtract from the
        // default-on catalog. (Also defensive belt-and-braces: a
        // naive consumer that doesn't strip the wrapper still sees
        // unchecked items off.)
        for (const n of catalogUnchecked) configs.push({ name: n, enabled: false });
      }
      // Server-side toggles — explicit on both ways so the worker's
      // safe-default doesn't fire and so the stored agent reflects
      // the user's choice.
      for (const n of serverSideEnabled) configs.push({ name: n, enabled: true });
      for (const n of serverSideDisabled) configs.push({ name: n, enabled: false });
      if (configs.length > 0) toolset.configs = configs;
      toolPayload.push(toolset);
    }

    // Emit `type: "custom"` entries for every checked custom tool. The
    // worker fills in the description / input_schema from the registry,
    // so the placeholder fields here are minimal.
    if (backend === "microvm") {
      // MicroVM customs = catalog entries that aren't stock names
      // (cf_* + user-defined customs).
      for (const n of catalogChecked) {
        if (microvmStockNames.has(n)) continue;
        toolPayload.push({ type: "custom", name: n });
      }
    } else {
      // Isolate: every checked catalog entry is a custom. The worker's
      // readEnabledIsolateTools reads from `agent_toolset_20260401.configs`
      // — we already populate it above — so we don't ALSO need to emit
      // type:"custom" entries here. (The worker emits those itself
      // server-side via `buildIsolateAgentTools`.)
    }

    // `backend` is stripped server-side before forwarding to Anthropic and
    // persisted in our local agent_backends D1 table by the API handler.
    const body: Record<string, unknown> = { name, model, tools: toolPayload, backend };
    if (systemPrompt.trim()) body.system = systemPrompt.trim();
    try {
      const data = await api.saveAgent(agentId || null, body);
      push(`Agent ${agentId ? "updated" : "created"}: ${data.id}`);
      navigate({ kind: "agent-detail", agentId: data.id });
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  const toggleTool = (n: string) => {
    setTools((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };

  return (
    <>
      <AppBreadcrumbs
        navigate={navigate}
        items={[{ label: "Agents", view: { kind: "agents" } }]}
        current={agentId ? "Edit" : "New"}
      />

      <PageHeader
        icon={Robot}
        title={agentId ? "Edit Agent" : "New Agent"}
        description="Define how an agent reasons and which tools it can use."
      />

      <Section>
        <div className="field-stack">
          <Input
            label="Name"
            placeholder="My Agent"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select label="Model" value={model} onValueChange={(v) => setModel(v as string)}>
            {MODELS.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
          <Select
            label="Backend"
            value={backend}
            onValueChange={(v) => onBackendChange(v as AgentBackend)}
          >
            <Select.Option value="microvm">MicroVM Sandbox (container)</Select.Option>
            <Select.Option value="isolate">Isolate Sandbox (workspace DO)</Select.Option>
          </Select>
          <p className="muted" style={{ fontSize: "0.75rem", margin: "-0.5rem 0 0" }}>
            {backend === "microvm"
              ? "MicroVM Sandbox: full Linux container per session with bash + filesystem. Outbound HTTP passes through your egress policies."
              : "Isolate Sandbox: SQLite-backed workspace per session, no container, no shell. Tools run inside the Worker DO. Egress policies apply via the IsolateOutboundGateway."}
          </p>
          <div className="field">
            <label style={{ display: "block", marginBottom: "0.4rem" }}>System Prompt</label>
            <textarea
              className="proxy-textarea"
              rows={4}
              placeholder={
                backend === "isolate"
                  ? "You are a helpful coding agent. The Isolate Sandbox defaults are inserted above — uncheck below to remove them."
                  : "You are a helpful coding agent. The MicroVM Sandbox defaults are inserted above — uncheck below to remove them."
              }
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
            <label
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "flex-start",
                marginTop: "0.5rem",
                cursor: "pointer",
              }}
            >
              <Checkbox
                checked={
                  backend === "isolate"
                    ? includeIsolateDefaults
                    : includeMicrovmDefaults
                }
                onCheckedChange={(v) => toggleDefaults(backend, Boolean(v))}
              />
              <div>
                <div style={{ fontSize: "0.8125rem" }}>
                  {backend === "isolate"
                    ? "Include Isolate Sandbox defaults"
                    : "Include MicroVM Sandbox defaults"}
                </div>
                <div className="muted" style={{ fontSize: "0.7rem" }}>
                  {backend === "isolate"
                    ? "Prepend the recommended preamble (calling convention, workspace behaviour, codemode tips). Uncheck to remove."
                    : "Prepend the recommended preamble (workspace persistence, $ANTHROPIC_SESSION_ID, cf_* tool guidance). Uncheck to remove."}
                </div>
              </div>
            </label>
          </div>
          <div className="field">
            <label>Tools</label>
            <p className="muted" style={{ fontSize: "0.75rem", margin: "0 0 0.5rem" }}>
              {backend === "microvm"
                ? "MicroVM Sandbox tools. Stock tools (bash / read / write / etc.) run in the container; cf_* tools and any user-defined customs run in the Worker DO with direct binding access."
                : "Isolate Sandbox tools. Workspace + power tools run inside the IsolateRunner DO; cf_* tools call Worker bindings directly. No shell, no container."}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
              {catalog.map((t) => (
                <label
                  key={t.name}
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "flex-start",
                    padding: "0.5rem 0.65rem",
                    background: "var(--color-kumo-recessed)",
                    border: "1px solid var(--color-kumo-fill)",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  <Checkbox checked={tools.has(t.name)} onCheckedChange={() => toggleTool(t.name)} />
                  <div>
                    <div className="mono" style={{ fontSize: "0.8125rem" }}>{t.displayName}</div>
                    <div className="muted" style={{ fontSize: "0.7rem" }}>{t.description}</div>
                  </div>
                </label>
              ))}
            </div>
            <div
              style={{
                marginTop: "0.85rem",
                padding: "0.65rem 0.75rem",
                background: "var(--color-kumo-warning-bg, var(--color-kumo-recessed))",
                border: "1px solid var(--color-kumo-warning-border, var(--color-kumo-fill))",
                borderRadius: 8,
              }}
            >
              <p style={{ fontSize: "0.8125rem", margin: 0, fontWeight: 600 }}>
                Server-side tools (Anthropic-hosted)
              </p>
              <p
                className="muted"
                style={{ fontSize: "0.7rem", margin: "0.25rem 0 0.5rem" }}
              >
                These run on Anthropic's infrastructure, not inside your sandbox. Their
                requests <strong>bypass your egress policy entirely</strong> — allow / deny
                lists, header injection, VPC routes, and the dynamic-Worker proxy never see
                them. Disabled by default; enable per-agent only when you explicitly want
                that. Prefer <span className="mono">cf_web_fetch</span> when configured —
                it routes through your account, is governed by your egress policy, and
                renders JS-heavy pages correctly.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                {toolCatalog.serverSide.map((t) => (
                  <label
                    key={t.name}
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "flex-start",
                      padding: "0.5rem 0.65rem",
                      background: "var(--color-kumo-canvas, var(--color-kumo-recessed))",
                      border: "1px solid var(--color-kumo-fill)",
                      borderRadius: 8,
                      cursor: "pointer",
                    }}
                  >
                    <Checkbox
                      checked={tools.has(t.name)}
                      onCheckedChange={() => toggleTool(t.name)}
                    />
                    <div>
                      <div className="mono" style={{ fontSize: "0.8125rem" }}>
                        {t.displayName}
                      </div>
                      <div className="muted" style={{ fontSize: "0.7rem" }}>
                        {t.description}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="actions">
            <Button variant="primary" onClick={save}>
              Save Agent
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                agentId ? navigate({ kind: "agent-detail", agentId }) : navigate({ kind: "agents" })
              }
            >
              Cancel
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
