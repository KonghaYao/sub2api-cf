# Cloudflare Workers migration matrix

This document is the acceptance ledger for replacing the original Go/Vue deployment with a
Cloudflare-only implementation. A row is complete only when its Worker route and storage model
exist, its legacy behavior has an explicit compatibility decision, and automated tests prove the
public contract.

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
| Deployment | Remote migrations, Worker deploy, production smoke, and rollback notes are verified | Partial |

## 1. Gateway and protocol plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| OpenAI model list | D1-backed group/model catalog at `/v1/models` and `/models` | Partial | Worker handler tests and root alias; add deployed-binding contract |
| Chat Completions | `/v1/chat/completions` and `/chat/completions`, streaming and non-streaming | Partial | Worker gateway fixtures cover terminal-without-EOF for Chat/Responses plus native Anthropic/Gemini streams, exact-usage disconnect draining, 10s idle/30s total drain bounds, and single settlement/release; deployed E2E and remaining legacy variants remain |
| Responses | `/v1/responses`, `/responses`, compact and input-token subroutes | Partial | Existing core tests; add subroute fixtures |
| Embeddings | OpenAI-compatible request/response and token billing | Partial | Worker protocol/handler fixtures pass; port the remaining original embedding handler/service fixtures |
| Anthropic Messages | `/v1/messages`, token counting, Anthropic SSE/errors | Partial | Native Anthropic URL/auth/body, synchronous usage, SSE terminal/usage/cancellation, count-tokens and retry fixtures pass; port the remaining `apicompat` variants and add deployed E2E |
| Gemini generateContent | `/v1beta/models/*`, streaming and Gemini error translation | Partial | Native Gemini generate/stream/countTokens/embedContent URL/auth/body, usage and terminal fixtures pass; port remaining multiplatform variants and add deployed E2E |
| Codex backend API | `/backend-api/codex/*`, manifest, Responses transport | Partial | Codex Responses now uses the provider planner with server-owned Bearer/account/originator headers and `store:false`; add authenticated deployed E2E and provider lifecycle coverage |
| Protocol conversion | Strict allow-listed Responses-to-Chat fallback plus Anthropic/Gemini Responses adapters | Partial | Responses request, synchronous response, SSE lifecycle and integrated Chat-only account fixtures pass; reverse Chat-to-Responses routing and remaining legacy `apicompat` fixtures remain |
| Model aliases/capabilities | Group-visible names, upstream override, endpoint and account capabilities | Partial | Repository selection and model visibility tests |
| Multi-provider accounts | OpenAI-compatible, Anthropic, Gemini and Codex credential/config adapters | Partial | Migration 0023, D1-backed admin CRUD, versioned AES-GCM rotation and strict contracts pass; gateway repository selects same-platform accounts and handler fetches through provider plans. Native Anthropic/Gemini and Codex Responses fixtures pass, unsupported cross-protocol operations fail before fetch/state mutation, and the Worker frontend supports provider-specific create/edit/health contracts. Deployed E2E and scheduled lifecycle probes remain |
| Account scheduling | Weighted priority, concurrency leases, cooldown, sticky affinity, failover | Partial | Durable Object state-machine plus integration tests |
| User ingress limits on API-key requests | User-wide concurrency and user-wide RPM hard ceiling across every key/group | Done | These are user limits, not per-key RPM or concurrency fields. Migration 0022, user control/profile contracts and a user-partitioned SQLite Durable Object implement the original limits across all of a user's keys, using server-time fixed-minute windows, renewable leases, expiry reclaim, replay/release idempotency and fail-closed admission; state and every upstream gateway path have race/retry/disconnect contract tests |
| Group-scoped RPM policy | Group RPM plus per-(user, group) override, while preserving the user hard ceiling | Done | Migration 0022, group CRUD, bounded set-replacement override control APIs, frontend contracts and atomic admission enforcement pass group/override/user-ceiling, replay and isolation tests |
| API-key monetary limits | Per-key total quota plus 5h/1d/7d amount windows and reset lifecycle | Partial | A user-sharded SQLite Durable Object implements versioned per-key integer-micro configure/reserve/settle/cancel state, atomic anti-oversell, exact rolling-window boundaries, expiry recovery and replay safety. D1 configuration projection, admin writes, gateway admission/settlement wiring and explicit usage reset remain |
| User/platform quota | Balance reservation/settlement, subscription and platform windows | Partial | Per-subscription SQLite Durable Object prevents quota oversell and projects settlements idempotently; platform-level quota APIs remain |
| Usage and billing API | `/v1/usage` and `/v1/sub2api/billing` with immutable price version | Partial | Routes and balance/subscription billing attribution exist; complete legacy aggregate/filter coverage |
| Media generation | Images, async/batch images, video, voice/live and task polling | Planned | Provider fixtures, R2 artifacts, Queue workflow tests |
| Search extensions | Web/X search and provider-specific alpha routes | Planned | Explicit compatibility fixtures |
| Request policy | Bounded JSON bodies, gzip/deflate decoding, prompt policy and sensitive-data redaction | Partial | Raw and decompressed 2 MiB limits, encoding rejection, lenient-client JSON and pre-reservation failure tests pass; multipart, prompt policy and broader redaction remain |
| Realtime/WebSocket | Responses realtime session relay with Workers WebSocket pairs | Planned | Upgrade, relay, accounting, timeout and close-code tests |

