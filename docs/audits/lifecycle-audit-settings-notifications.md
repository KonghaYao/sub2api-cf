# Operation audit, email settings and notification lifecycle audit

## Operation audit /admin/audit-logs

The local page already matched original Go UI commit 35748d8c5 (full original template and styling). Router and sidebar both select AuditLogView.vue. This is not evidence about deployed assets; root owns production visual verification.

Found and fixed two concrete asynchronous UI failures: an older list request could replace newer filters, and an older detail response could replace the currently selected detail. Request generations now reject stale successes/errors/loading resets. Component regression reproduces both races. Existing original-template parity remains green.

Actual createApp + SQLite contract test makes successful/failed admin mutations, checks the resulting operation audit rows through exact filters and pagination, retrieves redacted details, and exercises TOTP status and clear/replay. No audit backend rewrite needed. Request audit/body/retention 57 tests and frontend audit/API/parity 9 tests passed.

## SMTP / templates / administrator automation key

Original UI called missing Worker endpoints. Migration 0084 adds encrypted SMTP config, template overrides and hashed administrator automation key. Root mounted production app routes. Public SMTP reads never return password; blank password keeps existing encrypted password; independent CAS guards updates. Actual email consumer reads saved config and preserves existing native bindings when no SMTP host is configured. SMTP exchange implements implicit TLS/STARTTLS, authenticated connection test and multipart send with finite deadlines and sanitized errors. No actual emails were sent in testing.

The 26 official event/locale templates come from original Go templates. Preview/update/restore are wired; actual auth delivery consumes overrides, including text hyperlinks. Automation secret is returned only once, persisted only as HMAC hash, owner must remain active admin, and regeneration/deletion immediately revoke old keys. The new session type does not bypass TOTP sensitive-operation gating and cannot regenerate itself.

Real createApp+SQLite tests cover all these contracts; in-memory SMTP protocol tests verify STARTTLS before authentication, message transmission, connection-only test, prevention of cleartext password and error redaction. Original delivery/challenge/notification-preferences/TOTP regression suite passed (71 tests).

## Notification settings and scheduled consumers

Previously the global switches had neither Worker persistence nor an actual consumer. Migration 0085 adds independent CAS configuration, singleton scan lease, condition generations, and durable retry delivery records. GET/PUT /admin/settings/notifications use the original flat fields. Defaults are all flags false, balance threshold zero, recharge URL empty, recipients empty.

The existing every-minute scheduled recovery invokes bounded scans of active users, subscriptions, and accounts. Low-balance notifications honor global and per-user thresholds/opt-outs and verified extra addresses. Subscription reminders use original 7/3/1-day boundaries. Account notifications use only actual projected Gateway costs, never unsupported upstream official quota: account_cost_micros, then account_stats_cost_micros, standard_cost_micros, amount_micros. Original account quota dimensions and reset settings control threshold evaluation. Messages explicitly identify Gateway usage.

Each condition generation and recipient has a deterministic delivery identity. Repeated scans deduplicate; observed balance recovery rearms the alert; failed sends use bounded exponential retry. Send-time revalidation rejects disabled users/accounts, removed recipients, expired/changed subscriptions, or recovered thresholds. Global disable removes queued messages. Templates and SMTP/native providers are the same actual email consumer used by auth.

Real createApp+SQLite test performs CAS 428/412 checks, persists settings, creates user/subscription/account/usage, sends actual rendered low-balance/subscription/account content through an in-memory provider, rescans for deduplication, raises then lowers balance for rearming, retries a provider failure, disables notifications to cancel pending work, and verifies the database lease blocks a second scanner. Reset timezone boundaries are tested. Combined notification/SMTP/config/admin-key regression: 8 tests passed.

Practical limits: this is a bounded periodic scan (50 entities per category per minute by default), not synchronous accounting-trigger delivery. A recovery and new threshold crossing occurring wholly between scans may be coalesced. A provider accepting delivery followed by process termination before recording success may yield a retry; event IDs are stable for provider deduplication, but arbitrary SMTP has no exactly-once guarantee. No external recipient was contacted.

