# Cloudflare Workers migration matrix

This document is the acceptance ledger for replacing the original Go/Vue deployment with a
Cloudflare-only implementation. A row is complete only when its Worker route and storage model
exist, its legacy behavior has an explicit compatibility decision, and automated tests prove the
public contract.

The prioritized execution order is maintained in `REMAINING_MIGRATION_PLAN.md`.

Status meanings:

- **Done**: implemented and covered by local automated tests.
- **Partial**: a usable slice exists, but the legacy contract is not yet covered.
- **Planned**: required for migration and not implemented yet.
- **Replace**: the outcome remains, but host-oriented machinery is redesigned for Cloudflare.
- **Remove**: intentionally unavailable in a Workers-only product; the UI and API must not expose it.

## Acceptance gates

| Gate | Evidence required | Status |
| --- | --- | --- |
| Route inventory | Every original public, user, admin, and gateway route maps to Done, Replace, or Remove | Partial |
| Gateway compatibility | Protocol fixtures, streaming, error mapping, accounting, limits, and failover tests pass | Partial |
| Commercial integrity | Auth, subscription, redemption, order, webhook, refund, and affiliate tests pass | Partial |
| Operations integrity | RBAC, audit, monitoring, alert, retention, recovery, and backup tests pass | Partial |
| Storage correctness | D1 migrations plus Durable Object, Queue, KV, and R2 integration tests pass | Partial |
| Frontend compatibility | User and admin UI smoke/E2E suites pass against the Worker | Partial |
| Deployment | v0.33 adds the fail-closed per-file D1 migration runner; v0.34 adds the verified local cross-store bundle core. v0.36 adds streaming legacy-export conversion/reconciliation, single-writer cohort plans, environment-allowlisted remote plans, empty-target proof and journaled adapter execution. DO/R2 transports remain contract-only; real staging cutover, authenticated production smoke and rollback drills remain. | Partial |

