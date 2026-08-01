// Cron-driven pruning behaviour: events and sessions older than the cutoff
// must be removed; anything fresher must survive.

import { describe, expect, it } from "vitest";
import {
  pruneOlderThan,
  recordWebhookEvent,
  upsertSession,
  type WebhookEvent,
} from "../src/storage";
import { makeEnv } from "./helpers";

describe("pruneOlderThan", () => {
  it("removes events + sessions older than the cutoff and leaves fresher rows alone", async () => {
    const env = makeEnv();
    const now = Date.now();
    const dayAgo = now - 25 * 60 * 60 * 1000;

    await recordWebhookEvent(env.DB, {
      type: "event",
      id: "ev_old",
      timestamp: new Date(dayAgo).toISOString(),
      data: { type: "session.status_idled", id: "session_old" },
    });
    await recordWebhookEvent(env.DB, {
      type: "event",
      id: "ev_new",
      timestamp: new Date(now).toISOString(),
      data: { type: "session.status_run_started", id: "session_new" },
    });

    // Sessions are timestamped at insertion time, so we drive the timestamp
    // through the storage layer directly and then back-date the older one.
    await upsertSession(env.DB, "session_old", "session.status_idled");
    await upsertSession(env.DB, "session_new", "session.status_run_started");
    const oldRow = env.DB._tables.sessions.get("session_old")!;
    oldRow.created_at_ms = dayAgo;
    oldRow.last_webhook_at_ms = dayAgo;

    const cutoff = now - 24 * 60 * 60 * 1000;
    const result = await pruneOlderThan(env.DB, cutoff);
    expect(result.events).toBe(1);
    expect(result.sessions).toBe(1);

    expect(env.DB._tables.webhook_events.has("ev_old")).toBe(false);
    expect(env.DB._tables.webhook_events.has("ev_new")).toBe(true);
    expect(env.DB._tables.sessions.has("session_old")).toBe(false);
    expect(env.DB._tables.sessions.has("session_new")).toBe(true);
  });
});

describe("recordWebhookEvent (defensive)", () => {
  it("persists events with a missing data object instead of throwing", async () => {
    const env = makeEnv();
    // Anthropic occasionally sends test pings whose `data` is null or missing.
    // We want to record them so they show up in the dashboard, not 500.
    const malformed = { type: "event", id: "ev_missing_data", timestamp: new Date().toISOString() } as unknown as WebhookEvent;
    await recordWebhookEvent(env.DB, malformed);
    const row = env.DB._tables.webhook_events.get("ev_missing_data");
    expect(row).toBeDefined();
    expect(row?.type).toBe("unknown");
    expect(row?.session_id).toBe("");
  });

  it("falls back to a generated id when the event has no id", async () => {
    const env = makeEnv();
    const noId = { type: "event", timestamp: new Date().toISOString(), data: { type: "session.status_run_started", id: "session_x" } } as unknown as WebhookEvent;
    await recordWebhookEvent(env.DB, noId);
    expect(env.DB._tables.webhook_events.size).toBe(1);
    const row = Array.from(env.DB._tables.webhook_events.values())[0];
    expect(row.session_id).toBe("session_x");
    expect(String(row.id)).toMatch(/^ev_unknown_/);
  });

  it("falls back to now() when the timestamp is missing or invalid", async () => {
    const env = makeEnv();
    const before = Date.now() - 1;
    const noTs = { type: "event", id: "ev_no_ts", data: { type: "x", id: "y" } } as unknown as WebhookEvent;
    await recordWebhookEvent(env.DB, noTs);
    const row = env.DB._tables.webhook_events.get("ev_no_ts")!;
    expect(Number(row.ts_ms)).toBeGreaterThanOrEqual(before);
  });
});
