import { useCallback, useEffect, useState } from "react";
import { ChatCircleText, ArrowsClockwise, Archive, ArrowSquareOut } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { AppBreadcrumbs } from "../components/AppBreadcrumbs";
import { BackendChip } from "../components/BackendChip";
import { CopyButton } from "../components/CopyButton";
import { api, type AgentBackend, type AnthropicEvent, type AnthropicSession } from "../api";
import { claudeSessionUrl, relTime } from "../utils";
import { routeTo } from "../routes";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { StatusBadge } from "../components/StatusBadge";
import type { View } from "../App";
import { useToasts } from "../toasts";

export function SessionDetailView({ sessionId, navigate }: { sessionId: string; navigate: (v: View) => void }) {
  const { push } = useToasts();
  const [session, setSession] = useState<AnthropicSession | null>(null);
  const [agentBackend, setAgentBackend] = useState<AgentBackend | null>(null);
  const [events, setEvents] = useState<AnthropicEvent[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const loadEvents = useCallback(async () => {
    try {
      const data = await api.sessionEvents(sessionId);
      setEvents(data.data || []);
    } catch (err) {
      push((err as Error).message, "error");
    }
  }, [sessionId, push]);

  const load = useCallback(async () => {
    try {
      const s = await api.session(sessionId);
      setSession(s);
      loadEvents();
    } catch (err) {
      push((err as Error).message, "error");
    }
  }, [sessionId, push, loadEvents]);

  useEffect(() => {
    load();
  }, [load]);

  // Resolve the agent's backend (MicroVM vs Isolate) for the chip next to
  // the agent link. Errors are swallowed — the chip just won't render.
  useEffect(() => {
    const agentId = session?.agent?.id;
    if (!agentId) return;
    let cancelled = false;
    api
      .agentBackend(agentId)
      .then((res) => {
        if (!cancelled) setAgentBackend(res.backend);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session?.agent?.id]);

  const send = async () => {
    if (!message.trim() || !session) return;
    setSending(true);
    try {
      await api.sendSessionMessage(sessionId, message.trim());
      push(`Message sent to session ${sessionId}`);
      setMessage("");
      setTimeout(loadEvents, 2000);
    } catch (err) {
      push((err as Error).message, "error");
    } finally {
      setSending(false);
    }
  };

  const archive = async () => {
    if (!confirm("Archive this session? This is not reversible.")) return;
    try {
      await api.archiveSession(sessionId);
      push(`Session ${sessionId} archived`);
      load();
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  if (!session) {
    return (
      <>
        <AppBreadcrumbs
          navigate={navigate}
          items={[{ label: "Sessions", view: { kind: "sessions" } }]}
          current={sessionId}
        />
        <Section>
          <div className="empty-state">Loading...</div>
        </Section>
      </>
    );
  }

  const canSteer = ["idle", "running", "pending"].includes(session.status);

  return (
    <>
      <AppBreadcrumbs
        navigate={navigate}
        items={[{ label: "Sessions", view: { kind: "sessions" } }]}
        current={session.title || sessionId}
      />

      <PageHeader
        icon={ChatCircleText}
        title={session.title || "(untitled)"}
        description={<span className="mono">{session.id}</span>}
        actions={
          <>
            <StatusBadge status={session.status} kind="session" />
            <LinkButton
              variant="secondary"
              size="sm"
              icon={ArrowSquareOut}
              href={claudeSessionUrl(session.id)}
              external
              title="Open this session in the Claude Platform"
            >
              Open in Claude
            </LinkButton>
            <Button variant="secondary-destructive" size="sm" icon={Archive} onClick={archive}>
              Archive
            </Button>
          </>
        }
      />

      <Section title="Details">
        <div className="detail-list">
          <div className="row">
            <div className="label">ID</div>
            <div className="value mono">{session.id}</div>
          </div>
          <div className="row">
            <div className="label">Sandbox</div>
            <div className="value mono">
              <Link
                to={routeTo({ kind: "env-detail", sessionId: session.id })}
                title="Open sandbox details"
              >
                {session.id}
              </Link>
            </div>
          </div>
          <div className="row">
            <div className="label">Agent</div>
            <div className="value mono" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {session.agent?.id ? (
                <>
                  <Link
                    to={routeTo({ kind: "agent-detail", agentId: session.agent.id })}
                    title="Open agent details"
                  >
                    {session.agent.name || session.agent.id}
                  </Link>
                  {agentBackend && <BackendChip backend={agentBackend} />}
                </>
              ) : (
                "—"
              )}
            </div>
          </div>
          <div className="row">
            <div className="label">Created</div>
            <div
              className="value"
              title={session.created_at ? new Date(session.created_at).toLocaleString() : ""}
            >
              {session.created_at ? relTime(session.created_at) : "—"}
            </div>
          </div>
          <div className="row">
            <div className="label">Updated</div>
            <div
              className="value"
              title={session.updated_at ? new Date(session.updated_at).toLocaleString() : ""}
            >
              {session.updated_at ? relTime(session.updated_at) : "—"}
            </div>
          </div>
        </div>
      </Section>

      {canSteer && (
        <Section title="Send Message" description="Steer the agent with a follow-up message.">
          <textarea
            className="proxy-textarea send-message"
            rows={2}
            placeholder="Type a message to steer the agent..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="actions" style={{ marginTop: "0.5rem", justifyContent: "flex-end" }}>
            <span className="muted" style={{ fontSize: "0.7rem" }}>⌘/Ctrl + Enter to send</span>
            <Button variant="primary" size="sm" onClick={send} loading={sending}>
              Send
            </Button>
          </div>
        </Section>
      )}

      <Section
        title="Events"
        actions={
          <>
            {events.length > 0 && (
              <CopyButton
                text={() => JSON.stringify(events, null, 2)}
                label="Copy all"
                copiedLabel="Copied!"
                title="Copy the full events array as JSON"
              />
            )}
            <Button variant="ghost" size="sm" icon={ArrowsClockwise} onClick={loadEvents}>
              Refresh
            </Button>
          </>
        }
      >
        {events.length === 0 ? (
          <div className="empty-state">No events yet. Send a message to get started.</div>
        ) : (
          <div>
            {events.map((ev, i) => {
              const isExpanded = expanded.has(i);
              const text = (ev.content || []).find((b) => b.type === "text")?.text || "";
              // Surface tool names at the top level so the user can scan
              // the event list without expanding each row. We look in two
              // places:
              //   1. Older shape — ev.type itself is `tool_use` and the
              //      tool name is on ev.name.
              //   2. Newer agent-event shape — ev.type is e.g.
              //      `agent.message_added` and the tool_use / tool_result
              //      lives inside ev.content[].
              const toolBlocks: Array<{
                kind: "use" | "result";
                name?: string;
                isError?: boolean;
              }> = [];
              if (ev.type === "tool_use") {
                toolBlocks.push({ kind: "use", name: ev.name });
              }
              for (const block of ev.content || []) {
                if (block.type === "tool_use") {
                  toolBlocks.push({ kind: "use", name: block.name });
                } else if (block.type === "tool_result") {
                  toolBlocks.push({ kind: "result", isError: block.is_error });
                }
              }
              const summary =
                ev.type === "tool_use"
                  ? JSON.stringify(ev.input).substring(0, 100)
                  : ev.type === "error"
                  ? ev.error?.message || "(error)"
                  : text.substring(0, 200);
              // The tool-name pill already conveys "this is a tool_use",
              // so suppress the redundant event-type badge in that case.
              // Newer-shape events (agent.message_added, etc.) still get
              // the type badge — they're not self-describing.
              const showTypeBadge = ev.type !== "tool_use";
              const time = ev.created_at ? new Date(ev.created_at).toLocaleTimeString() : "";
              return (
                <div
                  key={i}
                  className="event-row"
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                >
                  <div className="event-summary">
                    {showTypeBadge && <Badge variant="secondary">{ev.type}</Badge>}
                    {/* Tool-use / tool-result pills surface the tool name
                        and (for results) error state without making the
                        user pop the row open. Multiple pills appear when
                        a single agent message carries several blocks. */}
                    {toolBlocks.map((tb, j) => (
                      <Badge
                        key={j}
                        variant={tb.isError ? "error" : tb.kind === "use" ? "primary" : "success"}
                      >
                        {tb.kind === "use"
                          ? `🔧 ${tb.name || "(unnamed)"}`
                          : tb.isError
                            ? "✗ result"
                            : "✓ result"}
                      </Badge>
                    ))}
                    <CopyButton
                      compact
                      text={() => JSON.stringify(ev, null, 2)}
                      label="Copy"
                      copiedLabel="Copied"
                      title="Copy this event as JSON"
                    />
                    <span style={{ flex: 1 }}>{summary}</span>
                    <span className="muted mono" style={{ fontSize: "0.7rem" }}>{time}</span>
                  </div>
                  {isExpanded && (
                    // Stop click propagation so highlighting / selecting JSON
                    // text inside the viewer doesn't trigger the row's
                    // collapse handler. Without this, every click while
                    // dragging to select text snaps the row shut.
                    <div className="event-detail" onClick={(e) => e.stopPropagation()}>
                      <div className="json-viewer">{JSON.stringify(ev, null, 2)}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}