## 1. Gateway and protocol plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| OpenAI model list | D1-backed group/model catalog at `/v1/models` and `/models` | Partial | Worker handler tests and root alias; add deployed-binding contract |
| Chat Completions | `/v1/chat/completions` and `/chat/completions`, streaming and non-streaming | Partial | Worker gateway fixtures cover terminal-without-EOF for Chat/Responses plus native Anthropic/Gemini streams, exact-usage disconnect draining, 10s idle/30s total drain bounds, and single settlement/release. Isolated Workerd binding E2E now proves both native Chat routing and Chat→Responses-only fallback through real D1, admission/billing/Pool Durable Objects and Queue projection. The fallback incrementally buffers forced upstream SSE, returns on the terminal event without waiting for EOF, preserves failure code/message, makes `cyber_policy` zero-billable, and covers buffered JSON, streamed reasoning/text/interleaved tools, one usage/final/[DONE], public-model restoration, exact micros and one released lease; deployed E2E and remaining legacy variants remain |
| Responses | `/v1/responses`, `/responses`, compact and input-token subroutes | Partial | Core Responses tests plus focused subroute fixtures cover both public aliases: compact request whitelisting/unary forwarding, public-model restoration and exact terminal billing; input-token official forwarding, custom-relay local estimation, malformed-upstream errors and zero-charge cleanup. Deployed-binding coverage and remaining Responses variants remain |
| Embeddings | OpenAI-compatible request/response and token billing | Partial | Worker handler fixtures cover URL/body/model restoration, input-only exact billing, access/account-capacity/provider-transient failover, deterministic request/permission/model no-retry, all-account exhaustion and exactly-once Pool/reservation cleanup; add deployed cross-provider E2E and remaining original variants |
| Anthropic Messages | `/v1/messages`, token counting, Anthropic SSE/errors | Partial | Native Anthropic URL/auth/body, synchronous usage, SSE terminal/usage/cancellation, count-tokens and retry fixtures pass. v0.33 adds strict generation controls, direct-account preservation, output-effort/sampling fallback mapping and count-token stripping. v0.34 validates and caps cache breakpoints, preserves native signed/redacted thinking, and maps compatible signed thinking plus Responses encrypted reasoning in buffered and streamed paths without replaying provider-specific redacted blobs across providers. Cache-token accounting, remaining `apicompat` variants and deployed E2E remain. |
| Gemini generateContent | `/v1beta/models/*`, streaming and Gemini error translation | Partial | Native Gemini generate/stream/countTokens/embedContent URL/auth/body, usage and terminal fixtures pass; port remaining multiplatform variants and add deployed E2E |
| Codex backend API | `/backend-api/codex/*`, manifest, Responses transport | Partial | Codex Responses now uses the provider planner with server-owned Bearer/account/originator headers, `store:false`, unsupported-field stripping and lossless system-message promotion to `instructions`. Handler fixtures cover Chat fallback through a Responses-only Codex account; add authenticated deployed E2E and remaining Codex tool/model normalization |
| Protocol conversion | Strict allow-listed bidirectional Chat/Responses fallback plus Anthropic/Gemini Responses adapters | Partial | Responses→Chat and Chat→Responses request, synchronous response, SSE lifecycle and isolated binding fixtures pass for Chat-only and Responses-only account cohorts. Compact and multi-line SSE, `response.done`/cancel aliases, terminal-output reconstruction, early terminal cancellation, reasoning, tools, usage details, failure fidelity, token controls, public-model restoration and pre-output semantic SSE failover are covered; failover stops after the first visible output and records retryable account failures exactly once. Native streamed compaction restores the `remote_compaction_v2` beta header and normalizes one final trigger before provider dispatch. Custom, namespace and dynamic `tool_search` declarations, history, completed discovery promotion, choice, buffered/SSE identity restoration, stable item IDs and collision rejection pass protocol and public-handler fixtures. Responses tool-result images and Anthropic base64 `tool_result` images are safely moved into ordered multimodal user messages without leaking image data into tool text. `service_tier` accepts the official values, normalizes `fast` to `priority`, rejects invalid values before reservation, and applies the required 2x/2.5x priority multiplier to both reservation and settlement. Cross-request trusted mapping, configurable per-model priority-price overrides, URL/file Anthropic tool media and remaining legacy `apicompat` fixtures remain |
| Model aliases/capabilities | Group-visible names, upstream override, channel mapping, endpoint and account capabilities | Partial | v0.30 resolves an active channel in the existing bounded route batch, gives exact mappings priority over suffix wildcards, expands wildcard targets, enforces `restrict_models` against mapping or channel-pricing coverage and restores the public model. Migration 0052 permits mixed concrete providers only inside composite groups while retaining concrete-group integrity; account discovery, Pool membership and platform quota admission stay pinned to the deterministically resolved concrete model platform. v0.31 also resolves exact and suffix-wildcard aliases that exist only in the channel catalog, while retaining the catalog model's real provider/upstream identity and failing closed on ambiguous backing models. v0.32 resolves and freezes the best channel price in that same batch, preserving the catalog price identity and rejecting equal-specificity ambiguity. Repository and handler tests pass; account-level/compact-only mapping, media channel pricing and deployed E2E remain |
| Multi-provider accounts | OpenAI-compatible, Anthropic, Gemini and Codex credential/config adapters | Partial | Migrations 0023/0026, D1-backed admin CRUD, versioned AES-GCM rotation and strict contracts pass; gateway repository selects same-platform accounts and handler fetches through provider plans. Native Anthropic/Gemini and Codex Responses fixtures pass, unsupported cross-protocol operations fail before fetch/state mutation, and the Worker frontend supports provider-specific create/edit/health contracts. Credential-free Cron/Queue jobs now run every provider's bounded probe adapter with CAS stale-result rejection; deployed E2E remains |
| Account scheduling | Weighted priority, concurrency leases, cooldown, sticky affinity, failover | Partial | Pool state-machine, handler and isolated Workerd binding tests cover renewable/idempotent leases, cooldown, bounded failover, and one-hour route-scoped HMAC affinity with failure/config invalidation and fallback rebinding. D1 excludes `unhealthy` accounts while retaining `unknown`; remaining mixed-provider preference variants and deployed E2E keep this Partial |
| User ingress limits on API-key requests | User-wide concurrency and user-wide RPM hard ceiling across every key/group | Done | These are user limits, not per-key RPM or concurrency fields. Migration 0022, user control/profile contracts and a user-partitioned SQLite Durable Object implement the original limits across all of a user's keys, using server-time fixed-minute windows, renewable leases, expiry reclaim, replay/release idempotency and fail-closed admission; state and every upstream gateway path have race/retry/disconnect contract tests |
| Group-scoped RPM policy | Group RPM plus per-(user, group) override, while preserving the user hard ceiling | Done | Migration 0022, group CRUD, bounded set-replacement override control APIs, frontend contracts and atomic admission enforcement pass group/override/user-ceiling, replay and isolation tests |
| API-key monetary limits | Per-key total quota plus 5h/1d/7d amount windows and reset lifecycle | Done | Migrations 0024/0025, Admin/User CAS contracts and the Keys UI use exact integer micros with independent total/window reset epochs. A user-sharded SQLite Durable Object enforces anti-oversell before Pool/fetch, tracks unlimited keys, renews long streams and rejects stale reset generations. Main billing, per-key settlement and monotonic D1 projection are persisted as three independently replayable recovery stages; race, reset, expiry, disconnect and migration fixtures pass locally. |
| User/platform quota | Balance reservation/settlement, subscription and platform windows | Done | Migration 0031 adds authoritative per-user/per-platform daily, weekly and monthly micro-unit windows plus registration defaults. Owner reads and admin default/user replace/reset APIs use ETag, CAS, idempotency and audit; `ApiKeyLimitDO` configures, reserves, settles and cancels platform holds before Pool selection while preserving the existing balance and subscription authorities. Migration, state-machine, HTTP and gateway handler tests pass locally. |
| Usage and billing API | `/v1/usage` and `/v1/sub2api/billing` with immutable price version | Partial | Routes and balance/subscription billing attribution exist. Migration 0041 projects platform, request type, inbound/upstream endpoint, billing mode and native-compaction dimensions; an explicit dimensions version distinguishes rolling-deploy writes from genuine `unknown` request types while legacy rows are backfilled. Migration 0053 adds immutable standard cost, matched account-stat price, account multiplier and final account cost snapshots to every text/image settlement and Queue projection. Migration 0054 adds a bounded immutable customer-pricing snapshot without rewriting historical usage. Text reservations and settlements freeze channel exact/longest-wildcard, interval, per-request, service-tier and timezone pricing; v0.35 extends the frozen decision to synchronous Images aliases and 1K/2K/4K tiers while preserving independent provider account costs. Queue replay retains the exact decision. Complete legacy aggregate/filter coverage, video pricing and deployed E2E remain. |
| Media generation | D1 task/job metadata, replay-safe Queue workflows, R2 media/ZIP artifacts, synchronous Worker-native Images execution and exact media billing | Partial | v0.21 proves owner-scoped batch Images; v0.25 completes buffered and live synchronous Images for direct API-key and Codex OAuth/setup-token accounts. v0.26 adds all ordinary async Images aliases with preflight validation/moderation, owner-key polling, an explicit at-most-once paid-work claim, synchronous pipeline reuse, R2-only request/result/image payloads, stale-task failure and prefix-complete 24-hour cleanup. v0.27 completes async `b64_json`, data-URL and remote-URL R2 rehosting with bounded HTTPS downloads, private-network/redirect rejection, raster magic validation and post-offload compensation. v0.28 bills every distinct provider-completed output up to the provider limit even when it exceeds requested `n`, using a replay-safe four-authority committed-reservation barrier and explicit balance spend debt. v0.29 adds an opt-in, bounded Gemini Batch provider-job bridge: D1 leases/versioned phases, safe ambiguous-submit lookup, exact custom-ID reconciliation, deterministic R2 outputs, reservation renewal, upstream cancellation-to-terminal and Cron repair. It is disabled by default and limited to at most 8 inline outputs under a conservative 18 MiB manifest threshold; larger jobs retain the proven per-item Queue path until Files/JSONL support lands. Video, audio/voice/live, realtime/WebSocket and deployed provider smoke remain Pending; see `LEGACY_GATEWAY_TEST_MAP.md` |
| Search extensions | Web/X search and provider-specific alpha routes | Planned | Explicit compatibility fixtures |
| Request policy | Bounded JSON bodies, gzip/deflate decoding, prompt policy and sensitive-data redaction | Partial | Raw and decompressed 2 MiB limits, encoding rejection, lenient-client JSON and pre-reservation failure tests pass; multipart, prompt policy and broader redaction remain |
| Realtime/WebSocket | Responses realtime session relay with Workers WebSocket pairs | Planned | Upgrade, relay, accounting, timeout and close-code tests |

