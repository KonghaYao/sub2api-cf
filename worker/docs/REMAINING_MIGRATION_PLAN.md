> Current work: [Admin core reimplementation](ADMIN_CORE_REIMPLEMENTATION.md).
> The 2026-09-07 user requirement preserves all original frontend capabilities;
> historical removal/hiding/defer-as-complete decisions below are superseded.

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

## Completed locally in v0.35

- Synchronous Images now freezes channel alias and exact/longest-wildcard price
  selection plus 1K/2K/4K output tiers. It reserves the maximum possible charge,
  settles actual outputs once across failover/replay, and preserves independent
  customer, catalog-standard and provider-account cost facts. Missing,
  duplicate and ambiguous tiers fail before admission or upstream work. Video
  pricing remains explicitly rejected because Worker video routes are deferred.
- Migration 0057 adds administrator-created financial-history backfill batches
  with a strict one-page-per-Worker budget, persistent signed cursors, batch and
  item leases, crash-recoverable idempotent create/continue, immutable actor
  audit and an explicit non-retryable manual-reconciliation state for proven
  legacy gaps.
- Registration/account challenge, notification-email and TOTP Queue consumers
  now share one leased delivery executor and one conformance matrix. Domain SQL
  remains separate while retry, terminal replay and lost-lease behavior cannot
  drift between the three flows.

## Completed locally in v0.36

- The production cutover tool validates a versioned eight-domain export using
  streaming NDJSON plus a disk-backed SQLite index, emits D1/DO/R2 artifacts,
  validates runtime credentials and routing dependencies, produces deterministic
  full-domain digest reconciliation, and generates a chained single-writer
  ownership plan for the internal/1/5/25/50/100 cohorts.
- Remote backup/restore planning now hard-allowlists staging and production,
  uses argument-array D1 commands, verifies manifests and fresh empty-target
  proofs, rejects contract-only steps before execution, and verifies executable
  steps through independent read-back evidence and an atomic resumable journal.
  DO and R2 transports remain contract-only until their privileged adapters and
  a real empty-environment drill exist.
- Migration 0058 adds guarded, bounded account bulk enable/disable and durable
  Queue health-probe APIs with CAS, idempotency, immutable unified audit and
  stale-generation rejection. The Worker frontend exposes only these retained
  operations; unavailable provider quota, tier and privacy facts are explicit
  `unsupported`/`null`, never zero or guessed.

## Completed locally in v0.37

- User-created custom API tokens now use keyed HMAC storage and one-time
  plaintext display. Migration 0059 adds normalized IPv4/IPv6 allow/deny rules;
  deny rules win, restricted keys fail closed without a valid
  `CF-Connecting-IP`, policy writes use CAS and increment the authentication
  version, and Worker-mode key controls are enabled in the Vue frontend.
- Administrators can queue bounded account/model/capability inference probes.
  Migration 0060 keeps versioned jobs, per-model monitor state, immutable
  history and firing/recovery alert events in D1. Queue consumers re-read
  encrypted credentials, reject stale configuration at claim and persistence,
  classify invalid 2xx responses as failures, and never turn one model failure
  into whole-account health failure. Bounded Cron recovery resends failed
  outbox dispatches and reclaims expired consumer leases without allowing an
  older delivery to cancel a newer winner. Frontend controls, unified audit
  projection and alert delivery remain outstanding.
- Codex Responses forwarding now normalizes native function, custom,
  tool-search, local-shell and MCP call identities without breaking call/output
  or item-reference pairing. Invalid replay IDs and reasoning-only IDs are
  removed while valid input IDs and arbitrary output item IDs are preserved.

## Completed locally in v0.38

- The first real-browser Worker vertical slice now drives the built Vue SPA in
  system Chrome against an isolated local Wrangler runtime. It proves
  registration, login, administrator funding through the UserStateDO/Queue/D1
  projection, one-time API-key creation, Chat Completions settlement, Usage UI
  projection and R2 avatar persistence. It is the first route slice, not yet
  evidence for every reachable Vue route or a deployed environment.