## Remaining independently scoped gaps

Worker app has no channel monitor CRUD/run/history/template/v2 domain or plugin installation/runtime domain. Their original frontend API modules still reference those routes. Original plugin runtime executes uploaded operating-system binaries (backend/internal/service/plugin_runtime.go); Cloudflare Workers cannot directly run that runtime. Persisting its enable switch alone would not restore functionality. These findings were sent to root for implementation/architecture coordination; they are not claimed complete here.

## Independent web-search review

Found and fixed missing Anthropic streaming deltas (text/tool input appeared only in block-start), optional CAS allowing stale UI overwrites, already-aborted requests consuming provider quota, and a malformed null result causing otherwise valid provider results to fail wholesale. Added independent SQLite tests for mandatory/body CAS and stale refusal, pre-cancel quota preservation, and ordinary SSE delta accumulation with malformed upstream entries. Existing plus new search tests: 7 passed. Secrets remain encrypted; provider quota uses atomic conditional increment; failed provider attempts are counted conservatively. Test and gateway paths preserve finite provider timeout/cancellation and sanitized errors.

Monitoring reuse investigation: Worker migration 0060 and account-synthetic-probes.ts already supply real account/model/capability probes with lease/history. Original V1 channel monitor still needs domain/DTO/template adaptation; original V2 requires actual successful and failed request telemetry with latency/cache observations. Success-only usage_projection cannot honestly provide its error-rate metrics. Plugin restoration requires a remote existing Go runtime bridge retaining binary hash/manifest checks, Hashicorp gRPC process lifecycle, health/config validation, cancellation and streaming; no paid service was provisioned.

## Completed monitor V1/V2 follow-up

Migration 0087 now implements monitor settings, encrypted monitor credentials, template snapshots, lease-protected executions, durable history, and passive monitor config/TTFT. V1 reuses existing synthetic probe request generation, bounded body parsing, and provider-success validation. Original monitor/template CRUD, duplication, template apply/association, run/history, and user timeline/status now have actual Worker routes. Snapshot apply and blank-key preservation affect subsequent real provider requests; deletion cascades history. Concurrent duplicate retries use a unique persistent scope. Scheduled execution checks live configuration before each model. Gateway account quota mode is explicitly labelled Gateway usage; it never claims unavailable official provider quota.

V2 reads real request_observations (including failure/cancellation and successful outcomes), with real token/cache counts, duration and nullable TTFT. Billing agent connected actual first-token sampling into the new nullable observation column. Missing samples remain null/zero sample count. Original filtering, dimensions, snapshot/trend, matrix, models, errors, users and versioned config are wired. User responses remove identity, absolute fleet volume/sample counts, upstream details and operational allow-lists as required by original Go behavior. Config stays manageable when the feature is off. Queries cap raw rows at 10000 and explicitly return incomplete coverage if truncated; this is not an unbounded historical warehouse.

Original frontend templates/layout remain intact. Fixed actual Worker UUID bugs in quota-account selection, passive-monitor group filters, matrix rows and settings selection. Account selector regression: 11 passed. Worker monitor lifecycle/eleven-model budget/passive observation tests plus notification tests: 6 passed. Tests inspect provider authorization, body/header changes, history, real failure/success rate and TTFT aggregation, credential secrecy, user redaction, disabled behavior and cascading deletion.

Scheduled database work was further bounded: notifications default one entity per category and one delivery per pass, condition generation uses RETURNING, recipient fanout uses a single JSON-table INSERT. The worst configured 20 recipient × 3 quota-dimension case stays at most 50 D1 statements for initial scan and retry. Monitor scheduler handles one monitor (up to 11 models) per pass and is tested at most 50 statements. Root moved these jobs into separate existing-queue maintenance events (batch size one), so their budgets do not accumulate with the legacy cron recovery batch. Earlier note of 50 entities/minute is superseded by these explicit bounded defaults.