## 2. Identity, user, and commercial plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| Public settings | KV cache backed by versioned D1 settings | Partial | Default/cache/invalidation tests |
| Available channel catalog | Authenticated, opt-in channel/group/model/price projection from normalized D1 rows | Partial | v0.30 adds a fail-closed public setting, bounded D1 batch, public-field whitelist, UUID group IDs, private/subscription/composite visibility, exact integer price conversion and Worker frontend route/table contracts. v0.31 adds authenticated default-price lookup and platform model-sync helpers backed by a small last-known-good bundled catalog, with exact integer microUSD internally and per-token USD at the legacy HTTP boundary. Dynamic remote catalog refresh, full LiteLLM coverage and deployed E2E remain |
| Password registration/login | D1 identity, Web Crypto hashes, Turnstile and Durable Object rate limits | Done | Registration/login, exact/wildcard email-suffix policy, Turnstile, fail-closed limiter and enumeration-boundary tests |
| Sessions | Hashed refresh tokens, rotation, logout/revoke, device/session list | Done | Rotation/replay/logout plus current-device list, selective/family, other-device and all-device revocation race tests |
| Email challenges | Queue-delivered registration verification, authenticated email verification, password reset, account binding, notification email and TOTP challenges | Partial | Atomic consumption/replay, address binding, expiry, concurrent reset, rate-limit, delivery lease and tamper tests pass. v0.34 adds one fail-closed delivery boundary: challenge issuance requires a binding, transient failures retry, deterministic failures terminate, and only content-free error codes persist. Native `SEND_EMAIL` and idempotent `EMAIL_DELIVERY` paths are covered locally; a verified production sender and deployed delivery E2E remain required. |
| OAuth identities | D1-backed provider adapters and safe identity linking | Done | GitHub, Google, LinuxDo, DingTalk, WeChat and generic OIDC share one Worker-native flow with one-time state, PKCE, browser/session binding, encrypted verifier storage, account-conflict protection and identity lifecycle tests. OIDC additionally verifies RS256/JWKS, issuer, audience, expiry, nonce and userinfo subject; LinuxDo's userinfo email is deliberately untrusted. New users are created atomically only from a verified, previously unused provider email while registration is open; an existing email is never auto-linked. Promo, invitation and affiliate inputs are sealed into the OAuth flow and consumed/attributed in the same conditional registration batch, with SQLite tests proving one-time code use. Link/unlink operations revalidate session and auth versions inside conditional D1 writes, including concurrent last-method protection. Anonymous starts have an IP-only Durable Object budget plus atomic global/per-browser active-flow caps, and Cron removes expired flow/ticket rows in bounded indexed batches. Provider configuration is encrypted, versioned, audited, disabled by default and exposed through the Worker settings UI without returning secrets. The legacy pending-account chooser remains deferred. |
| TOTP and step-up | Encrypted TOTP secret, recovery codes and privileged-action challenge | Done | Worker-native RFC 6238 setup/login/disable and session-bound 15-minute step-up pass owner, expiry, attempt-limit, replay, CAS, Queue delivery and encrypted-secret tests. Migration 0028 adds ten one-time 80-bit recovery codes with environment/owner-bound HMAC storage, atomic login/step-up consumption, CAS whole-set rotation, remaining-count status and one-time frontend handoff. |
| Passkeys | WebAuthn challenge state and credential lifecycle | Done | Worker Web Crypto implements ES256/P-256 registration and usernameless authentication with explicit RP/origin policy, user verification, one-time challenges, sign-counter CAS, concurrent replay protection, credential rename/removal, bounded payloads and authenticated profile UI contracts. Registration binds the challenge to the initiating session/auth version and atomically revalidates both after WebAuthn verification. Public advertising fails closed unless both the deployment and admin feature flag are configured, while the admin projection safely exposes RP readiness without trusting request headers. |
| User profile | Profile, password security, R2 avatar, linked identities and notification preferences | Partial | Profile/update/password/avatar routes plus D1-versioned notification settings and verified notification-email lifecycle have owner, CAS, bounded-rate, Queue lease and native/compatibility delivery tests. OAuth identities are projected into the current-user/profile contract with owner-scoped list, bind and unlink behavior. Migration 0037 adds session/auth-version-bound email/password binding for OAuth-only accounts, exact/wildcard suffix enforcement, indexed normalized-mailbox uniqueness across every user write path, code-before-password verification, shared authentication rate limiting, atomic challenge consumption, session revocation and profile UI coverage. Migration 0039 adds private defaults for all seven authentication sources and exactly-once signup/first-bind balance, concurrency, subscription and platform-quota grants. First-bind balance crosses D1 and UserStateDO through a durable idempotent effect, while subscription configuration uses the existing globally recoverable sync intent. The Worker settings UI now edits every source's signup/first-bind defaults with CAS/idempotency and no secret projection; deployed identity E2E remains. |
| User API keys | Create/list/update/revoke; raw token returned once | Done | Hashing, redaction, expiry, revocation, owner isolation and private/subscription-group access tests |
| Usage/dashboard | User usage pages, aggregates, model plaza and quota windows | Partial | Owner-scoped list/detail/stats/trend/model/snapshot/API-key daily usage routes, platform-quota views and the `/api/v1/model-plaza` catalog exist. Usage history offers bounded `(occurred_at_ms,event_id)` cursor pagination while retaining a capped legacy page contract. Migration 0041 adds request-type, native-compaction and billing-mode filters, inbound-endpoint stats, platform dashboard totals and accurate compact/cyber classification. Model plaza tests prove fail-closed settings, optional authentication, private-group authorization, aliases, effective prices/multipliers and secret redaction. The `snapshot-v2` aggregate fixture is pinned to a deterministic clock and passes locally; broader legacy aggregate parity and deployed E2E remain open. |
| Subscription plans | Plans, user subscriptions, renewals and usage windows | Done | Public/admin plan CRUD, user list/progress, redeem assignment/extension and gateway quota enforcement pass. Migration 0036 adds an immutable per-order entitlement-term ledger; concurrent paid renewals, expired restarts, cumulative partial refunds, exact duration rounding, later-renewal preservation and pending-refund rollback pass locally. |
| Redemption/invitations | Atomic redeem, administrative lifecycle, invitation rewards, exhaustion and expiry | Partial | Balance/subscription redemption plus hashed one-time admin generation, CAS batch lifecycle, idempotency, expiry and race tests pass. Migration 0032 adds normalized/HMAC invitation codes, encrypted admin display, validation, ETag/idempotent CRUD, atomic password/OAuth registration consumption, last-slot concurrency protection and immutable affiliate attribution. A separate registration-time invitation reward, if retained beyond promo credit and purchase commission, remains to be specified and tested. |
| Promotions | Promo validation, applicability and one-time consumption | Done | Migration 0032 and Worker handlers cover normalized/HMAC lookup, encrypted code storage, disabled/expired/exhausted validation, atomic registration credit and per-user/last-slot protection. Admin create/update/delete require Idempotency-Key, updates/deletes require a control version, detail/create/update return ETag, and guarded D1 batches prevent CAS losers from emitting audit rows; promotion and registration tests pass locally. |
| Payments | D1 orders/provider config, Stripe signed webhooks, R2 receipts/evidence, Queue/DO subscription fulfillment, refunds and reconciliation | Partial | Worker order/config/currency/Stripe/webhook/fulfillment/refund/admin suites pass. D1 atomically admits pending/daily limits, Stripe and D1 share a >=30m expiry, Cron expires sessions, and late payments enter refund reconciliation. Owner-scoped immutable JSON receipts are materialized to R2 with retry/concurrency tests. Migrations 0033/0034 and admin handlers provide a bounded tuple-seek scanner, stable overwrite-in-place R2 evidence, filters/detail and idempotent acknowledge/resolve/reopen actions for nine tested anomaly classes. Migration 0036 makes subscription renewal and proportional/cumulative entitlement clawback exactly-once, including provider-pending compensation and Stripe cumulative rounding. Affiliate clawback/recovery is exactly-once locally; ancillary failures never overwrite a committed provider/D1 refund result. Retained non-Stripe providers, authenticated production E2E and deployed recovery drills remain. |
| Affiliate | Referral attribution, commission ledger and payout views | Done | Migrations 0032/0035 make attribution and earning/transfer/adjustment/debt-repayment ledgers immutable, with private rate/freeze/duration/per-invitee-cap policy. Password and OAuth registration attribution, payment-fulfillment accrual, owner/admin summaries, net invitee/rebate records, timezone-aware record filters and idempotent UserStateDO transfer-to-balance are covered locally. Partial/full refunds create exactly-once compensating entries across frozen, available and already-transferred commission; unavailable transferred balance becomes visible debt that later commissions repay first. Duplicate/concurrent refunds and lost or unavailable DO responses converge through the existing refund recovery job. Legacy cash payout is intentionally replaced by internal balance transfer. |
| Announcements | Published audience-aware announcements and acknowledgement | Done | Migration 0038 and Worker/frontend contracts cover audited CRUD, ETag/CAS/idempotency, active windows, bounded OR-of-AND subscription/balance targeting, owner-scoped reads, unread/popup projection and paged admin eligibility/read status. |