- Registration verification, password reset, email binding, notification-email
  verification and TOTP setup now pass Workerd E2E through the public HTTP
  routes, the real Queue consumer, D1 leases and a process-external mail Worker
  service binding. Production still requires a verified sender binding and a
  deployed smoke run.
- USER_STATE has a privileged, environment-bound Worker backup transport and a
  Node remote adapter. Versioned canonical NDJSON captures all six SQLite
  tables, validates the exact schema, ordering and three independently
  recomputed digests, restores atomically only into a logically empty object,
  verifies read-back, permits identical replay and rejects conflicting state.
  Other Durable Object namespaces and R2 deliberately remain contract-only.
- The Worker account page can now queue bounded account/model/capability probes
  and inspect immutable cursor-paginated history. Targets are restricted to the
  enabled model/account capability intersection and retain configuration
  versions so stale work cannot overwrite newer account state.

## Completed locally in v0.39

- The local real-browser route patrol covers all 30 reachable public and
  ordinary-user Vue routes without a Worker migration fallback. Separate local
  browser slices exercise subscription-code redemption and the resulting
  entitlement UI, plus Stripe order creation and cancellation. The browser
  runner preserves the receiver for the Worker global `fetch` and its Workerd
  outbound-service seam. The complete local browser suite passes;
  administrator routes are not yet patrolled, and no deployed smoke claim is
  made.
- SUBSCRIPTION_STATE joins USER_STATE on the privileged, environment-bound
  Worker backup transport and strict Node adapter. Canonical NDJSON covers all
  seven tables: `subscription_profile`, `subscription_windows`,
  `subscription_requests`, `subscription_term_windows`,
  `subscription_schema_migrations`, `subscription_outbox` and
  `subscription_mutations`. Exact schema, ordering, bounded size, independent
  digests, empty-target atomic restore, identical replay and conflict rejection
  pass local core/adapter tests; export, replay and digest read-back also pass
  the public HTTP seam against a real Workerd Durable Object. A separate real
  empty-environment restore drill remains a release gate.
- Stripe is the sole retained Worker payment provider. Airwallex, standalone
  Alipay, standalone WeChat Pay and EasyPay UI/routes are removed. The legacy
  `/monitor` page and legacy pending-OAuth account chooser are also removed;
  the bounded Worker-native account/model probe history remains supported.

The remaining release evidence is deliberately narrower: finish the
administrator-route browser patrol, run deployed smoke,
exercise Stripe webhook/fulfilment/refund recovery, implement the other
Durable Object and R2 transports and run a real empty-environment restore drill,
and configure and verify the production email binding.

## P0: required before the Worker becomes the only production backend

| Slice | Current gap | Cloudflare implementation | Acceptance gate |
| --- | --- | --- | --- |
| Frontend/Worker contract closure | v0.39 locally patrols all 30 reachable public/user routes and adds passing redemption and Stripe create/cancel slices; administrator-route patrol and deployed proof remain. | Keep the Worker route inventory authoritative and extend the same browser patrol to administrator routes before deployment smoke. | Every reachable Vue route passes browser E2E against the Worker; no request returns `Route not migrated`; no unsupported control is visible; staging smoke repeats the critical paths. |
| Channel customer pricing | Text and synchronous-image channel pricing are complete locally; deployed proof remains. Video routes and pricing are deferred together. | Keep frozen token/request/image decisions independent from provider account-cost facts; add video only with its Worker route. | Deployed alias, wildcard, interval, request/image, service-tier, failover and replay tests prove one customer charge and one independent account-cost snapshot. |
| Core provider and protocol closure | The four Worker providers cover the main text paths, but retained legacy protocol variants and upstream credential lifecycles are incomplete. | Worker streaming codecs and provider adapters; D1 encrypted credential generations; DO leases/refresh serialization; Queue/Cron health recovery. | Every retained Go compatibility fixture is mapped; OpenAI, Anthropic, Gemini and Codex run authenticated binding and deployed smoke tests with exact settlement and no lease leaks. |
| Production data cutover | Versioned conversion/reconciliation and ownership-cohort artifacts pass locally; the real PostgreSQL/Redis export, Queue catch-up and staged import have not run. | Execute the validated D1/DO/R2 artifacts under the generated single-writer cohort plan. | Users, keys, balances, ledgers, subscriptions, orders, provider accounts, runtime dependencies and R2 objects reconcile by row count and full-domain digest before staged traffic reaches 100%. |
| Backup, restore and rollback | Local bundles and strict remote plans pass; USER_STATE and all seven SUBSCRIPTION_STATE tables have executable privileged transports/adapters. POOL_STATE, AUTH_RATE_LIMIT, API_KEY_LIMIT_STATE, R2 content transfer and real restore drills remain. | Implement the remaining contract-only per-DO and R2 adapters, then exercise the allow-listed journaled plan with Worker Versions rollback notes. | Restore into an empty environment, verify digests and financial authorities, then perform one real Worker rollback drill. |
| Production identity delivery | Queue/D1 delivery behavior and Cloudflare binding adapters pass locally, but no sender is committed in environment config and deployed flows are not proven. | Configure a verified `SEND_EMAIL` sender or an idempotent bounded mail Worker separately in every environment. | Registration verification, password reset, account binding, TOTP and notification-mail verification pass deployed E2E without leaking challenge data. |

