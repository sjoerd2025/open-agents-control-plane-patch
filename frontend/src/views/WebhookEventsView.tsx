import { useCallback, useEffect, useState, useRef } from "react";
import { WebhooksLogo, ArrowsClockwise, Trash } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { api, type WebhookEvent } from "../api";
import { shortSessionId } from "../utils";
import { CopyButton } from "../components/CopyButton";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { useToasts } from "../toasts";

const TYPE_BADGE: Record<
  string,
  "success" | "warning" | "error" | "info" | "secondary"
> = {
  "session.status_run_started": "success",
  "session.status_scheduled": "info",
  "session.status_idled": "warning",
  "session.status_terminated": "error",
  "session.thread_created": "info",
  "session.thread_idled": "warning",
  "session.thread_terminated": "error",
};

export function WebhookEventsView() {
  const { push } = useToasts();
  const [items, setItems] = useState<WebhookEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.webhookEvents();
      setItems(data.items);
      setCursor(data.cursor);
      setHasMore(data.hasMore);
    } catch (err) {
      push((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!auto) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(load, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [auto, load]);

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const data = await api.webhookEvents(cursor);
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.cursor);
      setHasMore(data.hasMore);
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  const clear = async () => {
    if (!confirm("Delete all webhook history?")) return;
    try {
      const r = await api.clearWebhookEvents();
      push(`Deleted ${r.deleted} webhook events from history`);
      await load();
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <PageHeader
        icon={WebhooksLogo}
        title="Webhook Events"
        description="Signed webhook deliveries. Pruned daily after 24 hours."
        actions={
          <>
            <Checkbox
              label="Auto-refresh"
              checked={auto}
              onCheckedChange={(v) => setAuto(Boolean(v))}
            />
            {items.length > 0 && (
              <CopyButton
                text={() => JSON.stringify(items, null, 2)}
                label="Copy all"
                copiedLabel="Copied!"
                title="Copy the visible webhook events as JSON"
              />
            )}
            <Button
              variant="secondary-destructive"
              size="sm"
              icon={Trash}
              onClick={clear}
            >
              Clear History
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={ArrowsClockwise}
              onClick={load}
              loading={loading}
            >
              Refresh
            </Button>
          </>
        }
      />

      <Section>
        {loading && items.length === 0 ? (
          <div className="empty-state">Loading...</div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            No webhook events yet. Configure a webhook in the Anthropic Console
            to start receiving events.
          </div>
        ) : (
          <div>
            {items.map((ev) => {
              const variant = TYPE_BADGE[ev.data.type] || "secondary";
              const ts = ev.created_at || ev.timestamp;
              const time = ts ? new Date(ts).toLocaleTimeString() : "";
              const isExpanded = expanded.has(ev.id);
              return (
                <div
                  key={ev.id}
                  className="event-row"
                  onClick={() => toggle(ev.id)}
                >
                  <div className="event-summary">
                    <Badge variant={variant}>
                      {ev.data.type.replace("session.", "")}
                    </Badge>
                    <CopyButton
                      compact
                      text={() => JSON.stringify(ev, null, 2)}
                      label="Copy"
                      copiedLabel="Copied"
                      title="Copy this webhook event as JSON"
                    />
                    <span
                      className="mono"
                      style={{ flex: 1 }}
                      title={ev.data.id}
                    >
                      {shortSessionId(ev.data.id)}
                    </span>
                    <span className="muted mono" style={{ fontSize: "0.7rem" }}>
                      {time}
                    </span>
                  </div>
                  {isExpanded && (
                    <div
                      className="event-detail"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="json-viewer">
                        {JSON.stringify(ev, null, 2)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {hasMore && (
          <div className="actions" style={{ justifyContent: "center" }}>
            <Button variant="ghost" size="sm" onClick={loadMore}>
              Load More
            </Button>
          </div>
        )}
      </Section>
    </>
  );
}
