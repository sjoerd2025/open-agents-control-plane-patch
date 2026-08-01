import { useEffect, useState, useCallback } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { api, type SessionRecord } from "../api";
import { relTime } from "../utils";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { StatusBadge } from "../components/StatusBadge";
import { BackendChip } from "../components/BackendChip";
import { ContainersIcon } from "../components/icons/ContainersIcon";
import type { View } from "../App";
import { useToasts } from "../toasts";

const PAGE_SIZE = 20;

export function EnvironmentsView({
  navigate,
}: {
  navigate: (v: View) => void;
}) {
  const { push } = useToasts();
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<SessionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (target: number) => {
      setLoading(true);
      try {
        const data = await api.environments(target, PAGE_SIZE);
        setItems(data.items);
        setTotal(data.total);
        setPages(data.pages);
        setPage(data.page);
      } catch (err) {
        push((err as Error).message, "error");
      } finally {
        setLoading(false);
      }
    },
    [push],
  );

  useEffect(() => {
    load(1);
  }, [load]);

  return (
    <>
      <PageHeader
        icon={ContainersIcon}
        title="Sandboxes"
        description="One sandbox per Anthropic session — microVM or isolate-based."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={ArrowsClockwise}
            onClick={() => load(page)}
            loading={loading}
          >
            Refresh
          </Button>
        }
      />

      <Section>
        {loading && items.length === 0 ? (
          <div className="empty-state">Loading...</div>
        ) : items.length === 0 ? (
          <Empty
            title="No sandboxes yet"
            description="Webhook events from Anthropic will populate this list as they arrive."
          />
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Type</th>
                <th>Status</th>
                <th>Last Event</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const evtType = (s.lastWebhookType || "").replace(
                  "session.",
                  "",
                );
                return (
                  <tr
                    key={s.sessionId}
                    className="clickable"
                    onClick={() =>
                      navigate({ kind: "env-detail", sessionId: s.sessionId })
                    }
                  >
                    <td className="mono">{s.sessionId}</td>
                    <td>
                      <BackendChip backend={s.backend ?? "microvm"} />
                    </td>
                    <td>
                      <StatusBadge
                        status={s.containerStatus}
                        kind="container"
                      />
                    </td>
                    <td className="muted">{evtType || "—"}</td>
                    <td className="mono muted">{relTime(s.lastWebhookAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {pages > 1 && (
          <div className="actions" style={{ justifyContent: "center" }}>
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => load(page - 1)}
            >
              Prev
            </Button>
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              Page {page} of {pages} ({total} total)
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= pages}
              onClick={() => load(page + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </Section>
    </>
  );
}