## P1: commercial and operational completeness

| Slice | Current gap | Cloudflare implementation | Acceptance gate |
| --- | --- | --- | --- |
| Account operations | Guarded bulk enable/disable and versioned Queue/Cron account/model/capability probes with immutable history are complete locally; deployed authenticated smoke remains. Provider quota/tier/privacy are intentionally unsupported until stable APIs exist. | Run deployed smoke for the existing probe path; extend it only when a provider publishes stable facts that the Worker can retain without inference. | Retained buttons have Worker contracts; deployed probes cannot be overwritten by stale configuration; unavailable quota/tier/privacy is `unsupported` with `null`, never zero. |
| Admin usage and finance | Immutable per-user balance/debt history and bounded operator-driven batch coordination now exist; automatic discovery, broader aggregates and correction/export workflows are incomplete. | Add scheduled discovery, hour/day D1 rollups, Queue projections and R2 streaming exports around the immutable ledger. | Dashboard totals reconcile to immutable ledgers; backfill manifests prove their source range; corrections use compensating entries and immutable audit. |
| Prompt audit and guard | Redaction and image moderation do not implement the original cross-protocol prompt policy. | Versioned D1 policy/events, Queue scanning, short-lived encrypted R2 payloads and DO bulkheads. | Blocking decisions happen before account selection/reservation; async failure never breaks the main request; full prompts and tokens never enter logs or D1. |
| API-key custom token/IP policy | Custom tokens and IPv4/IPv6 policy are complete locally; deployed proof and optional last-used-IP observability remain. | Keep keyed HMAC tokens, one-time plaintext display and D1 CIDR rules sourced only from trusted `CF-Connecting-IP`; retain `last_used_ip: null` until a privacy-reviewed projection exists. | Deployed custom-token, IPv4/IPv6, spoofing and concurrent-update tests pass without persisting plaintext or source IP. |
| Channel monitor and alerts | Manual per-model probes, bounded Cron recovery, immutable history and the v0.38 Worker UI are complete locally; silences, reports and alert delivery remain. | Add D1 silences, R2 evidence/reports and replay-safe email/webhook delivery around the existing Queue consumer and recovery dispatcher. | Silence/DLQ and deployed per-model inference probes pass without duplicate alerts. |
| Payment closure | Stripe order creation/cancellation passes a local browser slice. Signed webhook, fulfilment, refund recovery and reconciliation have local lower-level coverage, but deployed recovery drills remain. No non-Stripe provider is retained. | Keep one Stripe adapter with the D1 webhook inbox/order/refund state, Queue fulfilment and R2 evidence; run replay, out-of-order, late-payment, refund and recovery drills. | Stripe passes signed-webhook replay, fulfilment, cancellation, late-payment, refund/recovery and deployed sandbox smoke without duplicate entitlement. |
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

The Worker product also intentionally removes Airwallex, standalone Alipay,
standalone WeChat Pay, EasyPay, the old `/monitor` experience and the legacy
pending-OAuth account chooser. They are not backlog items. Stripe, the current
Worker-native per-model probe workflow and direct OAuth callbacks are the
retained replacements.
