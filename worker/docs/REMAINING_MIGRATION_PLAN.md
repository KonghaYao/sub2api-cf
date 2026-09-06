# Remaining Cloudflare migration plan

This plan orders the remaining work by whether the Go service can be safely
removed. The detailed compatibility ledger remains `MIGRATION_MATRIX.md`.

## Completed locally in v0.32

- The reachable Worker frontend no longer calls legacy-only group, capacity,
  Live, duplicate, composite-route, sort, multiplier, key-token or IP-policy
  endpoints. Implemented announcements, usage and operations explorers are now
  reachable in Worker mode.
- Text gateway routes freeze exact/longest-wildcard channel pricing inside the
  existing D1 route batch. Token, cache-read, per-request, interval,
  service-tier and timezone pricing use integer micros and an immutable usage
  snapshot. Ambiguous prices fail before reservation.
- Customer charge, catalog standard cost, optional channel/account-stat basis
  and final provider-account cost are independent immutable facts. The channel
  account-stat toggle is active end to end.
- Channel-specific image/video pricing remains intentionally fail-closed until
  its separate media pricing contract is migrated.

## Completed locally in v0.33

- Remote deployments now use a recoverable, fail-closed D1 migration runner.
  It validates both migration ledgers as continuous prefixes, imports one SQL
  file at a time, verifies the project version/name, and repairs the safe
  "SQL committed, Wrangler registration missing" interruption state. Empty,
  0031, 0034 and 0053 checkpoints and a real isolated Wrangler D1 run pass.
- OpenAI and OpenAI-compatible Codex requests retain bounded, allow-listed
  diagnostics from deterministic upstream HTTP 400 responses. Credential-like,
  URL-bearing, malformed, non-JSON, oversized and stalled bodies still reduce
  to the generic public error and never trigger account failover.
- Anthropic Messages accepts strict generation controls for direct accounts and
  maps `output_config.effort` plus compatible sampling controls to Responses
  and Chat fallbacks. Generation-only fields are accepted but excluded from
  count-token forwarding.
- Migration 0055 adds an immutable D1 `user_financial_events` projection fed by
  the existing UserStateDO transactional outbox. Admin adjustment, redeem-code,
  affiliate transfer/refund clawback, auth-source entitlement and usage
  settlement sources retain exact integer-micros balance/debt facts. The
  administrator read API uses `admin.users.read` and a stable tuple cursor; the
  legacy Vue modal adapts UUID event IDs without changing its sequential
  previous/next UI.
- This ledger begins with financial state events emitted after 0055 is deployed.
  Older Durable Object entries are rebuilt only through the privileged,
  cursorized full-ledger export; the bounded `/snapshot` response remains
  unsuitable because it exposes only the latest 100 rows. Pre-v0.34 objects
  with contiguous rowids are provable. If an older enabled rollback already
  deleted a ledger row, no tombstone exists and automated backfill deliberately
  stops for manual financial reconciliation.

## Completed locally in v0.34

- Anthropic Messages now retains up to four validated cache breakpoints and
  round-trips compatible signed thinking through the Responses reasoning
  contract in buffered and streamed paths. Native Anthropic forwarding also
  keeps provider-specific redacted blocks; no synthetic signature is created.
- Pre-0055 financial history can now be rebuilt through a privileged,
  environment-bound signed cursor. Each request exports at most 100 frozen DO
  ledger rows; D1 immutable rows are compared field by field, and completeness
  is recorded only after version, balance, debt, ledger and projection counts
  reconcile. Exact state versions and same-sequence rollback tombstones keep
  new histories reconstructable, while immutable actor audit records progress,
  blocked/failed attempts and the single CAS winner at completion.
- Registration, password reset, account binding, notification-email and TOTP
  delivery share one Cloudflare email boundary. Missing delivery bindings fail
  before challenge issuance, transient failures retry, permanent failures are
  acknowledged with content-free error codes, and provider bodies/errors are
  not written to D1 or logs.
- A versioned, streaming backup bundle core now validates D1 SQL, DO NDJSON and
  R2 inventory artifacts with byte counts and SHA-256 digests, rejects unsafe
  bundle contents, and produces a deterministic D1-to-DO-to-R2 restore plan.
  Remote resource adapters and an empty-environment drill remain outstanding.

## P0: required before the Worker becomes the only production backend

