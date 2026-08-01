import { useEffect, useState, useCallback, useRef } from "react";
import { ArrowsClockwise, ArrowSquareOut, Plus, X } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { AppBreadcrumbs } from "../components/AppBreadcrumbs";
import { api, type AgentBackend } from "../api";
import { routeTo } from "../routes";
import { Section } from "../components/Section";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { ContainersIcon } from "../components/icons/ContainersIcon";
import { WorkspaceBrowser } from "../components/WorkspaceBrowser";
import type { View } from "../App";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useToasts } from "../toasts";

// Dashboard the "Open in dashboard" button points at. Isolate Sandboxes are
// backed by Durable Objects (the IsolateRunner DO), so MicroVM and Isolate
// sessions live in different sections of the Cloudflare dashboard.
const CONTAINERS_DASH_URL = "https://dash.cloudflare.com/workers/containers";
const DURABLE_OBJECTS_DASH_URL = "https://dash.cloudflare.com/workers/durable-objects";

interface Props {
  sessionId: string;
  navigate: (v: View) => void;
}

interface TerminalEntry {
  id: string;
  label: string;
}

export function EnvironmentDetailView({ sessionId, navigate }: Props) {
  const { push } = useToasts();
  const [status, setStatus] = useState<string>("loading");
  const [backend, setBackend] = useState<AgentBackend | null>(null);
  const [terms, setTerms] = useState<TerminalEntry[]>([]);
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  const counterRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const data = await api.environmentStatus(sessionId);
      setStatus(data.containerStatus);
      setBackend(data.backend ?? "microvm");
    } catch (err) {
      setStatus("unknown");
      push((err as Error).message, "error");
    }
  }, [sessionId, push]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const stop = async () => {
    try {
      await api.stopEnvironment(sessionId);
      push(`Stopped sandbox for ${sessionId}`);
      await refresh();
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  const addTerminal = () => {
    counterRef.current += 1;
    const id = `envterm-${counterRef.current}`;
    setTerms((prev) => [...prev, { id, label: `Shell ${counterRef.current}` }]);
    setActiveTermId(id);
  };

  const closeTerminal = (id: string) => {
    setTerms((prev) => {
      const remaining = prev.filter((t) => t.id !== id);
      setActiveTermId((cur) => (cur === id ? remaining[remaining.length - 1]?.id ?? null : cur));
      return remaining;
    });
  };

  const running = status === "running" || status === "healthy";

  return (
    <>
      <AppBreadcrumbs
        navigate={navigate}
        items={[{ label: "Sandboxes", view: { kind: "environments" } }]}
        current={sessionId}
      />

      <PageHeader
        icon={ContainersIcon}
        title={sessionId}
        description={
          backend === "isolate"
            ? "Isolate Sandbox DO backing this Anthropic session — SQLite-backed virtual filesystem, no shell."
            : "MicroVM Sandbox container backing a single Anthropic session."
        }
        actions={
          <>
            <StatusBadge status={status} kind="container" />
            <Button variant="ghost" size="sm" onClick={() => navigate({ kind: "environments" })}>
              Back
            </Button>
            <LinkButton
              variant="secondary"
              size="sm"
              icon={ArrowSquareOut}
              href={backend === "isolate" ? DURABLE_OBJECTS_DASH_URL : CONTAINERS_DASH_URL}
              external
              title={
                backend === "isolate"
                  ? "Open the Durable Objects dashboard — Isolate Sandboxes run inside the IsolateRunner DO"
                  : "Open the Containers dashboard"
              }
            >
              {backend === "isolate" ? "Durable Objects" : "Containers Dashboard"}
            </LinkButton>
            <Button
              variant="secondary"
              size="sm"
              icon={ArrowsClockwise}
              onClick={refresh}
            >
              Refresh
            </Button>
            <Button variant="destructive" size="sm" onClick={stop} disabled={!running}>
              Stop
            </Button>
          </>
        }
      />

      <Section title="Details">
        <div className="detail-list">
          <div className="row">
            <div className="label">Session ID</div>
            <div className="value mono">
              <Link
                to={routeTo({ kind: "session-detail", sessionId })}
                title="Open session"
              >
                {sessionId}
              </Link>
            </div>
          </div>
          <div className="row">
            <div className="label">Backend</div>
            <div className="value">{backend ?? "—"}</div>
          </div>
          <div className="row">
            <div className="label">{backend === "isolate" ? "Workspace" : "Container"}</div>
            <div className="value">{status}</div>
          </div>
        </div>
      </Section>

      {backend === "isolate" ? (
        <Section
          title="Workspace"
          description="Browse the SQLite-backed virtual filesystem. Files written by the agent (via cf_write / cf_edit, etc.) appear here."
        >
          <WorkspaceBrowser sessionId={sessionId} />
        </Section>
      ) : (
      <Section
        title="Terminal"
        description="Open one or more shells inside the container."
        actions={
          terms.length === 0 ? (
            <Button variant="primary" size="sm" icon={Plus} onClick={addTerminal}>
              New Terminal
            </Button>
          ) : null
        }
      >
        {terms.length === 0 ? (
          <div className="empty-state">
            Click <strong>New Terminal</strong> to open a shell in this container.
          </div>
        ) : (
          <>
            <div className="terminal-tabs">
              {terms.map((t) => (
                <div
                  key={t.id}
                  className={`terminal-tab ${activeTermId === t.id ? "active" : ""}`}
                  onClick={() => setActiveTermId(t.id)}
                >
                  <span>{t.label}</span>
                  <button
                    type="button"
                    className="terminal-tab-close"
                    aria-label={`Close ${t.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(t.id);
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="terminal-tab-add"
                onClick={addTerminal}
                aria-label="New terminal"
                title="New terminal"
              >
                <Plus size={13} />
              </button>
            </div>
            {terms.map((t) => (
              <TerminalPane
                key={t.id}
                sessionId={sessionId}
                visible={activeTermId === t.id}
                onLog={(m, intent) => push(m, intent)}
              />
            ))}
          </>
        )}
      </Section>
      )}
    </>
  );
}

function TerminalPane({
  sessionId,
  visible,
  onLog,
}: {
  sessionId: string;
  visible: boolean;
  onLog: (m: string, intent?: "info" | "error") => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Keep the latest `onLog` in a ref so the WebSocket effect doesn't depend
  // on its identity — the parent re-renders constantly while typing in the
  // app, and a fresh callback each render would tear down and reopen the
  // socket in a tight loop.
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", "Fira Code", monospace',
      theme: {
        background: "#1a1816",
        foreground: "#e7e5e4",
        cursor: "#f6821f",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    // Pass the initial PTY size in the query string so the shell prompt
    // wraps correctly even before the first onResize event.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      session: sessionId,
      cols: String(term.cols),
      rows: String(term.rows),
    });
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?${params}`);
    ws.binaryType = "arraybuffer";
    const encoder = new TextEncoder();

    // Track whether the socket actually opened. If the sandbox isn't live
    // the WebSocket fails immediately — we don't want to toast "Terminal
    // disconnected" for a connection that was never established. We also
    // mark `closedByUser` on cleanup so unmounting doesn't toast either.
    let opened = false;
    let closedByUser = false;

    ws.addEventListener("open", () => {
      opened = true;
      onLogRef.current(`Terminal connected to ${sessionId}`);
    });
    // Sandbox SDK's PTY proxy is mostly a raw byte stream, but it now
    // emits a `{"type":"ready"}` control frame at connection start. Skip
    // any frame that parses as a tiny JSON envelope with a `type` field
    // — that's the SDK's control protocol, not shell output. Anything
    // else (terminal escape codes happen to start with bytes that
    // aren't JSON, so the parse will throw and fall through) gets
    // written to xterm verbatim.
    const writeIfNotControl = (text: string) => {
      // Cheap pre-check — terminal output basically never starts with `{`.
      if (text.length > 0 && text.length < 256 && text[0] === "{") {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
            return; // control frame — drop it
          }
        } catch {
          // not JSON, fall through to write
        }
      }
      term.write(text);
    };

    ws.addEventListener("message", (event) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        // Decode just enough of the head to test for a JSON envelope
        // without copying every shell byte through TextDecoder.
        if (data.byteLength > 0 && data.byteLength < 256) {
          const head = new Uint8Array(data);
          if (head[0] === 0x7b /* `{` */) {
            const text = new TextDecoder().decode(head);
            writeIfNotControl(text);
            return;
          }
        }
        term.write(new Uint8Array(data));
      } else if (typeof data === "string") {
        writeIfNotControl(data);
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => {
          if (buf.byteLength < 256) {
            const head = new Uint8Array(buf);
            if (head[0] === 0x7b) {
              writeIfNotControl(new TextDecoder().decode(head));
              return;
            }
          }
          term.write(new Uint8Array(buf));
        });
      }
    });
    ws.addEventListener("close", () => {
      if (closedByUser) return;
      if (!opened) {
        term.write(
          "\r\n\x1b[31mCould not connect — the sandbox container is not running.\x1b[0m\r\n",
        );
        onLogRef.current("Terminal could not connect — sandbox is not running", "error");
        return;
      }
      onLogRef.current("Terminal disconnected");
    });
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    // The Sandbox SDK's PTY proxy fixes its size at upgrade time (via the
    // cols/rows query params). Live resize would require reconnecting with
    // new params; for now we just refit visually so xterm reflows locally.
    term.onResize(() => {
      // intentionally no-op on the wire
    });

    termRef.current = term;
    fitRef.current = fit;
    wsRef.current = ws;

    return () => {
      closedByUser = true;
      ws.close();
      term.dispose();
    };
    // Intentionally only `sessionId` — `onLog` is read through `onLogRef`,
    // and rebuilding the WebSocket on every parent render would loop.
  }, [sessionId]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => fitRef.current?.fit(), 0);
      termRef.current?.focus();
    }
  }, [visible]);

  return (
    <div
      className="terminal-pane"
      ref={containerRef}
      style={{ display: visible ? "block" : "none" }}
    />
  );
}