## 2. Identity, user, and commercial plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| Public settings | KV cache backed by versioned D1 settings | Partial | Default/cache/invalidation tests |
| Password registration/login | D1 identity, Web Crypto hashes, Turnstile and Durable Object rate limits | Done | Registration/login, Turnstile, fail-closed limiter and enumeration-boundary tests |
| Sessions | Hashed refresh tokens, rotation, logout/revoke, device/session list | Done | Rotation/replay/logout plus current-device list, selective/family, other-device and all-device revocation race tests |
| Email challenges | Queue-delivered registration verification, authenticated email verification, and password reset challenges with expiry and attempt limits | Partial | Atomic consumption/replay, address binding, expiry, concurrent reset, rate-limit, delivery lease, tamper and retry tests pass; native `SEND_EMAIL` and compatibility `EMAIL_DELIVERY` paths are covered, while a verified production sender and deployed delivery E2E remain required |
| OAuth identities | Provider adapters and safe identity linking | Planned | Callback/link-conflict tests |
| TOTP and step-up | Encrypted TOTP secret, recovery codes and privileged-action challenge | Partial | Worker-native RFC 6238 setup/login/disable and session-bound 15-minute step-up pass owner, expiry, attempt-limit, replay, CAS, Queue delivery and encrypted-secret tests; recovery codes remain |
| Passkeys | WebAuthn challenge state and credential lifecycle | Planned | Port passkey handler tests |
| User profile | Profile, password security, R2 avatar, linked identities and notification preferences | Partial | Profile/update/password/avatar routes plus D1-versioned notification settings and verified notification-email lifecycle have owner, CAS, bounded-rate, Queue lease and native/compatibility delivery tests; linked identities remain |
| User API keys | Create/list/update/revoke; raw token returned once | Done | Hashing, redaction, expiry, revocation, owner isolation and private/subscription-group access tests |
| Usage/dashboard | User usage pages, aggregates, model plaza and quota windows | Partial | Owner-scoped list/detail/stats/trend/model/snapshot/API-key daily usage routes and frontend contracts pass; model plaza and platform-quota views remain |
| Subscription plans | Plans, user subscriptions, renewals and usage windows | Partial | Public/admin plan CRUD, user list/progress, redeem assignment/extension and gateway quota enforcement pass; payment renewal remains |
| Redemption/invitations | Atomic redeem, administrative lifecycle, invitation rewards, exhaustion and expiry | Partial | Balance/subscription redemption plus hashed one-time admin generation, CAS batch lifecycle, idempotency, expiry and race tests pass; invitation rewards remain |
| Promotions | Promo validation, applicability and one-time consumption | Planned | Promo boundary and idempotency tests |
| Payments | D1 orders/provider config, Stripe signed webhooks, R2 evidence, Queue/DO subscription fulfillment and Stripe refunds | Partial | Worker order/config/currency/Stripe/webhook/fulfillment/refund/admin suites pass. v0.8 checkout is USD-plan-only, balance top-up stays disabled, D1 atomically admits pending/daily limits, Stripe and D1 share a >=30m expiry, cron expires sessions, late payments enter refund reconciliation, and subscription refunds claw back or restore entitlement exactly once. Add receipts, reconciliation views and retained providers |
| Affiliate | Referral attribution, commission ledger and payout views | Planned | Port affiliate service suites |
| Announcements | Published audience-aware announcements and acknowledgement | Planned | Visibility and acknowledgement tests |

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
- Queue consumers lease and retry email delivery and project fulfillment/refund/affiliate events;
  the compatibility email adapter receives a stable idempotency key, while native email retries
  retain the same event ID for reconciliation after ambiguous send outcomes.
- R2 stores exports, receipts, avatars, and long-lived audit artifacts where appropriate.

