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
| Commercial integrity | Auth, subscription, redemption, order, webhook, refund, and affiliate tests pass | Planned |
| Operations integrity | RBAC, audit, monitoring, alert, retention, recovery, and backup tests pass | Planned |
| Storage correctness | D1 migrations plus Durable Object, Queue, KV, and R2 integration tests pass | Partial |
| Frontend compatibility | User and admin UI smoke/E2E suites pass against the Worker | Planned |
| Deployment | Remote migrations, Worker deploy, production smoke, and rollback notes are verified | Partial |

## 1. Gateway and protocol plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| OpenAI model list | D1-backed group/model catalog at `/v1/models` and `/models` | Partial | Worker handler tests; add root-alias contract |
| Chat Completions | `/v1/chat/completions` and `/chat/completions`, streaming and non-streaming | Partial | Existing gateway tests; add alias, SSE termination, disconnect tests |
| Responses | `/v1/responses`, `/responses`, compact and input-token subroutes | Partial | Existing core tests; add subroute fixtures |
| Embeddings | OpenAI-compatible request/response and token billing | Planned | Port original embedding handler/service fixtures |
| Anthropic Messages | `/v1/messages`, token counting, Anthropic SSE/errors | Planned | Port `apicompat` and Anthropic gateway suites |
| Gemini generateContent | `/v1beta/models/*`, streaming and Gemini error translation | Planned | Port Gemini multiplatform suites |
| Codex backend API | `/backend-api/codex/*`, manifest, Responses transport | Planned | Contract fixtures and authenticated E2E |
| Protocol conversion | Chat, Responses, Anthropic, and Gemini normalized through an internal request model | Planned | Round-trip fixtures from `backend/internal/pkg/apicompat` |
| Model aliases/capabilities | Group-visible names, upstream override, endpoint and account capabilities | Partial | Repository selection and model visibility tests |
| Multi-provider accounts | OpenAI-compatible, Anthropic, Gemini and Codex credential/config adapters | Planned | Per-provider request, auth, timeout, and error fixtures |
| Account scheduling | Weighted priority, concurrency leases, cooldown, sticky affinity, failover | Partial | Durable Object state-machine plus integration tests |
| API-key limits | Enabled/expiry, group, model allowlist, RPM and concurrency | Partial | Auth repository tests; add rate/concurrency integration |
| User/platform quota | Balance reservation/settlement, subscription and platform windows | Partial | Existing ledger tests; add quota-window and race tests |
| Usage and billing API | `/v1/usage` and `/v1/sub2api/billing` with immutable price version | Planned | Port billing and subscription billing suites |
| Media generation | Images, async/batch images, video, voice/live and task polling | Planned | Provider fixtures, R2 artifacts, Queue workflow tests |
| Search extensions | Web/X search and provider-specific alpha routes | Planned | Explicit compatibility fixtures |
| Request policy | Body/multipart limits, prompt policy, sensitive-data redaction | Planned | Boundary and adversarial tests |
| Realtime/WebSocket | Responses realtime session relay with Workers WebSocket pairs | Planned | Upgrade, relay, accounting, timeout and close-code tests |

## 2. Identity, user, and commercial plane

| Capability | Worker design | Status | Acceptance evidence |
| --- | --- | --- | --- |
| Public settings | KV cache backed by versioned D1 settings | Partial | Default/cache/invalidation tests |
| Password registration/login | D1 identity, Web Crypto hashes, Turnstile and Durable Object rate limits | Planned | Port auth registration and login integration tests |
| Sessions | Hashed refresh tokens, rotation, logout/revoke, device/session list | Planned | Session replay/revocation tests |
| Email challenges | Queue-delivered verification/reset/login challenges with expiry and attempt limits | Planned | Challenge state and email delivery tests |
| OAuth identities | Provider adapters and safe identity linking | Planned | Callback/link-conflict tests |
| TOTP and step-up | Encrypted TOTP secret, recovery codes and privileged-action challenge | Planned | TOTP and recovery-code tests |
| Passkeys | WebAuthn challenge state and credential lifecycle | Planned | Port passkey handler tests |
| User profile | Profile, linked identities, notification email preferences | Planned | Route and authorization tests |
| User API keys | Create/list/update/revoke; raw token returned once | Planned | Hashing, redaction, expiry, revocation and access tests |
| Usage/dashboard | User usage pages, aggregates, model plaza and quota windows | Planned | Projection and API contract tests |
| Subscription plans | Plans, user subscriptions, renewals and usage windows | Planned | Port subscription service suites |
| Redemption/invitations | Atomic redeem, invitation rewards, exhaustion and expiry | Planned | Port redeem/invitation race tests |
| Promotions | Promo validation, applicability and one-time consumption | Planned | Promo boundary and idempotency tests |
| Payments | Orders, provider config, signed webhooks, idempotent fulfillment and refunds | Planned | Port webhook, fulfillment and refund suites |
| Affiliate | Referral attribution, commission ledger and payout views | Planned | Port affiliate service suites |
| Announcements | Published audience-aware announcements and acknowledgement | Planned | Visibility and acknowledgement tests |

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
| Groups/models/prices | CRUD, validation, catalog visibility, immutable active prices | Planned | Control-plane and gateway propagation tests |
| Accounts/channels | Credential encryption, group/model links, health, quota and manual probes | Partial | Bootstrap exists; add full CRUD and provider probes |
| Usage/finance | Request ledger, aggregates, reconciliation and corrective workflows | Partial | Projection exists; add query/reconciliation tests |
| Settings | Typed versioned settings, audit and KV invalidation | Planned | Schema and cache-consistency tests |
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

## Delivery order

1. Control-plane users, API keys, groups, models, prices, accounts, and encrypted credentials.
2. Gateway aliases, Anthropic, Gemini, embeddings, protocol normalization, limits, and quotas.
3. User identity/security, subscriptions, redemptions, payment, refunds, and affiliate flows.
4. Admin RBAC, observability, reconciliation, monitoring, alerts, retention, and backup.
5. Frontend API adaptation, removal of host-only controls, full local regression, and deploy rehearsal.