| Slice | Current gap | Cloudflare implementation | Acceptance gate |
| --- | --- | --- | --- |
| Frontend/Worker contract closure | Local route guards and reachable-page contracts are closed; browser-level deployed proof remains. | Keep the Worker route inventory authoritative and expose new controls only with a complete Worker contract. | Every reachable Vue route passes browser E2E against the Worker; no request returns `Route not migrated`; no unsupported control is visible. |
| Channel customer pricing | Text token/per-request pricing is complete locally; image/video channel tiers are explicitly rejected instead of being mispriced. | Extend the frozen pricing snapshot contract to media dimensions without changing the independent account-cost facts. | Deployed alias, wildcard, interval, request/image, service-tier, failover and replay tests prove one customer charge and one independent account-cost snapshot. |
| Core provider and protocol closure | The four Worker providers cover the main text paths, but retained legacy protocol variants and upstream credential lifecycles are incomplete. | Worker streaming codecs and provider adapters; D1 encrypted credential generations; DO leases/refresh serialization; Queue/Cron health recovery. | Every retained Go compatibility fixture is mapped; OpenAI, Anthropic, Gemini and Codex run authenticated binding and deployed smoke tests with exact settlement and no lease leaks. |
| Production data cutover | Local binding tests exist, but PostgreSQL/Redis state has not been fully imported and reconciled with D1/DO/R2. | Versioned D1 import, R2 manifests, DO initialization commands and Queue projection catch-up. | Users, keys, balances, ledgers, subscriptions, orders and provider accounts reconcile by row count and sampled digest before staged traffic reaches 100%. |
| Backup, restore and rollback | The local cross-store bundle, integrity verifier and deterministic restore plan pass; remote D1/DO/R2 adapters and drills remain. | Add explicit environment-selected exports/imports, per-DO restore commands, R2 reconciliation and Worker Versions rollback notes around the v0.34 bundle core. | Restore into an empty environment, verify digests and financial authorities, then perform one real Worker rollback drill. |
| Production identity delivery | Queue/D1 delivery behavior and Cloudflare binding adapters pass locally, but no sender is committed in environment config and deployed flows are not proven. | Configure a verified `SEND_EMAIL` sender or an idempotent bounded mail Worker separately in every environment. | Registration verification, password reset, account binding, TOTP and notification-mail verification pass deployed E2E without leaking challenge data. |

## P1: commercial and operational completeness

| Slice | Current gap | Cloudflare implementation | Acceptance gate |
| --- | --- | --- | --- |
| Account operations | Batch actions, provider quota/tier/privacy sync and per-model probes are incomplete. | D1 control state, Pool DO cooldown, Queue/Cron probes and versioned health projections. | Retained buttons have Worker contracts; stale probes cannot overwrite newer configuration; unavailable quota is `unknown`, never zero. |
| Admin usage and finance | Immutable per-user balance/debt history plus bounded signed pre-0055 DO backfill now exist; pre-v0.34 rollback gaps require manual reconciliation, and bulk orchestration, broader aggregates and correction/export workflows are incomplete. | Add a bounded background backfill coordinator, explicit manual-reconciliation records, hour/day D1 rollups, Queue projections and R2 streaming exports around the immutable ledger. | Dashboard totals reconcile to immutable ledgers; backfill manifests prove their source range; corrections use compensating entries and immutable audit. |
| Prompt audit and guard | Redaction and image moderation do not implement the original cross-protocol prompt policy. | Versioned D1 policy/events, Queue scanning, short-lived encrypted R2 payloads and DO bulkheads. | Blocking decisions happen before account selection/reservation; async failure never breaks the main request; full prompts and tokens never enter logs or D1. |
| API-key custom token/IP policy | The frontend still exposes fields that Worker mode rejects. | Either retain with HMAC tokens and D1 CIDR rules using trusted `CF-Connecting-IP`, or remove from API and UI together. | The retained decision has IPv4/IPv6, spoofing, cache invalidation and concurrent-update tests. |
| Channel monitor and alerts | Generic account health exists; model probes, alert rules, silences and reports do not. | Cron to Queue probes, D1 rules/history/silences, R2 evidence/reports and replay-safe delivery. | Duplicate schedules do not duplicate alerts; silence/recovery/DLQ behavior and per-model inference probes pass. |
| Payment closure | Stripe is implemented; retained Alipay, WeChat Pay, EasyPay or Airwallex behavior is not. | Separate Worker adapters with D1 webhook inbox/order/refund state, Queue fulfilment and R2 evidence. | Every retained provider passes signature, replay, out-of-order, late payment, refund and sandbox E2E. Non-retained providers disappear from the UI. |
| Settings, audit and compliance | Several legacy settings and audit sources have no Worker contract; risk actions are incomplete. | Typed D1 settings, KV version cache, append-only D1 audit and R2 large details. | Every unsafe admin mutation emits actor audit; settings have defaults, CAS, secret redaction and hot-path effect tests. |
| Cross-domain retention and DLQ | Individual recovery jobs exist without one complete replay/retention surface. | Bounded D1 cursors/inboxes, Queue DLQs and R2 quarantine/evidence. | Poison, duplicate and out-of-order messages are observable and safely replayable; every job has a tested write/read budget. |

## P2: valuable but allowed to follow the core cutover

- Search routes and X/web-search billing.
- Responses Realtime, Live and provider WebSocket relays using `WebSocketPair`
  and Durable Object hibernation where session state is required.
- Video generation/edit/extend, TTS, STT and custom voice using D1 task state,
  Queue execution and private R2 artifacts.
- Full-size Gemini Batch Files/JSONL jobs beyond the current bounded image
  fallback.
- Dynamic remote model/price catalog refresh and provider-specific quota feeds.
- User attributes, advanced commercial segmentation and compliance case flows.
- Rich live operations dashboards and long-term report generation.

## Explicit removals in Worker mode

The following host-oriented features are not migration targets: outbound proxy
inventory, uTLS/JA3/TLS fingerprint controls, process-local plugins, self
update/restart, host CPU/RAM/disk metrics, local log files and the local data
management agent. Their outcomes are replaced by direct Worker `fetch`,
compile-time adapters, Worker Versions, Cloudflare analytics, structured D1/R2
observability and verified export/restore workflows.
