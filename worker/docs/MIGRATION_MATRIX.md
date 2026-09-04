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
| Operations integrity | RBAC, audit, monitoring, alert, retention, recovery, and backup tests pass | Planned |
| Storage correctness | D1 migrations plus Durable Object, Queue, KV, and R2 integration tests pass | Partial |
| Frontend compatibility | User and admin UI smoke/E2E suites pass against the Worker | Partial |
| Deployment | Remote migrations, Worker deploy, production smoke, and rollback notes are verified | Partial |

## 1. Gateway and protocol plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| OpenAI model list | D1-backed group/model catalog at `/v1/models` and `/models` | Partial | Worker handler tests and root alias; add deployed-binding contract |
| Chat Completions | `/v1/chat/completions` and `/chat/completions`, streaming and non-streaming | Partial | Existing gateway tests and alias; add SSE termination and disconnect tests |
| Responses | `/v1/responses`, `/responses`, compact and input-token subroutes | Partial | Existing core tests; add subroute fixtures |
| Embeddings | OpenAI-compatible request/response and token billing | Partial | Worker protocol/handler fixtures pass; port the remaining original embedding handler/service fixtures |
| Anthropic Messages | `/v1/messages`, token counting, Anthropic SSE/errors | Partial | Worker protocol/handler fixtures pass; port the remaining `apicompat` and Anthropic gateway suites |
| Gemini generateContent | `/v1beta/models/*`, streaming and Gemini error translation | Partial | Worker protocol/handler fixtures pass; port the remaining Gemini multiplatform suites |
| Codex backend API | `/backend-api/codex/*`, manifest, Responses transport | Partial | Worker routes and contract fixtures pass; add authenticated deployed E2E |
| Protocol conversion | Chat, Responses, Anthropic, and Gemini normalized through an internal request model | Planned | Round-trip fixtures from `backend/internal/pkg/apicompat` |
| Model aliases/capabilities | Group-visible names, upstream override, endpoint and account capabilities | Partial | Repository selection and model visibility tests |
| Multi-provider accounts | OpenAI-compatible, Anthropic, Gemini and Codex credential/config adapters | Planned | Per-provider request, auth, timeout, and error fixtures |
| Account scheduling | Weighted priority, concurrency leases, cooldown, sticky affinity, failover | Partial | Durable Object state-machine plus integration tests |
| API-key limits | Enabled/expiry, group, model allowlist, RPM and concurrency | Partial | Auth repository tests; add rate/concurrency integration |
| User/platform quota | Balance reservation/settlement, subscription and platform windows | Partial | Per-subscription SQLite Durable Object prevents quota oversell and projects settlements idempotently; platform-level quota APIs remain |
| Usage and billing API | `/v1/usage` and `/v1/sub2api/billing` with immutable price version | Partial | Routes and balance/subscription billing attribution exist; complete legacy aggregate/filter coverage |
| Media generation | Images, async/batch images, video, voice/live and task polling | Planned | Provider fixtures, R2 artifacts, Queue workflow tests |
| Search extensions | Web/X search and provider-specific alpha routes | Planned | Explicit compatibility fixtures |
| Request policy | Body/multipart limits, prompt policy, sensitive-data redaction | Planned | Boundary and adversarial tests |
| Realtime/WebSocket | Responses realtime session relay with Workers WebSocket pairs | Planned | Upgrade, relay, accounting, timeout and close-code tests |

## 2. Identity, user, and commercial plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| Public settings | KV cache backed by versioned D1 settings | Partial | Default/cache/invalidation tests |
| Password registration/login | D1 identity, Web Crypto hashes, Turnstile and Durable Object rate limits | Done | Registration/login, Turnstile, fail-closed limiter and enumeration-boundary tests |
| Sessions | Hashed refresh tokens, rotation, logout/revoke, device/session list | Done | Rotation/replay/logout plus current-device list, selective/family, other-device and all-device revocation race tests |
| Email challenges | Queue-delivered verification/reset/login challenges with expiry and attempt limits | Planned | Challenge state and email delivery tests |
| OAuth identities | Provider adapters and safe identity linking | Planned | Callback/link-conflict tests |
| TOTP and step-up | Encrypted TOTP secret, recovery codes and privileged-action challenge | Planned | TOTP and recovery-code tests |
| Passkeys | WebAuthn challenge state and credential lifecycle | Planned | Port passkey handler tests |
| User profile | Profile, password security, R2 avatar, linked identities and notification preferences | Partial | Profile/update/password/avatar routes have owner, immutable asset and session-revocation tests; linked identities and notification preferences remain |
| User API keys | Create/list/update/revoke; raw token returned once | Done | Hashing, redaction, expiry, revocation, owner isolation and private/subscription-group access tests |
| Usage/dashboard | User usage pages, aggregates, model plaza and quota windows | Partial | Owner-scoped list/detail/stats/trend/model/snapshot/API-key daily usage routes and frontend contracts pass; model plaza and platform-quota views remain |
| Subscription plans | Plans, user subscriptions, renewals and usage windows | Partial | Public/admin plan CRUD, user list/progress, redeem assignment/extension and gateway quota enforcement pass; payment renewal remains |
| Redemption/invitations | Atomic redeem, administrative lifecycle, invitation rewards, exhaustion and expiry | Partial | Balance/subscription redemption plus hashed one-time admin generation, CAS batch lifecycle, idempotency, expiry and race tests pass; invitation rewards remain |
| Promotions | Promo validation, applicability and one-time consumption | Planned | Promo boundary and idempotency tests |
| Payments | Orders, provider config, signed webhooks, idempotent fulfillment and refunds | Planned | Port webhook, fulfillment and refund suites |
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
- A per-order Durable Object serializes webhook and refund state transitions.
- KV contains disposable public/config caches only; it is never financial truth.
- Queue consumers deliver email and project fulfillment/refund/affiliate events idempotently.
- R2 stores exports, receipts, avatars, and long-lived audit artifacts where appropriate.