Password admission deliberately uses one environment-scoped `AuthRateLimitDO` coordinator so the
IP and account budgets are checked and consumed atomically. Do not shard it by only one of those
dimensions: that would turn dual-dimension admission into a fallible cross-object transaction.
Deploy Cloudflare WAF rate limits in front of the password endpoints as the volumetric outer layer;
the Durable Object remains the identity-aware, fail-closed inner layer.

Commercial storage rules:

- D1 is the persistent source for identities, orders, subscriptions, plans, and query projections.
- A per-user Durable Object serializes balance, quota, and redemption mutations; D1 row-version CAS
  protects API-key auth-version updates without adding a Durable Object round trip.
- D1 CAS and immutable event rows serialize order, webhook, and refund transitions; the
  per-subscription Durable Object remains the authority for entitlement and quota state.
- Payment order admission rechecks pending-count and daily-spend limits inside the same conditional
  D1 insert that atomically records `order.created`; application-level preflight reads are not an
  authority. A paid callback after expiry/cancellation is recorded in R2 and D1 as a recoverable
  refund request and never creates fulfillment work.
- KV contains disposable public/config caches only; it is never financial truth.
- Queue consumers lease email delivery and retry only transient failures.
  Bounded Cron recovery resumes subscription fulfilment, missed affiliate
  accruals, refund entitlement rollback and affiliate refund clawback;
  migration 0035 persists unrecoverable transferred commission as debt instead of failing a settled refund.
  The compatibility email adapter receives a stable idempotency key, while native email retries
  retain the same event ID for reconciliation after ambiguous send outcomes.
