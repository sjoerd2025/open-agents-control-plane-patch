import { useCallback, useEffect, useState } from "react";
import { Robot, ArrowsClockwise, Plus, ArrowSquareOut } from "@phosphor-icons/react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { api, type AnthropicAgent } from "../api";
import { BackendChip } from "../components/BackendChip";
import { claudeAgentUrl, claudeAgentsIndexUrl, modelId } from "../utils";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import type { View } from "../App";
import { useToasts } from "../toasts";

export function AgentsView({ navigate }: { navigate: (v: View) => void }) {
  const { push } = useToasts();
  const [items, setItems] = useState<AnthropicAgent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.agents();
      setItems(data.data || []);
    } catch (err) {
      push((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <PageHeader
        icon={Robot}
        title="Agents"
        description="Reusable agent definitions: model, system prompt, and tool selection."
        actions={
          <>
            <LinkButton
              variant="secondary"
              size="sm"
              icon={ArrowSquareOut}
              href={claudeAgentsIndexUrl()}
              external
            >
              Claude Agents
            </LinkButton>
            <Button variant="secondary" size="sm" icon={ArrowsClockwise} onClick={load} loading={loading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" icon={Plus} onClick={() => navigate({ kind: "agent-form" })}>
              New Agent
            </Button>
          </>
        }
      />

      <Section>
        {loading && items.length === 0 ? (
          <div className="empty-state">Loading...</div>
        ) : items.length === 0 ? (
          <Empty
            title="Create an Agent to get started"
            description="Agents define the model, system prompt, and tools for your sessions."
            contents={
              <Button variant="primary" onClick={() => navigate({ kind: "agent-form" })}>
                Create Your First Agent
              </Button>
            }
          />
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Backend</th>
                <th>Model</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr
                  key={a.id}
                  className="clickable"
                  onClick={() => navigate({ kind: "agent-detail", agentId: a.id })}
                >
                  <td>
                    <span className="row-title">
                      <strong>{a.name}</strong>
                      <a
                        href={claudeAgentUrl(a.id)}
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
                    <BackendChip backend={a.backend ?? "microvm"} />
                  </td>
                  <td className="mono">{modelId(a.model)}</td>
                  <td className="mono" title={a.id}>
                    {a.id}
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