## 3. Administration and operations plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| Break-glass admin auth | Constant-time Bearer secret for bootstrap and recovery only | Done | `test/control/admin-auth.test.ts` |
| Admin sessions/RBAC | Bootstrap/recovery-issued D1 sessions exist with last-admin protection; normal login, granular roles, step-up, CSRF/origin checks and rate limits remain | Partial | Session boundary/recovery tests; add login, revocation and authorization matrix |
| User management | List/create/detail/update/disable, persistent idempotency, metadata CAS and DO-versioned balance mutation | Partial | Route/state/concurrency tests and real local D1 migration; add deployed-binding E2E |
| API-key management | User key create/list/update/revoke, persistent idempotency/CAS, HMAC storage and one-time secret display | Partial | Route, hashing, concurrency and invalidation tests; add user self-service and deployed-binding E2E |
| Groups/models/prices | Core group/model CRUD, CAS, catalog visibility, integer multiplier and append-only active prices exist; duplicate, atomic batch sort and advanced pricing remain | Partial | Worker control/gateway unit tests plus manual local migration and trigger checks; add binding E2E |
| Accounts/channels | OpenAI account CRUD, AES-GCM credential rotation, group/model links, revisioned Pool sync and bounded manual health probe exist; channels, quota and provider lifecycle remain | Partial | Account control tests and Pool stale-revision tests; add deployed-binding E2E and provider probes |
| Usage/finance | Request ledger, aggregates, reconciliation and corrective workflows | Partial | Owner-scoped user aggregates and subscription projections exist; admin reconciliation and corrective workflows remain |
| Settings | Typed versioned settings, audit and KV invalidation | Done | Versioned read/write, optimistic concurrency, idempotency, secret redaction and KV invalidation tests |
| Announcements/compliance | Editorial lifecycle, audit views and risk actions | Planned | RBAC and lifecycle tests |
| Admin dashboard | Hourly/daily materialized facts and operational summaries | Planned | Aggregation and timezone tests |
| Request/error explorer | D1 metadata index, R2 payload/archive, redaction and retention | Planned | Search, authorization, redaction and expiry tests |
| Alerts/silences/reports | Scheduled rules, HTTP/email/webhook delivery, retries and silences | Planned | Scheduler and delivery fixtures |
| Channel monitor | Scheduled account/model tests and bounded failure actions | Planned | Due-job and state-transition tests |
| Account lifecycle | Token refresh, quota sync, cooldown and reactivation | Planned | Provider adapter and alarm/Queue tests |
| Maintenance jobs | Cursorized cleanup, aggregation, backfill and recovery | Partial | Recovery exists; add due-job/retention suites |
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
  `gateway_service_subscription_billing_test.go`, and `concurrency_service_test.go`.
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

1. **Payment closure**: orders, payment-provider configuration, signed webhook ingestion,
   idempotent subscription fulfilment, refunds, receipts, and the matching user/admin screens.
   The first slice may support one provider, but its order state machine and webhook verification
   cannot be stubbed.
2. **Gateway fidelity**: normalized OpenAI, Anthropic, Gemini, and Codex provider adapters;
   request/error/stream conversion fixtures; rate and concurrency integration; failover, cooldown,
   request-size policy, and accounting reconciliation.
3. **Identity completion**: email verification and password reset first, then OAuth linking, TOTP
   step-up/recovery codes, passkeys, linked identities, and notification preferences.
4. **Media and realtime**: image/audio/video task APIs backed by Queue and R2, task polling and
   cancellation, followed by WebSocket realtime relay. Legacy provider-specific variants may be
   collapsed into one capability-based task contract.
5. **Operations and governance**: granular admin RBAC, immutable audit trails, dashboard facts,
   request/error explorer, alerts and silences, channel health jobs, reconciliation/corrections,
   DLQ replay, retention, and verified D1/R2 export-and-restore.
6. **Secondary product features**: invitations, promotions, affiliate attribution/payouts,
   announcements, model plaza, platform quotas, search extensions, and prompt audit. These follow
   the core gateway and commercial path unless a production dependency promotes them earlier.