- R2 stores exports, receipts, avatars, and long-lived audit artifacts where appropriate.

## 3. Administration and operations plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| Break-glass admin auth | Constant-time Bearer secret for bootstrap and recovery only | Done | `test/control/admin-auth.test.ts` |
| Admin sessions/RBAC | D1 sessions plus granular roles, immutable permission grants, assignment audit, deny-by-default route authorization and last-super-admin protection | Partial | Normal user-access and independent break-glass recovery sessions, RBAC lifecycle, CAS/idempotency, immutable built-ins, route permission categories and last-super-admin protection pass. Migration 0027 adds an opt-in, D1-authoritative, session-bound TOTP step-up gate for unsafe methods plus exact same-origin enforcement; recovery sessions deliberately remain emergency elevation but still pass the origin boundary. Deployed browser/admin E2E remains |
| User management | List/create/detail/update/disable, password reset, persistent idempotency, metadata CAS, DO-versioned balance mutation and immutable financial history | Partial | Admin-created login-capable users, password reset with session revocation, concurrency/RPM fields and the frontend UUID adapter pass route/state/SQLite and concurrency tests. Migration 0055 projects exact balance/debt deltas through the UserStateDO outbox; v0.34 adds the signed, one-page `admin.users.write` backfill and migration 0056 actor audit. Migration 0057/v0.35 adds bounded administrator-created batches with persistent cursors, leases, CAS, idempotent continuation and explicit manual reconciliation for proven pre-v0.34 rollback gaps. Automatic batch discovery, production E2E and normal admin authentication remain. |
| API-key management | User key create/list/update/revoke, persistent idempotency/CAS, HMAC storage and one-time secret display | Partial | Admin and user self-service routes cover hashing, one-time secrets, group authorization, exact monetary limits, independent usage resets, optimistic concurrency and hot-usage lost-update protection. Migration 0059/v0.37 retains custom tokens with keyed-HMAC-only persistence and adds canonical IPv4/IPv6 allow/deny policy sourced only from `CF-Connecting-IP`; Worker-mode frontend controls and spoofing/CAS tests pass. `last_used_ip` remains privacy-preserving `null`; production E2E and normal admin authentication remain. |
| Groups/models/prices | Core group/model CRUD, CAS, catalog visibility, integer multiplier and append-only active prices exist; duplicate, atomic batch sort and advanced pricing remain | Partial | Worker control/gateway unit tests, manual local trigger checks, and an isolated Workerd E2E that bootstraps a model/price and publishes its group through the admin API pass; advanced catalog behavior and production smoke remain |
| Accounts/channels | Provider accounts plus normalized public channels, group links, mappings and exact pricing graphs | Partial | Existing provider CRUD, AES-GCM credentials, Pool sync and bounded health probes remain. v0.35 adds synchronous-image alias/wildcard tier pricing without collapsing account costs into customer charges. Migration 0058/v0.36 adds guarded 25-account enable/disable and Queue probe batches. Migration 0060/v0.37 adds bounded manual account/model/capability inference probes with version snapshots, immutable history, three-failure firing/recovery events and bounded Cron dispatch/lease recovery without mutating whole-account health. Frontend controls, alert delivery, provider quota/tier/privacy, video pricing and production E2E remain. |
| Usage/finance | Request ledger, user financial events, aggregates, reconciliation and corrective workflows | Partial | Owner-scoped usage views, subscription projections, payment dashboard and reconciliation actions exist. Migration 0055 adds the Queue-fed immutable per-user balance/debt ledger; v0.34 adds resumable 100-row DO history reconstruction and migration 0056 actor audit. Migration 0057/v0.35 adds bounded batch/user/page coordination, signed-cursor persistence, leases, CAS, idempotency and explicit manual reconciliation. Automatic discovery, broader aggregates, cross-domain corrections/exports and production E2E remain. |
| Settings | Typed versioned settings, audit and KV invalidation | Partial | Core versioned read/write, normalized email-suffix policy, optimistic concurrency, idempotency, secret redaction, D1-authoritative privileged-operation step-up and KV invalidation tests pass. Migration 0039 adds typed, private admin round-tripping for email/LinuxDo/OIDC/WeChat/DingTalk/GitHub/Google signup and first-bind entitlement defaults without leaking them into public KV. The Worker UI now exposes those defaults with per-source CAS saves; the wider retained legacy settings surface remains. |
| Unified audit trail | Read-only cross-domain D1 event stream with stable cursor and allowlisted detail | Partial | Settings, RBAC, channel, account, auth, payment and financial-history backfill events share bounded list/detail routes behind `admin.audit.read`; migrations 0051/0056/0057/0058 add immutable channel, per-user backfill, batch and account-operation actor audit. Frontend uses cursor pagination and exposes no destructive clear action. Request/error, retention and remaining domain sources remain. |
| Announcements/compliance | Editorial lifecycle, audit views and risk actions | Partial | Migration 0038 provides the announcement editorial lifecycle, immutable domain audit, audience targeting, read status and operations-RBAC routing. Separate compliance case/risk-action workflows remain planned. |
| Admin dashboard | Payment summaries exist; broader hourly/daily operational facts remain | Partial | Cross-currency payment dashboard, filters and UTC-series tests pass |
| Request/error explorer | D1 metadata index, R2 payload/archive, redaction and retention | Partial | Migration 0040, owner/admin route suites and gateway lifecycle hooks cover fixed tuple-seek cursors, authorization, recursive secret redaction, 96 KiB payload bounds, R2 retry, related-upstream lookup, 30-day retention, metadata repair and orphan cleanup. Admin resolve/reopen uses operations-write RBAC, CAS, idempotency, immutable server-derived actor audit and frontend conflict refresh. Arbitrary fuzzy search/sort/exact totals are intentionally removed; richer timing dimensions and deployed E2E remain. |
| Alerts/silences/reports | Scheduled rules, HTTP/email/webhook delivery, retries and silences | Planned | Scheduler and delivery fixtures |
| Channel monitor | Scheduled account/model tests and bounded failure actions | Partial | Generic Cron account health plus Pool removal/reactivation remains. Migration 0060/v0.37 adds manual per-model Queue inference probes, provider-native response validation, invalid-response/timeout/HTTP classification, immutable history, replay-safe firing/recovery state and bounded outbox/expired-lease recovery on real SQLite/D1. Frontend controls, silences, reports and notification delivery remain. |
| Account lifecycle | Token refresh, quota sync, cooldown and reactivation | Partial | Migration 0026 and Cron/Queue tests cover encrypted credential re-read, all four provider health adapters, CAS generations, exponential cooldown, successful reactivation and monotonic Pool revisions. Migration 0058/v0.36 exposes guarded batch dispatch through the same durable outbox and rejects stale results after configuration changes. Token refresh is not applicable to the current API-key credential contract; quota/tier/privacy synchronization remains explicitly unsupported until a provider exposes documented stable APIs. |
| Maintenance jobs | Cursorized cleanup, aggregation, backfill and recovery | Partial | Settlement, subscription-state, payment-fulfillment, missed affiliate accrual, refund rollback/clawback, cursorized payment-reconciliation scanning, leased account-health outbox recovery, request-observation retention, bounded post-parent resolution-audit cleanup, R2 metadata repair and orphan cleanup exist; add cross-domain retention suites and deployed recovery drills |
| Prompt audit | Policy events and protected payload storage | Planned | Redaction and retention tests |
| Backup/restore | Export versioned D1 records and R2 manifests; verified restore workflow | Partial | v0.34 adds the strict local bundle. v0.36 adds canonical staging/production remote plans, D1 Wrangler argument arrays, manifest/empty-target verification, contract-only fail-closed gates, independent read-back proof for executable steps and an atomic resumable journal. DO/R2 transports are deliberately contract-only, so privileged executors, R2 content locators and an empty-environment drill remain. |

