# Snapshots & state persistence

Wiring up R2 snapshots is part of the core onboarding flow (README →
Step 5) for any deployment that runs the MicroVM backend. Isolate-only
deployments can skip the bucket — DO storage handles persistence
transparently. Once the `BACKUP_BUCKET` bucket exists and the binding
is in place, every MicroVM Sandbox session automatically preserves its
`/workspace` directory across hibernation:

- **On manual or auto-stop**: `Sandbox.onActivityExpired()` fires before
  the container is suspended; we call `createBackup({ dir: "/workspace" })`
  and persist the handle to DO storage. Manual stops via the API trigger
  the same path. Auto-stop fires after `SESSION_IDLE_TTL` (default `3m`,
  see `src/microvm/sandbox.ts`) of container inactivity — bump it if you'd rather
  pay for warmth than cold boots.
- **On dispatch**: if `isLive()` returns false (container is fresh), we
  call `restoreLatestSnapshot()` immediately after `start()` returns and
  before launching the control plane. **We never restore over a running
  container** — the early-return at the top of `dispatch()` enforces it.
- **On restore failure**: log loudly, fall through to a fresh
  `/workspace`. Snapshot drama never blocks dispatch.

The bucket itself is mandatory. Two paths reach it at runtime:

- **Production** (presigned URLs): set `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `BACKUP_BUCKET_NAME`, and
  `CLOUDFLARE_ACCOUNT_ID` as secrets. This is the path production
  deploys should take — it's faster and doesn't pin the request to the
  Worker isolate.
- **Local dev** (BACKUP_BUCKET binding): when those secrets are absent,
  the Sandbox SDK uses the binding directly (`localBucket: true`). This
  lets `wrangler dev` run without minting tokens, but the bucket still
  has to exist — `wrangler dev` won't create it for you.

> **Isolate sessions** persist their workspace via DO storage already, so
> the snapshot system is MicroVM-only by default. State survives DO
> hibernation without any extra setup.

R2 doesn't auto-expire backups. Configure a lifecycle rule on the
`BACKUP_BUCKET` to GC objects under `backups/` after your retention
period (the snapshot SDK sets a 7-day TTL by default; lifecycle rules are
the enforcement).