## Backup / image storage follow-through

- Restored original BackupView storage contracts and independent CAS versions. Saved secrets are encrypted; blank secret updates retain the current secret. S3 connectivity tests perform signed PUT/GET-content-compare/DELETE against a temporary object.
- Image generation consumes configured S3 storage, enforces configured download size, returns its real signed/public URL, and retains an encrypted storage locator containing the original storage configuration so cleanup still reaches the original object after configuration changes. Failure after S3 upload and task expiry both delete external objects; failed cleanup retains locators for retry.
- Full system backup is **not implemented by the Worker**: the existing complete CLI bundle includes D1 SQL, Durable Object state and R2 inventory. D1.dump is deprecated alpha functionality, and no execution service or restricted export credential has been configured. Full-backup/schedule-enable/restore buttons are visibly disabled with the execution-service requirement; the API does not manufacture a completed backup. S3 and image storage remain independently functional. No local Cloudflare credential was read or copied.
- Verified real SQLite configuration routes, S3 protocol through mocked fetch, generated image queue/storage lifecycle, post-upload failure cleanup, original frontend save/version/capability handling. No live S3 or user mail was used.

## Ops settings, dashboard, alerts and diagnostic logs

### Canonical settings and dashboard

- `ops_monitoring_enabled`, `ops_realtime_monitoring_enabled`, `ops_query_mode_default` and `ops_metrics_interval_seconds` use the main gateway JSON as the single source of truth. Removed frontend Worker hardcoded disabled flags.
- Original dashboard routes aggregate actual `request_observations`, including failed/cancelled requests and real nullable TTFT. Raw bypasses the cache; auto/preagg uses a real TTL aggregate cache. Coverage is explicit when the 10,000-observation sample limit is exceeded. Ratios match the original Go/UI 0–1 contract, while alert rule rate thresholds use percent.
- Real-time window aliases `1min`, `5min`, `30min`, `1h` now match the original header. Earlier browser failure was a concrete request-contract mismatch, not a missing upstream.
- Concurrency/availability read authoritative PoolState and APIKeyLimitState snapshots. Unavailable or truncated snapshot fanout is unknown/disabled, never fabricated from `started` observations. General queue entries without an assigned account now contribute to group/platform queue depth.
- Independent advanced/metric threshold CAS is retained by frontend forms. Partial success in the settings dialog immediately updates the successful domain's version, so retrying another failed domain does not deterministically conflict.

### Alert lifecycle

- Migration 0091 adds rule/config/event/silence/outbox/lease tables. Actual routes support original rule CRUD, filtered/cursor event lists, details, resolution, scoped silence, runtime settings and email configuration.
- Runtime evaluation starts at 60 seconds, matching the Worker maintenance scheduler; advertised min/max capabilities drive the original form's validation. Named distributed-lock settings have a real lease consumer, in addition to an invariant safety lease protecting delivery.
- Supported metrics use actual request success/error/upstream error percentages, account health, or bounded authoritative Pool snapshots for queue depth, available account count/ratio and overload count. The original UI's P0–P3 severities and UUID group IDs are preserved through edit, historical filtering and silence requests.
- Rule updates reset sustained-state evaluation, CAS rechecks prevent a disabled/edited rule from firing on stale measurements, missing data does not resolve an event as a fabricated zero, and a unique firing-event index prevents duplicate active incidents. Events persist before delivery; unmarked events are reconciled into deterministic outbox entries after an interrupted insert.
- Outbox delivery rechecks current feature flags, recipients, rule status/severity and scoped/global silences. Emails batch by recipient, use a durable batch identity across retries, apply a real hourly delivery limit, cancel stale firing notifications, and retry sanitized provider failures with bounded backoff. Real daily/weekly/request-error/account-health reports use persisted request observations and cron schedules (UTC).
- Each maintenance message processes one due rule and one recipient batch, returns `has_more_due_rules`, and root's maintenance dispatcher enqueues continuation messages until all currently due rules are evaluated. Tests include all four reports, 20 recipients, multiple pages and query counts ≤50. This avoids stretching 100 configured rules over 100 minutes.
- Unsupported CPU/memory and provider-specific rate-limit/temporary-unscheduling metrics are rejected with an explicit missing-source error. Official OpenAI 5h/7d subscription quota auto-pause still needs the actual provider usage source; token/request rate-limit headers are not treated as official subscription quota.

