import { useCallback, useEffect, useState } from "react";
import { Robot, PencilSimple, Plus, ArrowSquareOut, ShieldCheck } from "@phosphor-icons/react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { AppBreadcrumbs } from "../components/AppBreadcrumbs";
import {
  api,
  type AnthropicAgent,
  type AnthropicSession,
  type EgressPolicy,
} from "../api";
import { claudeAgentUrl, claudeSessionUrl, modelId } from "../utils";
import { BackendChip } from "../components/BackendChip";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { StatusBadge } from "../components/StatusBadge";
import type { View } from "../App";
import { useToasts } from "../toasts";

// Identify policies scoped to a specific agent via the canonical matcher
// the EgressView form writes. Centralised here so the visible/link logic
// in AgentDetailView stays in sync with the picker — both call this.
function policyIsLinkedToAgent(policy: EgressPolicy, agentId: string): boolean {
  if (policy.appliesToAll) return false;
  if (policy.applyTo.length !== 1) return false;
  const [m] = policy.applyTo;
  return (
    m.field === "agent_id" && m.operator === "equals" && m.value === agentId
  );
}

export function AgentDetailView({ agentId, navigate }: { agentId: string; navigate: (v: View) => void }) {
  const { push } = useToasts();
  const [agent, setAgent] = useState<AnthropicAgent | null>(null);
  const [sessions, setSessions] = useState<AnthropicSession[]>([]);
  // Egress policies linked to this agent. Fetched alongside the agent so
  // a user looking at the detail page can immediately see what's scoped
  // to them without having to flip over to the Egress index.
  const [linkedPolicies, setLinkedPolicies] = useState<EgressPolicy[]>([]);

  const load = useCallback(async () => {
    try {
      const a = await api.agent(agentId);
      setAgent(a);
      const s = await api.sessions();
      setSessions((s.data || []).filter((x) => x.agent?.id === agentId));
      // Best-effort — policies are non-critical for the rest of the page.
      try {
        const policies = await api.listPolicies();
        setLinkedPolicies(
          (policies.items || []).filter((p) => policyIsLinkedToAgent(p, agentId)),
        );
      } catch {
        setLinkedPolicies([]);
      }
    } catch (err) {
      push((err as Error).message, "error");
    }
  }, [agentId, push]);

  useEffect(() => {
    load();
  }, [load]);

  const startSession = async () => {
    if (!agent) return;
    try {
      const s = await api.createSession({
        agent: { type: "agent", id: agent.id, version: agent.version },
        title: `${agent.name} - ${new Date().toLocaleString()}`,
      });
      push(`Session created: ${s.id}`);
      navigate({ kind: "session-detail", sessionId: s.id });
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  if (!agent) {
    return (
      <>
        <AppBreadcrumbs
          navigate={navigate}
          items={[{ label: "Agents", view: { kind: "agents" } }]}
          current={agentId}
        />
        <Section>
          <div className="empty-state">Loading...</div>
        </Section>
      </>
    );
  }

  // Tool list rendering depends on the backend:
  //   - microvm agents wrap their tools in `agent_toolset_20260401`; we
  //     compute `enabled` by subtracting explicitly-disabled configs.
  //   - isolate agents store each tool as a custom tool entry; we just
  //     list the names directly.
  const backend = agent.backend ?? "microvm";
  let enabledTools: string[] = [];
  let disabledTools: string[] = [];
  if (backend === "isolate") {
    enabledTools = (agent.tools || [])
      .filter((t) => t.type === "custom" && typeof t.name === "string")
      .map((t) => t.name as string);
  } else {
    const toolset = (agent.tools || []).find((t) => t.type === "agent_toolset_20260401");
    disabledTools = toolset
      ? (toolset.configs || []).filter((c) => c.enabled === false).map((c) => c.name)
      : [];
    const allTools = ["bash", "edit", "read", "write", "glob", "grep", "web_fetch", "web_search"];
    enabledTools = allTools.filter((t) => !disabledTools.includes(t));
  }

  return (
    <>
      <AppBreadcrumbs
        navigate={navigate}
        items={[{ label: "Agents", view: { kind: "agents" } }]}
        current={agent.name}
      />

      <PageHeader
        icon={Robot}
        title={agent.name}
        description={<span className="mono">{modelId(agent.model)}</span>}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate({ kind: "agents" })}>
              Back
            </Button>
            <LinkButton
              variant="secondary"
              size="sm"
              icon={ArrowSquareOut}
              href={claudeAgentUrl(agent.id)}
              external
              title="Open this agent in the Claude Platform"
            >
              Open in Claude
            </LinkButton>
            <Button
              variant="secondary"
              size="sm"
              icon={PencilSimple}
              onClick={() => navigate({ kind: "agent-form", agentId: agent.id })}
            >
              Edit
            </Button>
            <Button variant="primary" size="sm" icon={Plus} onClick={startSession}>
              New Session
            </Button>
          </>
        }
      />

      <Section title="Details">
        <div className="detail-list">
          <div className="row">
            <div className="label">ID</div>
            <div className="value mono">{agent.id}</div>
          </div>
          <div className="row">
            <div className="label">Backend</div>
            <div className="value">
              <BackendChip backend={backend} />
            </div>
          </div>
          <div className="row">
            <div className="label">Version</div>
            <div className="value mono">{agent.version}</div>
          </div>
          <div className="row">
            <div className="label">Model</div>
            <div className="value">{modelId(agent.model)}</div>
          </div>
        </div>
      </Section>

      <Section title="System Prompt">
        <div className="json-viewer" style={{ whiteSpace: "pre-wrap" }}>
          {agent.system || "(none)"}
        </div>
      </Section>

      <Section title="Tools">
        <div className="tag-list">
          {enabledTools.length === 0 ? (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              (no tools)
            </span>
          ) : (
            enabledTools.map((t) => (
              <span key={t} className="tag-chip">
                {/* Show the wire name verbatim so it matches the system
                    prompt and the model's call sites. `cf_` only sticks
                    around on names that would otherwise clash with
                    Anthropic-reserved built-ins (cf_read / cf_write /
                    cf_edit / cf_grep / cf_web_fetch). */}
                {t}
              </span>
            ))
          )}
          {disabledTools.length > 0 && (
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              ({disabledTools.join(", ")} disabled)
            </span>
          )}
        </div>
      </Section>

      <Section
        title="Egress Policies"
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={ShieldCheck}
            onClick={() => navigate({ kind: "egress" })}
          >
            Manage
          </Button>
        }
      >
        {linkedPolicies.length === 0 ? (
          <div className="muted" style={{ fontSize: "0.8125rem" }}>
            No policies are scoped to this agent. Open the Egress Policies
            page and use the "Apply to agent" picker on a policy to link it
            here.
          </div>
        ) : (
          <div className="tag-list">
            {linkedPolicies.map((p) => (
              <span key={p.id} className="tag-chip" title={p.id}>
                {p.name}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="Sessions" actions={<Button variant="ghost" size="sm" onClick={load}>Refresh</Button>}>
        {sessions.length === 0 ? (
          <div className="empty-state">No sessions yet</div>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.id}
                  className="clickable"
                  onClick={() => navigate({ kind: "session-detail", sessionId: s.id })}
                >
                  <td>
                    <span className="row-title">
                      {s.title || "(untitled)"}
                      <a
                        href={claudeSessionUrl(s.id)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="row-external"
                        aria-label="Open in Claude Platform"
                        title="Open in Claude Platform"
                      >
                        <ArrowSquareOut size={13} />
                      </a>
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={s.status} kind="session" />
                  </td>
                  <td className="mono" title={s.id}>
                    {s.id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