Cloudflare background execution uses a transactional outbox, bounded Queue consumers, a minute
Cron dispatcher for persisted due jobs, and Durable Object alarms only for entity-local leases or
windows. Long operations are cursorized and resumable; failures enter a DLQ with an admin replay
workflow.

## 4. Explicit host-feature removals and replacements

| Original feature | Decision | Cloudflare outcome |
| --- | --- | --- |
| Local data-management agent | Remove | D1/R2 export, import, backup and restore routes |
| Outbound proxy inventory | Remove | Direct Worker `fetch`; document Cloudflare egress constraints |
| TLS fingerprints, uTLS, JA3 | Remove | No Worker equivalent; provider compatibility must use supported HTTP semantics |
| Dynamic server plugins | Remove | Compile-time provider adapters and feature flags |
| App self-update/restart/rollback | Replace | Cloudflare deployments, versions and rollback procedures |
| Host CPU/RAM/disk metrics | Replace | Worker Analytics, application counters and queue/backlog metrics |
| Local log-file browser | Replace | Structured request/error index in D1 with bounded R2 archives |
| Long in-process schedulers | Replace | Cron, Queue, Durable Object alarms and persisted job cursors |

The frontend must remove all controls for capabilities marked Remove and relabel replacement
workflows so operators are never offered an action that Workers cannot perform.