### System diagnostics

- The terminal observation recorder now enqueues a standard `ops.system-log.v1` event without adding gateway D1 queries. A separate queue consumer applies the saved logging level, persisted per-second sampling, caller/self-stack options, and redacts diagnostic text into independent `ops_system_logs` rows. It never takes exception/request/provider text as a stack trace.
- The original system-log page loads runtime config, paginated filters, cleanup and real sink health. Cleanup and log retention only remove diagnostic records, not request observations or accounting data. Independent logging CAS survives load/save/reset and repeated saves.
- The source is explicitly `worker_gateway_diagnostics`; Cloudflare's full host logs and queue depth are not available through Worker bindings. Unobserved queue depth/capacity/write-failure totals are null with coverage metadata, rendered as unknown rather than fake zeros.
- No test sent email to a real recipient. Real createApp + SQLite tests traverse request start/outcome → queue → log row → filter → cleanup, and rules → sustained breach → event → failed email → same-identity retry → resolution → silence. Additional tests cover interrupted outbox insertion recovery, actual DO queue metrics and unavailable-state handling.

Final focused validation for this Ops batch: 8 Worker suites / 25 tests passed, followed by the additional delayed-report schedule regression (alert suite now 4 tests, total 26); 13 frontend suites / 39 tests passed; Worker and frontend type checks passed. Queue continuation preserves the original scheduled timestamp, so delayed daily/weekly cron execution neither skips its intended minute nor creates a second report identity. All results are local; root owns production verification/deployment.

## Risk control follow-up (0096, local validation; pending root integration)

Original `/admin/risk-control` template is retained. The page now submits the configuration CAS version, and IDs accept Worker string IDs. Eight original API routes are implemented with actual configuration, encrypted moderation keys, test transport, persistent runtime status, filtered/paginated logs, hash deletion and risk-owned unban (UserState integration delegated to lifecycle_users).

Configuration drives moderation scope (groups/models), keyword rules, threshold evaluation, deterministic sampling, explicit hash gate, pre-block versus queued observe processing, retry/timeouts/key freezing, bounded execution leases/admission, log retention, violation windows and notification outbox. Provider calls use the saved account proxy transport. Observe prompt payloads are encrypted in R2; Queue messages contain only request identity; completed/cancelled jobs delete their R2 payloads. Queue send failure leaves a recoverable durable job; admission failure removes the just-written object. No test delivers real email.

Specific fixes verified:

- A newly rejected moderation key was retried from a stale available-key array. The same request now skips newly frozen keys; eight configured keys and six 429 failures make six distinct attempts.
- An R2 prompt could be orphaned when D1 job admission failed. The encrypted object is removed on this failure path.
- Original UI sends `result=pass`; log endpoint accepts it, with non-hit/no-error semantics.
- Original UI configuration saves require `expected_control_version`; component test submits the fetched version 7.
- Immediate keyword/hash results recheck global enablement/config version before effects, and queued jobs cancel after the global flag is disabled.
- The original independent pre-hash tooltip explicitly promises blocking previously flagged hashes even during observe. This behavior remains; hash blocks do not increment violations or send emails.
- Oversized provider JSON is bounded to 256 KiB and reader is cancelled. Real AbortSignal timeout ends provider calls; transport failures fail open and persist error records instead of inventing flags.
- Initial D1-only user disable implementation was removed before deployment review: UserState is the status authority and subsequent balance projection could otherwise reactivate a user. Effects now atomically claim persistent `risk_ban_commands`; lifecycle_users owns real DO execution/unban ownership/recovery validation. Pending commands protect referenced logs from retention.