## 3. Administration and operations plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| Break-glass admin auth | Constant-time Bearer secret for bootstrap and recovery only | Done | `test/control/admin-auth.test.ts` |
| Admin sessions/RBAC | D1 sessions plus granular roles, immutable permission grants, assignment audit, deny-by-default route authorization and last-super-admin protection | Partial | RBAC lifecycle, CAS/idempotency, immutable built-ins, route permission categories and recovery tests pass; normal login, step-up and explicit CSRF/origin enforcement remain |
| User management | List/create/detail/update/disable, password reset, persistent idempotency, metadata CAS and DO-versioned balance mutation | Partial | Admin-created login-capable users, password reset with session revocation, concurrency/RPM fields and the frontend UUID adapter pass route/state/SQLite and concurrency tests; add deployed-binding E2E and normal admin authentication |
| API-key management | User key create/list/update/revoke, persistent idempotency/CAS, HMAC storage and one-time secret display | Partial | Route, hashing, concurrency and invalidation tests; add user self-service and deployed-binding E2E |
| Groups/models/prices | Core group/model CRUD, CAS, catalog visibility, integer multiplier and append-only active prices exist; duplicate, atomic batch sort and advanced pricing remain | Partial | Worker control/gateway unit tests plus manual local migration and trigger checks; add binding E2E |
| Accounts/channels | OpenAI, Anthropic, Gemini and Codex account CRUD, AES-GCM credential rotation, group/model links, revisioned Pool sync and bounded manual provider health probes exist; channels, quota and provider lifecycle remain | Partial | Real SQLite/D1 provider CRUD/migration/repository tests, request/health/handler-native provider fixtures and frontend provider create/edit/health contracts pass; add deployed-binding E2E and scheduled lifecycle probes |
| Usage/finance | Request ledger, aggregates, reconciliation and corrective workflows | Partial | Owner-scoped user aggregates and subscription projections exist; admin reconciliation and corrective workflows remain |
| Settings | Typed versioned settings, audit and KV invalidation | Done | Versioned read/write, optimistic concurrency, idempotency, secret redaction and KV invalidation tests |
| Unified audit trail | Read-only cross-domain D1 event stream with stable cursor and allowlisted detail | Partial | Settings, RBAC, auth and payment events share bounded list/detail routes behind `admin.audit.read`; frontend uses cursor pagination and exposes no destructive clear action. Request/error, retention and remaining domain sources remain |
| Announcements/compliance | Editorial lifecycle, audit views and risk actions | Planned | RBAC and lifecycle tests |
| Admin dashboard | Payment summaries exist; broader hourly/daily operational facts remain | Partial | Cross-currency payment dashboard, filters and UTC-series tests pass |
| Request/error explorer | D1 metadata index, R2 payload/archive, redaction and retention | Planned | Search, authorization, redaction and expiry tests |
| Alerts/silences/reports | Scheduled rules, HTTP/email/webhook delivery, retries and silences | Planned | Scheduler and delivery fixtures |
| Channel monitor | Scheduled account/model tests and bounded failure actions | Planned | Due-job and state-transition tests |
| Account lifecycle | Token refresh, quota sync, cooldown and reactivation | Planned | Provider adapter and alarm/Queue tests |
| Maintenance jobs | Cursorized cleanup, aggregation, backfill and recovery | Partial | Settlement, subscription-state and payment-fulfillment recovery exist; add due-job/retention suites |
| Prompt audit | Policy events and protected payload storage | Planned | Redaction and retention tests |
| Backup/restore | Export versioned D1 records and R2 manifests; verified restore workflow | Planned | Round-trip restore test |

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
   provider configuration, signed webhook ingestion, R2 evidence, idempotent subscription
   fulfilment, refund state recovery, subscription-entitlement clawback/rollback, and matching
   user/admin screens. Remaining work is receipts, reconciliation views, and the retained
   non-Stripe providers. The order state machine and webhook verification are production
   implementations, not stubs.
2. **Gateway fidelity**: normalized OpenAI, Anthropic, Gemini, and Codex provider adapters;
   request/error/stream conversion fixtures; failover, cooldown, API-key 5h/1d/7d spend windows,
   request-size policy, and accounting reconciliation. User concurrency plus user/group RPM
   admission is already Worker-native and atomically enforced before billing and Pool leases.
3. **Identity completion**: email verification, password reset, and versioned notification-email
   preferences are implemented in the Worker; production still needs a verified Email Service
   sender and deployed delivery E2E. Next are OAuth linking, TOTP step-up/recovery codes, passkeys,
   and linked identities.
4. **Media and realtime**: image/audio/video task APIs backed by Queue and R2, task polling and
   cancellation, followed by WebSocket realtime relay. Legacy provider-specific variants may be
   collapsed into one capability-based task contract.
5. **Operations and governance**: granular admin RBAC and a bounded immutable audit reader exist;
   remaining work is broader audit sources, dashboard facts, request/error explorer, alerts and
   silences, channel health jobs, reconciliation/corrections, DLQ replay, retention, and verified
   D1/R2 export-and-restore.
6. **Secondary product features**: invitations, promotions, affiliate attribution/payouts,
   announcements, model plaza, platform quotas, search extensions, and prompt audit. These follow
   the core gateway and commercial path unless a production dependency promotes them earlier.