## 5. Test-source mapping

The original repository remains the behavioral reference. Migration work must port or supersede the
following suites rather than relying only on newly invented happy-path tests:

The repeatable local binding gate is `pnpm run test:e2e:bindings` from
`worker/`. It uses `wrangler.e2e.jsonc`, all D1 migrations and isolated
Miniflare storage, and executes the D1, KV, R2, Queue producer/consumer,
UserStateDO, AuthRateLimitDO, ApiKeyLimitDO and PoolStateDO bindings. It does
not claim deployed-production coverage; a separate authenticated deployed smoke
remains part of the Deployment acceptance gate.

- Gateway routing: `backend/internal/server/routes/gateway_test.go` and
  `backend/internal/integration/e2e_gateway_test.go`.
- Protocol conversion: `backend/internal/pkg/apicompat/*_test.go`.
- Provider/gateway behavior: `backend/internal/service/openai_*_test.go`,
  `gateway_multiplatform_test.go`, and `gemini_multiplatform_test.go`.
- Billing and limits: `billing_service_test.go`,
  `gateway_service_subscription_billing_test.go`, `concurrency_service_test.go`,
  `billing_cache_service_rpm_test.go`, and `concurrency_cache_integration_test.go`.
- Identity: `auth_service_register_test.go`, `auth_session_revocation_test.go`,
  `integration/e2e_user_flow_test.go`, and `passkey_handler_test.go`.
- Commerce: `subscription_*_test.go`, `redeem_service_*_test.go`,
  `payment_webhook_handler_test.go`, `payment_fulfillment_test.go`,
  `payment_refund_test.go`, and `affiliate_service_test.go`.
- Frontend: legacy auth, payment, user, and admin tests must be mapped to the new API client and
  supplemented by a deployed-Worker smoke suite.

The legacy backend contains roughly 1,200 Go test files and the frontend roughly 250 test files.
The migration is not accepted by matching those counts; it is accepted when every retained behavior
has an equivalent Worker unit, integration, contract, or E2E proof and every removed behavior has no
remaining API or UI affordance.

## Remaining delivery milestones

The remaining work is ordered by end-user value. Each milestone must keep the guarded release order
of tests, asset build, target D1 migrations, Worker deployment, and production smoke checks.