Validation so far: `risk-control-negative.test.ts` 10 passed (real createApp+SQLite; no mock SQL responses), original `RiskControlView.spec.ts` 4 passed including CAS, plus pre-existing observe/hash/global-race integration scenarios. Consumer test counts D1 statements and confirms <=50 with eight keys and six provider failures. These are local results, not a production completion claim; actual DO ban/unban regression and root browser/gateway integration remain required. Current whole-Worker typecheck is blocked by in-progress Antigravity platform exhaustiveness changes outside risk files.

Additional negative coverage: duplicate concurrent Queue delivery makes one provider call; disabled global policy cancels queued mail; retention preserves logs referenced by pending ban commands; unsupported moderation-test image formats and non-boolean key-clearing input are rejected without changing saved credentials.

## Antigravity/Grok imported OAuth and Cron isolation (0.44 local preparation)

Antigravity/Grok Worker OAuth forms now import an existing access token instead of invoking unavailable external authorization/refresh. Antigravity requires an actual project ID, loads it from Worker provider_config during edit, and submits project/token/base URL with the existing CAS version. Model preview sends project ID and actual credentials; the existing account-model test button uses the real account test route. Token replacement retains the account identity and clears draft secrets when the target changes. Individual refresh is hidden for these import-only providers; bulk refresh explains the required token import. Original Go flows remain available under their own contract.

All four original Antigravity settings (fallback model, identity patch enabled/prompt, user-agent version) are carried by the existing gateway field bridge; no replacement settings layout was introduced. Eight frontend test files / 161 tests and vue-tsc passed. The original seven account-template hashes are unchanged; parity normalization covers only explicit Worker imported-token additions, whose behavior has mounted-component tests.

Cron previously ran 18 recovery functions concurrently in the same invocation while dispatching 14 newer maintenance tasks. It now only dispatches 32 independent `settings.maintenance.v1` tasks. Each handler is retried by the existing Queue consumer; one dispatch failure does not prevent the other task sends. Financial/media multi-operation recovery calls use small explicit pages, while existing aggregated account-stat rollups and bounded health/synthetic schedules retain their tested page sizes. No recovery function was removed.

Concrete budget evidence and fixes:

- Observability payload repair at the former limit 50 performs 1 SELECT plus one R2 HEAD and D1 UPDATE per record: 101 calls. Its maintenance page is now 10; real SQLite integration measures 21 calls and leaves 40 remaining records recoverable.
- Orphan R2 cleanup at 50 similarly reaches 101 calls. Maintenance now processes 10, measures 23 including persisted scan-cursor read/write, and advances past fully referenced pages rather than repeatedly scanning only the first page.
- Image recovery at 25 could spend 53 calls on stale tasks alone. Maintenance uses one task per category. A single expired task's prior unbounded R2/S3 cleanup is now resumable: at most three external outputs and ten R2 keys per invocation, with `deleting` retained until all objects are removed. External references clear only after successful deletion; R2 scans restart from the first remaining prefix key so partial failure never skips nested objects.
- Integration covers an 85-object nested prefix with injected deletion failure, and eight real encrypted S3 locators with first-attempt transport failure. Every invocation counts D1/R2/Queue/provider calls and remains <=50. Completion removes all owned objects and task metadata.
- Auth-source first-bind grants allow 100 subscriptions; even one grant could exceed 100 subscription-sync queries. lifecycle_users is completing the shared registration/recovery boundary rather than merely hiding it behind a maintenance page limit; final validation is owned by that agent.

Validation: `test/maintenance/queue.test.ts`, `test/maintenance/recovery-budget.test.ts`, `test/media/image-task.test.ts`: 36 passed; Worker tsc passed. The financial paths retain their existing domain tests; these new checks do not claim a proof that every adversarial CAS retry combination in all financial functions is below the platform ceiling. Root owns final whole-suite/bindings checks and deployment. No deployment or real email was performed by this subagent.
