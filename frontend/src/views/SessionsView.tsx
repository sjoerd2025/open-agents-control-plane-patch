import { useCallback, useEffect, useState } from "react";
import {
  ChatCircleText,
  ArrowsClockwise,
  Plus,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Select } from "@cloudflare/kumo/components/select";
import { api, type AgentBackend, type AnthropicSession } from "../api";
import { BackendChip } from "../components/BackendChip";
import { claudeSessionUrl, relTime } from "../utils";
import { routeTo } from "../routes";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { StatusBadge } from "../components/StatusBadge";
import type { View } from "../App";
import { useToasts } from "../toasts";

// Backend filter values for the index dropdown. "all" sends no `backend`
// query param so the worker returns every session.
type BackendFilter = "all" | AgentBackend;

export function SessionsView({ navigate }: { navigate: (v: View) => void }) {
  const { push } = useToasts();
  const [items, setItems] = useState<AnthropicSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [backendFilter, setBackendFilter] = useState<BackendFilter>("all");

  const load = useCallback(
    async (filter: BackendFilter) => {
      setLoading(true);
      try {
        const data = await api.sessions(filter === "all" ? undefined : filter);
        setItems(data.data || []);
      } catch (err) {
        push((err as Error).message, "error");
      } finally {
        setLoading(false);
      }
    },
    [push],
  );

  useEffect(() => {
    load(backendFilter);
  }, [load, backendFilter]);

  return (
    <>
      <PageHeader
        icon={ChatCircleText}
        title="Sessions"
        description="Claude Managed Agent sessions tied to a specific agent and environment."
        actions={
          <>
            <Select
              size="sm"
              value={backendFilter}
              onValueChange={(v) => setBackendFilter(v as BackendFilter)}
              aria-label="Filter by backend"
            >
              <Select.Option value="all">All backends</Select.Option>
              <Select.Option value="microvm">MicroVM</Select.Option>
              <Select.Option value="isolate">Isolate</Select.Option>
            </Select>
            <Button
              variant="secondary"
              size="sm"
              icon={ArrowsClockwise}
              onClick={() => load(backendFilter)}
              loading={loading}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={Plus}
              onClick={() => navigate({ kind: "session-form" })}
            >
              New Session
            </Button>
          </>
        }
      />

      <Section>
        {loading && items.length === 0 ? (
          <div className="empty-state">Loading...</div>
        ) : items.length === 0 ? (
          <Empty
            title="No sessions yet"
            description={
              backendFilter === "all"
                ? "Create a session to start interacting with an agent."
                : `No ${backendFilter} sessions match the current filter.`
            }
            contents={
              <Button
                variant="primary"
                onClick={() => navigate({ kind: "session-form" })}
              >
                Create Session
              </Button>
            }
          />
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Backend</th>
                <th>Agent</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr
                  key={s.id}
                  className="clickable"
                  onClick={() =>
                    navigate({ kind: "session-detail", sessionId: s.id })
                  }
                >
                  <td>
                    <span className="row-title">
                      <strong>{s.title || "(untitled)"}</strong>
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
                  <td>
                    <BackendChip backend={s.backend ?? "microvm"} />
                  </td>
                  <td className="mono" title={s.agent?.id || ""}>
                    {s.agent?.id ? (
                      <Link
                        to={routeTo({ kind: "agent-detail", agentId: s.agent.id })}
                        onClick={(e) => e.stopPropagation()}
                        title="Open agent details"
                      >
                        {s.agent.name || s.agent.id}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td
                    className="muted"
                    style={{ fontSize: "0.75rem" }}
                    title={
                      s.created_at
                        ? new Date(s.created_at).toLocaleString()
                        : ""
                    }
                  >
                    {relTime(s.created_at)}
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