1. **Payment closure**: the Stripe slice now has server-priced hosted checkout, encrypted
   provider configuration, signed webhook ingestion, R2 evidence and owner receipts, idempotent
   subscription fulfilment, refund state recovery, subscription/affiliate clawback, a tuple-seek
   reconciliation scanner with bounded R2 evidence and guarded admin actions. Paid renewals now
   have per-order term accounting and exact cumulative refund compensation. Remaining work is the
   retained non-Stripe providers, authenticated production E2E and deployed recovery drills. The
   order state machine and webhook verification are production implementations, not stubs.
2. **Gateway fidelity**: normalized OpenAI, Anthropic, Gemini, and Codex provider adapters;
   request/error/stream conversion fixtures; bounded failover, cooldown, route-scoped session affinity,
   request-size policy, and accounting reconciliation are Worker-native. User concurrency, user/group
   RPM admission, API-key total plus 5h/1d/7d monetary windows, and per-platform daily/weekly/monthly
   quotas are atomically enforced before Pool leases. Remaining work is the long tail of original
   protocol variants and deployed cross-provider E2E.
3. **Identity completion**: email verification, password reset, versioned notification-email
   preferences, TOTP, recovery codes, privileged-operation step-up, Passkeys and six OAuth/OIDC
   identity adapters are implemented in the Worker. OAuth-only accounts can now atomically bind a
   verified mailbox and password without weakening session security. All seven authentication sources
   have private signup/first-bind defaults backed by an exactly-once grant ledger and recoverable
   Durable Object effects, plus a CAS-protected Worker settings UI. Production still needs a verified
   Email Service sender, deployed identity E2E and the optional legacy pending-account chooser.
4. **Media and realtime**: v0.21 delivers the batch Images tracer bullet: the frontend-used
   `/v1/images/batches` submit/list/models/get/items/cancel/delete-record and item/ZIP download
   surface, deterministic output expansion, exact successful-item settlement, replay-safe Queue/CAS
   recovery and private R2 artifacts. v0.25 adds the user-critical synchronous generations/edits
   path for direct API-key and Codex Responses-tool accounts, including incremental Codex SSE and
   byte-exact native Direct SSE with JSON fallback,
   bounded disconnect drain, no-duplicate paid-output commitment, request-local account exclusion,
   all monetary/concurrency hold renewal and queryable actual image-size billing evidence. v0.26
   adds ordinary asynchronous submit/poll/content routes using atomic Queue claims, D1 lifecycle
   metadata and private R2 request/result/image objects with scheduled expiry cleanup. v0.27 completes
   async data-URL and remote-URL rehosting with 8 MiB inline and 32 MiB remote per-image bounds, HTTPS/private-network guards,
   disabled redirects, byte-signature MIME validation and cleanup after result persistence failure.
   v0.28 removes requested-`n` output truncation and adds exact over-delivery settlement across
   user/subscription, API-key and platform quota authorities before any individual ledger settles.
   v0.29 adds the first real Gemini Batch provider-job path for small inline jobs, with D1-owned
   leases/phases, replay-safe Queue and Cron dispatch, safe create-ambiguity recovery, exact result-ID
   reconciliation, deterministic R2 materialization, renewable holds and provider-terminal cancellation.
   The rollout flag remains off by default; Files/JSONL input and large-job streaming are still required
   before the full 200-output surface moves off the per-item fallback. Remaining media work includes all video,
   audio/voice/live and realtime/WebSocket functionality. Production provider smoke remains a
   separate deployment gate. Provider-specific internals may be simplified only when the retained
   public behavior has an explicit compatibility decision.
5. **Operations and governance**: granular admin RBAC, a bounded immutable audit reader, payment
   dashboard, payment-reconciliation actions and a first request/error Explorer with D1/R2 retention
   exist; request/error resolve/reopen now has CAS and immutable actor audit. Remaining work is broader
   audit sources and dashboard facts, Explorer richer timing,
   alerts and silences, per-model synthetic channel probes, non-payment finance corrections, DLQ replay,
   cross-domain retention, and verified D1/R2 export-and-restore.
6. **Secondary product features**: v0.19 has the model plaza, platform quotas, promotions,
   invitation admission, affiliate transfer/refund-clawback and targeted announcement slices.
   v0.30 adds the authenticated available-channel catalog, normalized admin channel graph, Worker
   frontend administration and gateway exact/wildcard channel mapping with restricted-model policy,
   including concrete-provider Pool selection and quota enforcement for composite groups.
   v0.31 completes account-stat pricing rules, catalog-external aliases, default-price/model-sync
   helpers, immutable upstream-cost snapshots and the bounded account-statistics query path.
   v0.32 completes text channel-price reservation/settlement, immutable Queue snapshots,
   the account-stat application toggle and reachable Worker frontend contract closure.
   Remaining work is media channel pricing, any retained standalone registration-time invitation reward, search extensions,
   prompt audit, broader usage aggregate parity, compliance risk actions and deployed browser/production
   E2E for these paths.
