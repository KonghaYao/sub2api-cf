# Original frontend / Worker core reimplementation

This is an active, incomplete implementation audit, started 2026-09-07.
The user requires **every original frontend capability to remain available**.
Older migration documents treating hidden routes, smaller forms, or removed
payment/providers/host features as completion do not define acceptance anymore.
An explicit unsupported error is useful diagnosis, but it does not complete a feature.

## Business priorities and acceptance

### Verified account-core release stage (2026-09-08)

- This stage restores account management, routing/model policy, proxy inventory,
  OAuth import/refresh, usage projections, diagnostics, scheduled tests and
  exclusive user-group replacement without removing original frontend controls.
- Agent Identity supports key-only import, signed requests, encrypted task
  registration, single invalid-task recovery in gateway/diagnostics, privacy
  initialization skip semantics, and signed model synchronization (21 model tests).
  Model-sync invalid-task recovery and native Agent supplier execution remain
  follow-up work; the entire frontend parity goal is not complete.
- Release validation: Worker typecheck; 235 suites / 2,677 unit/integration tests;
  12 native binding suites / 21 tests; 4 frontend suites / 72 tests; original
  frontend build and the account-core browser scenario (1 passed, 15.6 seconds),
  using local workerd, D1 migrations through 97, Durable Objects and Queue.
- Binding assertions now inspect the logical Chat request pool that includes
  Responses candidates, checking real failure counters, settlement and released
  leases instead of the unused old Responses-only pool address.
- Inventory remains P0 141 calls / 15 unregistered, P1 142 / 69, P2 153 / 101.
  Registration counts do not establish behavioral coverage.
- Production release uses the guarded deploy:production script. Pre-migration
  D1 Time Travel bookmark: `0000002a-00002126-000050e0-666b5dcff41b3c18dd9a651ddbad04eb`.

### Agent privacy initialization skip semantics (2026-09-08)

- Compared Go EnsureOpenAIPrivacy/ForceOpenAIPrivacy and the manual SetPrivacy
  handler: automatic initialization silently skips when access_token is missing;
  manual setting returns “Cannot set privacy: missing access_token”. AgentAssertion
  is not substituted into this token-only settings API.
- Privacy payload decoding now supports genuine Agent credentials. Automatic
  jobs without access_token complete as not_applicable instead of repeatedly
  failing token-shaped vault decoding. No privacy_mode is invented, no supplier
  request is sent and account state remains unchanged. Manual behavior remains 400.
- Added a real SQLite job/manual-route regression for a key-only Agent account.
  Full acceptance still requires active usage/models and native Agent request
  execution, plus the broader outstanding admin/frontend API inventory.
- Agent and existing provider account suites passed 194 tests; Worker
  typecheck passed (`/tmp/sub2api-agent-privacy-initialization.log`).

### Agent diagnostic single task recovery (2026-09-08)

- Text/image and compact diagnostic transports inspect bounded, redacted Agent
  error bodies. A task-invalid 401 triggers one registration/rebuild/retry; a
  second invalid-task response terminates normally as a failed test. Successful
  streams retain the original TestEvent handling. Client cancellation prevents
  a new provider retry after recovery.
- The admin recovery callback reloads account metadata after registration so
  final compact capability/status persistence uses the updated vault generation.
  A repeated 401 records authentication failure without declaring compaction
  unsupported, matching the existing original compact-result semantics.
- Four suites / 71 tests and Worker typecheck passed
  (`/tmp/sub2api-agent-all-diagnostic-recovery-final.log`). Real SQLite admin
  tests cover text and compact recovery, changed assertions, one registration,
  repeated 401, secret redaction and final compact status persistence.
- Native Agent supplier execution/recovery, active usage/model paths and privacy
  initialization are still incomplete. Image-specific Agent recovery output
  remains indirectly covered by the shared transport, not a dedicated image run.

### Admin Agent account diagnostics authentication (2026-09-08)

- Account testing now resolves Agent/task authentication before constructing
  requests; missing model IDs use gpt-5.4 for Agent accounts. Text, image and
  compact Responses request planners receive the explicit AgentAssertion header.
- After task creation, the handler reloads account metadata so diagnostic
  persistence uses the current config/vault generation rather than its pre-task
  snapshot. Token-based account testing keeps the shared ordinary auth path.
- Four diagnostic/task suites passed 66 tests and Worker typecheck passed
  (`/tmp/sub2api-agent-admin-diagnostic.log`), including an admin handler test from
  a key-only vault through signed Codex request to original TestEvent success.
- Agent-specific image/compact output behavior and 401 task recovery in diagnostic
  requests still require verification/integration. Active usage/model/privacy
  paths and native supplier execution remain incomplete.
- Existing provider/task regression passed 188 tests
  (`/tmp/sub2api-agent-diagnostic-provider-regression.log`). Final Agent suite
  passed 11 tests including first-task registration during the admin diagnostic
  (`/tmp/sub2api-agent-diagnostic-first-task.log`).

### Agent Identity admin updates and Codex import (2026-09-08)

- Account credential updates now decode key-only vault payloads, merge omitted
  private keys, validate required Agent fields and Ed25519 replacements, and
  retain account/vault version guards. Ordinary token merges retain API-key checks.
- Enabled Agent Identity entries through Codex import's existing atomic receipts,
  deduplication and update machinery. Import reads generic encrypted payloads;
  newly created/updated Agent accounts do not acquire synthetic OAuth tokens.
- Added frontend agent_private_key response redaction. Original auth mode, task
  metadata and has_agent_private_key status remain available to the UI.
- Import/update suites passed 20 tests, frontend transport passed 48 tests, and
  full Worker suite passed 235 files / 2,668 tests; Worker typecheck passed
  (`/tmp/sub2api-agent-import-update.log`,
  `/tmp/sub2api-agent-frontend-redaction.log`, `/tmp/sub2api-agent-import-full.log`).
- This supersedes earlier explicit Agent import rejection. Remaining functional
  gaps include diagnostics, active usage/model listing, refresh-button semantics,
  privacy initialization and native gateway Agent execution/recovery. Import
  success alone does not establish these workflows or full original parity.
- Native original frontend build and Worker integration passed 1 test in 14.4s
  (`/tmp/sub2api-agent-import-native.log`), now including a real Agent import
  request, native Ed25519 key validation and redacted account retrieval. Native
  supplier execution is still not covered by this import-specific addition.

### Admin Agent Identity account creation (2026-09-08, update/import pending)

- Account creation accepts original OpenAI OAuth auth_mode=agentIdentity without
  api_key/access_token. Required runtime/private-key/workspace/user fields are
  validated, auth mode is canonicalized and Ed25519 PKCS#8 validation occurs
  before transaction writes. Ordinary token account validation is unchanged.
- Public account responses redact agent_private_key; only the vault receives it.
  Task orchestration tests now create genuine Agent accounts through the shared
  account creation function rather than replacing a token account vault manually.
- Eight Agent creation/persistence tests passed
  (`/tmp/sub2api-agent-account-create-final.log`). Existing provider account suite
  passed its 178 tests in `/tmp/sub2api-agent-account-create.log`; that combined
  run initially exposed seven old Agent fixtures missing newly required IDs,
  corrected before the final Agent suite. Worker typecheck passed.
- Update/import, diagnostic and privacy initialization behavior for Agent accounts
  are still incomplete. Successful creation is not full capability acceptance;
  native Agent request validation and remaining admin paths must follow.

### Agent task admin projection consistency (2026-09-08)

- Task registration now updates the public credentials.task_id projection in the
  same guarded transaction as the encrypted vault. Previously the vault changed
  while account responses could retain the old displayed task ID.
- SQL updates only that field on the latest UI JSON, preserving concurrent
  background observations and other account settings; it does not copy private
  keys into public metadata or advance the admin control version.
- Task persistence/lease suites passed 12 tests and Worker typecheck passed
  (`/tmp/sub2api-agent-task-projection.log`), including a newer background
  observation arriving during registration. Admin Agent creation/import and
  native Agent-specific execution remain incomplete.

### Main gateway Agent Identity authentication/recovery (2026-09-08)

- Main text gateway now resolves token/Agent authentication through the shared
  resolver. Codex Responses and the existing Chat-to-Responses path support
  key-only Agent payloads and generate fresh AgentAssertion headers.
- Only one task recovery is allowed per acquireUpstream invocation, including
  pool retry attempts. A task-invalid 401 is consumed/redacted before observations,
  refreshes only the failed task generation, rebuilds the request and retries.
- Unsuccessful Agent response bodies are limited to 64 KiB and 10 seconds, task
  markers are detected before credential/assertion redaction, and transformed
  response length/encoding headers are removed. Successful SSE is not pre-read
  by this error boundary.
- 146 gateway tests and Worker typecheck passed
  (`/tmp/sub2api-agent-gateway-recovery.log`), including a key-only encrypted payload
  returning 401 then success with changed assertions, one settlement and one pool
  lease release. This gateway test mocks task persistence; separate SQLite tests
  cover registration/vault writes. Error-boundary tests independently cover
  redaction, wrong status, body size and stalled reads.
- Remaining: admin create/import/update, diagnostics/quota/model paths, public
  credential projections and native Agent-specific execution. SSE semantic errors
  also require checking against the original Agent redaction/recovery contract.
- Full Worker suite passed 235 files / 2,664 tests
  (`/tmp/sub2api-agent-gateway-full.log`). Original frontend build and local
  Worker integration passed 1 test in 17.2s with migration 97
  (`/tmp/sub2api-agent-gateway-native-regression.log`); that native test covers
  existing core account workflows, not an Agent Identity supplier request.

### Agent request authentication materialization (2026-09-08, main gateway pending)

- Added an account authentication resolver that reads authentic key-only Agent
  Identity payloads, obtains the current persisted task and signs an assertion.
  The provider planner accepts the resolved authorization for Codex Responses
  without adding a Bearer prefix. Its generic auth input is request-local; no
  artificial API-key alias is stored in the credential vault.
- The ordinary token path still validates a nonempty API key. Explicit Agent
  authorization is rejected for unsupported planner operations instead of being
  forwarded with an incorrect authentication scheme.
- Six task/authentication SQLite tests and Worker typecheck passed
  (`/tmp/sub2api-agent-request-auth.log`). Tests prove a real key-only vault record
  produces a Codex request without private key/assertion leakage into its body.
- The main gateway and diagnostics have not yet switched to this resolver. Their
  401 recovery/error redaction, fresh runtime observations and native tests remain.

### Agent key-only vault payloads (2026-09-08, gateway integration pending)

- Split authenticated payload decoding from token-executor validation. The generic
  decoder requires a JSON object and preserves AES-GCM metadata binding; the
  existing decryptCredential entry point still requires a nonempty API key.
- Task orchestration explicitly validates Agent Identity mode/runtime/private-key
  fields after generic decoding. It now persists authentic Agent Identity payloads
  without fabricated api_key/access_token aliases. Transaction fixtures seed such
  payloads directly and verify the aliases remain absent after registration.
- Public account creation/import and gateway executors are not yet enabled for
  these key-only payloads. Admin credential projections and runtime integration
  remain required before acceptance; this supersedes the previous test-alias
  limitation only for the task orchestration/storage path.
- Crypto, task persistence and existing provider account SQLite suites passed
  186 tests; Worker typecheck passed (`/tmp/sub2api-agent-vault-final.log`).

### Agent task registration and vault persistence (2026-09-08, not exposed)

- Added account task orchestration: fresh credential reads, bounded waiting for
  another registration owner, re-read under the lease, selected-proxy registration,
  authenticated task decoding and encrypted vault update in a guarded D1 batch.
- Account control version, credential reference, vault key version and database-time
  lease guard reject stale registration results. Background task updates advance
  config/vault versions while preserving admin control version and scheduling UI
  fields. A newly persisted task satisfies other requests with the same failed-task
  snapshot, avoiding sequential duplicate registrations.
- Five SQLite tests and Worker typecheck passed
  (`/tmp/sub2api-agent-task-persistence.log`): missing task persistence, concurrent
  recovery, administrator edits, key changes and expired leases.
- Integration is still incomplete: the current vault reader requires api_key, so
  these tests seed a test-only compatibility alias. Real key-only Agent Identity
  storage/execution, admin credential projections, gateway recovery calls and native
  runtime verification must be completed before enabling imports. This module is
  not yet called by public routes or gateway requests.

### Original Agent Identity auth-mode correction (2026-09-08)

- Comparing the persistence preconditions with Go uncovered an import contract
  mismatch: the original canonical value is auth_mode=agentIdentity, not
  agent_identity. The parser now recognizes original case-insensitive top-level
  auth_mode/authMode input and writes agentIdentity. The earlier underscore
  spelling remains accepted as an input alias.
- Added top-level camel-case, uppercase and underscore import regressions, and
  corrected the nested-import expectation to the original stored value.
  Normalization/batch suites passed 17 tests and Worker typecheck passed
  (`/tmp/sub2api-agent-auth-mode.log`). Durable task orchestration remains pending.

### Agent registration D1 lease (2026-09-08, orchestration incomplete)

- Migration 97 adds an account-scoped 60-second registration lease. Acquisition
  and transaction guards use database execution time. Releasing a stale owner
  cannot release a newer lease; missing accounts return 404.
- The credential transaction guard rejects expired, replaced and deleted lease
  rows, rolling back prior account writes in the same batch. It intentionally
  uses a failing insert/upsert rather than a zero-row UPDATE on a missing lock.
- Five real SQLite tests and Worker typecheck passed
  (`/tmp/sub2api-agent-task-lock.log`). Native migration 97 has not been exercised
  yet. The lease still needs integration with fresh credential reads, registration,
  encrypted task persistence and bounded concurrent-request waiting.

### Agent task recovery decision rules (2026-09-08, persistence incomplete)

- Ported the original task-registration decision: missing tasks need registration;
  a failed expected task is replaced only if the latest task still equals it.
  A newer task from another request must be reused, including after locking.
- Ported HTTP recovery detection: only 401 responses with the original task-invalid
  markers trigger recovery; generic expired tokens, disabled accounts and other
  status codes do not. Added original credential/assertion body redaction.
- 21 policy tests and Worker typecheck passed
  (`/tmp/sub2api-agent-task-policy.log`). These rules are not yet connected to a
  durable registration lock or gateway retry loop. No claim of completed Agent
  Identity execution or newly successful imports is made.

### Agent encrypted task ID decoding (2026-09-08, gateway integration incomplete)

- Added Ed25519 PKCS#8 seed extraction, SHA-512/clamped Curve25519 derivation,
  BLAKE2b-24 nonce generation and authenticated sealed-box opening. Uses pinned
  tweetnacl 1.0.3 and blakejs 1.2.1 dependencies with the lockfile updated.
- Task registration now has a wrapper that returns a usable task only after plain
  response extraction or successful decryption. Corrupt/invalid ciphertext and
  wrong keys produce sanitized errors; decrypted empty task IDs are rejected.
- A Go nacl/box.SealAnonymous fixture generated with the standard test seed
  validates interoperation, including whitespace trimming. Tests mutate ephemeral
  key, authenticator and ciphertext bytes and exercise encrypted HTTP responses.
  Three suites / 24 tests and Worker typecheck passed
  (`/tmp/sub2api-agent-decryption.log`). Tests run under Node-hosted Web Crypto,
  not native workerd; native runtime verification still remains.
- Durable registration locking, task recovery, encrypted credential persistence
  and gateway/diagnostic/quota integration are still missing. Agent Identity
  imports therefore continue to fail explicitly pending the executable chain.

### Agent task registration transport (2026-09-08, recovery incomplete)

- Added the original signed registration POST, selected account proxy transport,
  30-second hard deadline, 64 KiB response bound and sanitized upstream failures.
  Redirects are not followed. Runtime IDs occupy a single encoded path segment.
- Preserves task_id/taskId and encrypted_task_id/encryptedTaskId precedence and
  rejects invalid typed response fields. Encrypted results remain explicitly tagged;
  they are not treated as usable task IDs or persisted as registration success.
- Tests cover proxy forwarding, request secrecy, response aliases/types, redirects,
  oversize responses and a transport ignoring abort. Encrypted task-ID decoding,
  durable task persistence/recovery and gateway execution remain unimplemented.
  The import endpoint continues to reject Agent Identity accounts until that chain
  works; this transport module alone does not complete the frontend capability.
- Signing and registration suites passed 17 tests; Worker typecheck passed
  (`/tmp/sub2api-agent-registration-final.log`). Tests use mocked suppliers.

### Agent Identity signing protocol (2026-09-08, execution incomplete)

- Added Worker Web Crypto PKCS#8 Ed25519 signing for the original AgentAssertion
  envelope and task-registration payload. Runtime/task identifiers are trimmed,
  timestamps use UTC RFC3339 whole seconds, signatures use standard base64 and
  assertion envelopes use unpadded base64url.
- Tests verify signatures with independently generated public keys, reject task
  tampering and non-Ed25519 private keys, and cover registration without an
  existing task. Three tests and Worker typecheck passed
  (`/tmp/sub2api-agent-signing.log`). A fourth test matches the exact envelope
  and registration signature generated by Go standard-library Ed25519/JSON with
  a deterministic public test seed; all four passed
  (`/tmp/sub2api-agent-signing-go-reference.log`).
- This is a protocol primitive, not completed Agent Identity execution. Task
  registration, encrypted sealed-box task-ID decoding, durable task recovery and
  gateway/diagnostic/quota integration remain. Import still explicitly rejects
  these accounts until the executable chain is implemented.

### Codex import execution-time lease fencing (2026-09-08)

- Lease acquisition, per-entry transaction receipts and final result storage now
  use SQLite execution time. A timestamp bound while preparing the statement
  could otherwise admit a write whose D1 execution was delayed past lease expiry.
- A database-clock regression queues a valid prepared batch, advances beyond the
  five-minute lease, verifies rollback of account/vault/receipt and then resumes
  the same operation successfully. All 10 import HTTP transaction tests and
  Worker typecheck passed (`/tmp/sub2api-codex-import-db-clock.log`).
- Native original frontend build and local Worker account integration passed
  (`/tmp/sub2api-codex-import-db-clock-browser.log`), including the import API
  create/replay/read flow. The simulated delayed transaction itself runs in the
  SQLite regression, not against a deliberately delayed native D1 instance.

### Codex persisted credential deletion parity (2026-09-08)

- Corrected a full-map/patch mismatch in import updates: all credential fields
  removed by the original import merge now become explicit deletion patches.
  In particular, an access-only account without a refresh token must lose a
  stale client_id, as well as the old id_token. Renewable accounts retain their
  refresh_token/client_id pair, matching Go.
- Added a real encrypted-vault regression for both renewable and access-only
  existing accounts. All 9 import HTTP transaction tests and Worker typecheck
  passed (`/tmp/sub2api-codex-import-deletions.log`).
- Codex import DTO group/proxy/account IDs now accept opaque Worker IDs as well
  as original Go numeric IDs; transport continues to pass the selected IDs through.
  Frontend transport suite passed 47 tests and full vue-tsc passed
  (`/tmp/sub2api-codex-import-opaque.log`,
  `/tmp/sub2api-codex-import-opaque-typecheck-final.log`).

### Codex import HTTP persistence (2026-09-08, OAuth path integrated)

- Registered POST /api/v1/admin/accounts/import/codex-session with the original
  sequential batch parser/result contract. OAuth imports use the existing encrypted
  account create/update transactions, optimistic account versions and durable
  initialization jobs. No supplier network request is required during import.
- Migration 96 adds operation hashes, expiring owner leases, cached safe results
  and per-entry receipts committed atomically with account/vault writes. Replays
  preserve original created/updated classification; interrupted updates do not
  rotate vault credentials twice. Failed post-commit reads keep operations
  resumable rather than caching a false item failure. Concurrent/stale owners
  cannot commit account writes or cache results.
- The frontend retains the same request and response shapes, attaches a Worker
  operation key and reuses it after network/HTTP failure; legacy Go requests are
  unchanged. Original active openai-default binding applies only to new accounts
  without explicit groups unless skipped. proxy_id=0 retains original clear semantics.
- Evidence: Worker full suite 228 files / 2,597 tests passed before the final
  default-group addition (`/tmp/sub2api-codex-import-full.log`); final import HTTP
  transaction suite 8 tests passed (`/tmp/sub2api-codex-import-default-group.log`).
  Frontend transport suite 47 tests passed
  (`/tmp/sub2api-codex-import-frontend-final.log`). Native original frontend build
  plus local Worker integration passed 1 test in 14.4s with migration 96
  (`/tmp/sub2api-codex-import-browser.log`), covering direct import API creation,
  replay and account retrieval alongside existing account UI flows. This does not
  claim that the import dialog itself was exercised or that real supplier calls ran.
- Remaining: Agent Identity execution/task recovery is not implemented; these
  items explicitly fail and are not reported as successful imports. Shared account
  validation still imposes Worker concurrency/priority/name limits that differ from
  Go, including concurrency=0. Large-inventory D1/CPU scaling and original import
  dialog interaction still need verification. These are parity gaps, not acceptance.
- Regenerated API inventory: P0 141 calls / 15 unregistered, P1 142/69, P2 153/101.
  Registration counts are only routing coverage, not proof of business correctness.


### Codex batch orchestration (2026-09-08, persistence adapter incomplete)

- Added sequential original batch normalization/expiry/warnings/results flow,
  duplicate marking before writes, update_existing=false creation semantics,
  stored-index refresh after successful writes and partial failure reporting.
- Access-only updates to renewable accounts retain refresh/client credentials
  and do not override the existing account expiry/auto-pause policy. Reindexing
  prevents a later old token from rolling back a newly updated renewable account.
- Credential extras cannot override normalized identities, tokens, expiry or agent
  key/runtime fields; the Worker api_key alias also follows the access token.
  Unexpected persistence failures are reported without raw exception contents.
- Typecheck and five import suites passed
  (`/tmp/sub2api-import-batch-test.log`). Persistence in these batch tests uses a
  controlled adapter, not D1. Durable atomic operation receipts, account write
  integration, endpoint registration and original-frontend import still remain.

### Codex import entry normalization (2026-09-08, endpoint incomplete)

- Added original nested/top-level token aliases, explicit identity precedence,
  ID-token-before-access-token identity hints, workspace/user/organization/plan
  extraction, original names and session metadata. JWT parsing supplies hints,
  not signature verification. Invalid claim types remain unparseable hints.
- JWT access expiry and explicit expires_at preserve the original distinct
  clock-skew boundaries. sessionToken is ignored as a credential, and session
  expires is metadata rather than access-token expiry. Large JSON IDs retain
  exact values through the lossless input parser.
- Agent Identity normalization validates base64 PKCS#8 Ed25519 keys via Web Crypto,
  retains required runtime/workspace/user fields and task/FedRAMP options, uses
  workspace identity, and ignores OAuth expiry. Successful normalization does
  not prove AgentAssertion request execution/task recovery support.
- Typecheck and four import helper suites passed
  (`/tmp/sub2api-import-normalize-test.log`). The API is still unregistered:
  protected credential-extras merge, full batch deduplication, durable idempotent
  writes, provider initialization and native frontend import remain to implement.

### Codex import expiry policy (2026-09-08, endpoint incomplete)

- Added original import timestamp parsing (RFC3339, integer strings, numeric
  seconds/milliseconds and preserved JSON numbers). Invalid calendar dates are
  rejected instead of accepting JavaScript Date rollover. Values outside safe
  Worker date representation are rejected rather than rounded.
- Access-only import requires a known expiry, uses the earlier token/admin date,
  applies the original 120-second boundary and forces auto_pause_on_expired with
  warnings. Renewable OAuth keeps credential expiry independent from optional
  administrator account expiry. Agent Identity bypasses OAuth expiry policy.
- Typecheck and all three import helper suites passed
  (`/tmp/sub2api-import-expiry-test.log`). Entry normalization, full batch import
  persistence and frontend integration are still missing; the endpoint remains
  unregistered and no frontend import success is claimed.

### Codex import input parsing (2026-09-08, endpoint incomplete)

- Implemented original content/contents concatenation, blank-line handling,
  JSON streams, nested-array flattening, mixed JSON/token-line fallback and
  one-based entry indexes. Plain quoted lines remain plain input, matching the
  original looksLikeJSON object/array gate.
- JSON numbers retain their lexical representation in CodexImportNumber, matching
  decoder.UseNumber and avoiding rounded workspace/user identifiers. Future entry
  normalization must unwrap these numeric values explicitly. Decoded objects use
  null prototypes; malformed input errors do not echo submitted tokens.
- Worker-specific nesting bound is 256 levels. This parser is not yet an exposed
  import API: token normalization/expiry policy, deduplication across a whole batch,
  transactional account writes and frontend import regression remain pending.
- Validation: typecheck and both input/identity suites passed
  (`/tmp/sub2api-import-content-test.log`). No browser or full-suite claim is made
  for these currently unconnected import helpers.

### Codex session import identity groundwork (2026-09-08, endpoint incomplete)

- Compared original account_codex_import.go before connecting import writes.
  Added tested helpers for incoming/stored identity keys, agent workspace keys,
  team-member conflict checks, refresh-token/client-ID retention, obsolete ID-token
  removal and incremental index updates that remove old access-token fingerprints.
- Access-token-only inputs match SHA-256 token fingerprints, while stored account
  indexes retain user/workspace keys for later OAuth upgrades. Shared workspaces
  with distinct known user IDs cannot match via account keys. Agent inputs use
  workspace identity rather than shared user/runtime identifiers.
- Worker typecheck and five focused identity/merge tests passed
  (`/tmp/sub2api-codex-import-identity-test.log`). These are preparation for the
  missing import endpoint, not a working frontend import claim. Parsing, expiry
  rules, batch deduplication, persistence/CAS/idempotency, API-key credential mirror,
  agent execution support and native UI integration still need implementation.

### Replace a user's exclusive group (2026-09-08)

- Added POST /admin/users/:id/replace-group following original admin_group.go:
  require a distinct active exclusive standard target group, grant target access,
  migrate the user's non-deleted keys from the old group, then revoke old access.
  A single D1 transaction returns the actual number of migrated keys.
- Preserve paused-key status, quota/usage counters, unrelated groups, group-rate
  overrides and other users. Revoked/deleted keys stay untouched, matching the
  original DeletedAtIsNil filter. All non-deleted keys belonging to the user bump
  auth_version; only migrated keys advance their control version. Gateway auth
  reads D1 per request, so the changed binding is immediately visible.
- The transaction rechecks target eligibility and the user control version; a
  concurrent change or failed key migration rolls back grants/revocations too.
  Original frontend IDs accept Worker opaque strings and retain the same body
  and migrated_keys response. Repeating replacement reports zero remaining keys.
- Validation: Worker typecheck and 222 files / 2,540 tests passed
  (`/tmp/sub2api-group-replacement-full.log`), including ten SQLite migration,
  eligibility, concurrency and rollback scenarios. API inventory now has sixteen
  P0 calls without registration; registrations alone do not prove API completion.
- Final original-frontend browser regression passed (1 test, 14.4 seconds),
  creating exclusive groups, replacing user access and reading the migrated key
  via the user's key list (`/tmp/sub2api-group-replacement-browser-final.log`).
  Test setup uses the existing frontend adapter's Worker group_type payload.
- Added direct gateway authentication assertions before/after replacement using
  the same HMAC-backed key; the new group and auth version are observed on the
  next call. All ten targeted tests passed again
  (`/tmp/sub2api-group-replacement-gateway-final-test.log`).

### Scheduled diagnostic timeout and cycle budget (2026-09-08)

- A timed-out scheduled diagnostic now cancels its SSE consumer as well as the
  upstream abort signal. This finishes hanging reads even when a mock/transport
  ignores abort. Late response completion cannot change the recorded failure or
  recover the account. Cancellation itself is not awaited indefinitely.
- The runner stops admitting plans after 230 seconds, leaving up to seventy
  seconds for the final diagnostics under the original five-minute cycle budget.
  Unstarted plans retain their due timestamp and are available to the next cron.
- Added deterministic stalled-upstream/late-success and twenty-plan slow-provider
  regressions. With one-minute requests and four workers, sixteen plans complete
  in the current cycle and four remain due without abandoned claims.
- Validation: typecheck passed and all 31 scheduled-test tests passed
  (`/tmp/sub2api-scheduled-cycle-final-test.log`). This targeted result does not
  replace the preceding full-suite/browser evidence or claim a new browser run.

### Account scheduled tests (2026-09-08)

- Registered the original five scheduled-test APIs: account plan listing, plan
  create/update/delete and result listing. Migration 0095 persists plans and
  results with account/plan cascade deletion. DTOs preserve original fields and
  numeric plan IDs; frontend account IDs now accept Worker opaque strings.
- Plans use five-field cron parsing with lists, ranges, steps, named months/week
  days, DOM/DOW matching, leap days, TZ=/CRON_TZ= zones and DST gaps/repeated hours.
  Default Worker timezone is UTC. Non-occurring calendar schedules remain stored
  with no next run. The UI's original fields and actions remain available.
- Worker cron executes due plans through the existing real account diagnostic
  handler, selects the original default model when omitted, collects successful
  terminal SSE events, saves text/error/latency/timestamps, and prunes history to
  max_results. Only a completed successful test can trigger auto_recover.
- Per-plan two-minute leases and revision checks prevent duplicate concurrent
  runs, stale writes after edits/deletion and late commits after lease expiry.
  Auto-recovery clears error/cooldown state only for the tested account version;
  administrator enablement/scheduling choices and newer credentials are preserved.
- Worker bounds: twenty due plans per tick, four concurrent diagnostics, seventy
  seconds per execution, one MiB collected SSE, 256 Ki characters persisted text
  and 4 Ki error text. Provider support is inherited from manual diagnostics;
  this does not complete missing provider implementations or claim live-provider
  acceptance. Crash/persistence failures become eligible again after lease expiry.
- Initial regression: typecheck and 221 files / 2,528 tests passed
  (`/tmp/sub2api-scheduled-tests-full.log`). Added 29 cron/CRUD/execution/race tests.
  Inventory now reports P0 17, P1 69, P2 101 unregistered calls; registration counts
  are not semantic completion evidence for the rest of the admin API surface.
- Final targeted cron/plan/execution suite passed all 29 tests after tightening
  timezone-prefix parsing (`/tmp/sub2api-scheduled-tests-final-test.log`). Original
  frontend local workerd browser regression passed (1 test, 14.4 seconds), with
  all 95 migrations and native plan CRUD/results/timezone checks
  (`/tmp/sub2api-scheduled-tests-browser.log`). Browser does not trigger actual
  scheduled provider execution; that path is exercised by SQLite integration.

### Renewal cooldown follows credential generation (2026-09-08)

- Migration 0094 records the credential reference and vault key version associated
  with each refresh attempt. Existing cooldown rows are backfilled from their
  current account credentials rather than discarded on upgrade.
- Scheduled cooldown applies to that credential generation. Replacing expired
  credentials can resume automatic renewal immediately instead of inheriting the
  old token's five-minute rejection cooldown; quota/config-only observations do
  not bypass cooldown. A successful refresh moves the cooldown generation to its
  new vault version atomically with the credential transaction.
- Lock acquisition also checks the expected administrator control version, so a
  stale request cannot claim or install cooldown for credentials replaced between
  its initial account read and lock acquisition. Live leases still serialize all
  generations until released/expired; stale callers receive a version conflict.
- SQLite tests cover replacement during cooldown, config-only observation during
  cooldown, migration of existing failure state, and a stale claim leaving the
  stored attempt untouched. Existing overlap/lease-loss/rollback tests also run.
- Validation: Worker typecheck and full suite passed (220 files / 2,499 tests,
  `/tmp/sub2api-renewal-generation-full.log`). Original frontend local browser
  regression passed (1 test, 14.3 seconds) with all 94 migrations
  (`/tmp/sub2api-renewal-generation-browser.log`). Provider traffic is mocked.

### Scheduled OpenAI and Claude token renewal (2026-09-08)

- Scheduled recovery now renews eligible OpenAI OAuth and Claude OAuth/setup-token
  accounts within the original default thirty-minute expiry window. The existing
  one-minute Worker cron discovers due accounts; each attempted account is held
  for five minutes before the next automatic attempt. Expiry accepts numeric
  seconds, integer strings and ISO timestamps. OpenAI missing-expiry accounts
  with active rate limits are also eligible, matching the original refresher.
- Candidates must be enabled, schedulable, non-unhealthy, non-shadow accounts with
  a refresh-token presence flag. At most twenty are selected per run, oldest
  attempted first, with four concurrent tasks. Future, missing-expiry Claude,
  disabled, unschedulable, missing-token, cooling-down and locked accounts skip.
- Migration 0093 supplies a shared two-minute D1 refresh lease for manual and
  scheduled refresh. Commit checks lease ownership/expiry in the same transaction
  as account/vault/idempotency writes. Another live refresh returns a retryable
  conflict, and lost/expired owners cannot commit or release another owner's lock.
- Scheduled failures retain old credentials and persist only a sanitized error
  code and next-attempt timestamp. Refresh success is not reported as failure
  solely because lease release failed; lease expiry provides recovery.
- This implements default renewal for these providers, not full original service
  parity. Provider QPS controls, configurable policy, same-cycle transient retries,
  provider circuit breaking, unhealthy-account reconciliation and other providers
  remain pending. Automatic refresh still advances control_version like manual
  refresh, so stale administrator forms correctly receive version conflicts.
- Validation: typecheck passed; full suite 220 files / 2,495 tests passed
  (`/tmp/sub2api-auto-renewal-full.log`). After adding explicit lease-expiry error
  mapping/test, the final account suite passed all 175 tests and typecheck passed
  (`/tmp/sub2api-auto-renewal-final-test.log`). Original-frontend local browser
  regression passed (1 test, 14.2 seconds) with all 93 migrations applied
  (`/tmp/sub2api-auto-renewal-browser.log`). Browser verifies manual refresh and
  migrations; automatic eligibility/overlap/lease fencing is tested with SQLite,
  and no live supplier credentials were exercised.

### Claude setup-token refresh parity correction (2026-09-08)

- Account.IsOAuth in original service/account.go explicitly includes setup-token;
  original AccountActionMenu also offers refresh for both token types. Worker now
  accepts Claude setup-token in both single and batch refresh instead of returning
  oauth_refresh_not_supported. No frontend capability was removed or hidden.
- The same SQLite matrix now covers both Claude token types: rotation, omitted
  refresh-token retention, upstream rejection, malformed response, administrator
  edit conflict, proxy failure, partial batch results, both usage observation races,
  and missing refresh-token rejection without upstream calls or account writes.
- Validation: Worker typecheck and full suite passed: 220 files / 2,480 tests
  (`/tmp/sub2api-setup-refresh-full.log`). No new native-browser run this turn.
- Original renewal defaults verified before scheduled integration: a five-minute
  check interval and a thirty-minute refresh window. Claude uses parsed expires_at;
  OpenAI additionally refreshes rate-limited accounts with missing expiry when a
  refresh token exists. Account candidate selection respects schedulability and
  retry cooldown; original refresh uses distributed locking. Worker integration
  must share serialization with manual refresh to avoid duplicate token rotation.

### Supplier percentage validation (2026-09-08)

- Codex quota header parsing now rejects JavaScript-only binary/octal/hex integer
  strings instead of recording them as measured percentages. Finite decimal and
  scientific notation remain accepted, including measured zero. The same parser
  serves manual usage probes and normal successful-response observations.
- Added 14 malformed/valid number scenarios; Worker typecheck and 50 tests across
  usage probe, usage API and normal-traffic observation suites passed
  (`/tmp/sub2api-usage-number-test.log`). This is a targeted regression result,
  not a new full-suite or browser result.

### OAuth refresh and concurrent usage observations (2026-09-08)

- OpenAI and Claude saved-token refresh now reload current account state after
  the upstream request, preserving quota/header observations written during that
  request. The local transaction additionally checks config_version so a later
  observation cannot be overwritten or make the configuration version regress.
- A config-only race retries the local merge/transaction up to three attempts,
  using the already refreshed token. Administrator edits or credential changes
  still conflict; the supplier is never called again by this retry loop.
- Two SQLite regressions inject usage updates during provider refresh and just
  before the first D1 transaction. Both require preserved usage, monotonic
  versions, consistent returned DTO, one token rotation and idempotent replay.
- Validation: Worker typecheck and 220 files / 2,455 tests passed
  (`/tmp/sub2api-refresh-race-full-final.log`). Previous browser result predates
  this concurrency fix; these race paths are verified with real SQLite.

### Claude saved OAuth credential refresh (2026-09-08)

- Single and batch account refresh now accept Claude OAuth accounts, using the
  original `repository/claude_oauth_service.go` JSON token request, fixed Claude
  client ID, axios User-Agent and canonical platform.claude.com token endpoint.
  Claude setup-token accounts with refresh tokens are also eligible: the original
  IsOAuth guard includes both oauth and setup-token. This was corrected after
  inspecting Account.IsOAuth rather than inferring behavior from its name.
- Successful refresh atomically rotates the encrypted vault and API-key mirror,
  preserves existing non-token settings and an omitted refresh token/scope, and
  records expiry seconds as strings like the original admin handler. It keeps
  manual account disablement and uses the existing CAS/idempotency transaction.
  Claude does not invoke OpenAI profile or privacy endpoints.
- Bound proxy failures never fall back to direct fetch. Provider errors and
  malformed responses expose no upstream body or token and leave the vault
  unchanged. Shared transport bounds fetch/body consumption to 20 seconds and
  1 MiB; the original Go transport uses 60 seconds and Chrome impersonation.
  Worker TLS impersonation remains unimplemented. Default scheduled renewal
  was subsequently added; see the scheduled-renewal section above.
- Added seven SQLite scenarios for rotation, omitted token retention, provider
  rejection, invalid expiry, concurrent administrator edits, proxy failure and
  partial batch results; successful operations replay without another refresh.
- Validation: Worker typecheck passed; 220 files / 2,453 tests passed
  (`/tmp/sub2api-claude-refresh-full.log`). Original-frontend local workerd/D1
  browser regression passed (1 test, 14.5 seconds), applying all 92 migrations
  and checking Claude refresh then active/passive usage with the rotated token
  (`/tmp/sub2api-claude-refresh-browser.log`). Providers are local fixtures;
  this is not evidence of live Claude acceptance or full provider parity.

### Normal Codex traffic quota snapshots (2026-09-08)

- Successful OpenAI/Codex token-account responses now persist valid x-codex quota
  headers into the same extra fields read by account usage APIs. API-key accounts,
  failed responses, missing quota headers and credential shadows are excluded.
  Shadow quotas require their separate provider source; this does not implement
  failed-response quota handling or shadow usage.
- Migration 0092 adds an independent normal-header timestamp to the shared usage
  state. D1 enforces the original 30-second snapshot-write interval across Worker
  instances without changing the ten-minute active-probe timestamp or lease.
  Runtime CAS preserves concurrent background metadata, refuses administrator
  edits, leaves control_version unchanged and never consumes response bodies.
- Evidence: typecheck and all 220 files / 2,446 tests passed, including eight new
  sampling eligibility, throttle-boundary and concurrency cases:
  `/tmp/sub2api-codex-traffic-usage.log`. No new live-provider/browser run is claimed.

### Claude normal-request passive usage sampling (2026-09-08)

- Successful Anthropic OAuth/setup-token gateway responses now apply the original
  UpdateSessionWindow and passive header sampling rules. A five-hour status is
  required. Real reset timestamps accept seconds/milliseconds within the original
  five-hours-past/seven-days-future bounds; allowed initial windows without a valid
  timestamp use the original hour-aligned five-hour estimate.
- Window initialization clears prior samples before merging new five-hour,
  seven-day and Fable observations. Status-only responses retain current samples;
  allowed clears an active account rate-limit timestamp. API-key and failed
  responses do not use this successful-token-response path. Body streams remain
  untouched. Separate failed-response quota/overload handling remains outstanding.
- Shared runtime persistence now supports observations that increment routing
  config_version without incrementing administrator control_version. It retains
  metadata from concurrent background updates but refuses stale administrator
  snapshots. Existing cooldown writers keep their previous version behavior.
- Evidence: Worker typecheck and all 219 files / 2,438 tests passed, including nine
  new timestamp, rollover, status-only, response-preservation and CAS scenarios:
  `/tmp/sub2api-passive-sampling-full.log`. No new browser or live-provider run is
  claimed for this change; the previous native creation/usage baseline remains.

### Anthropic active usage and original OAuth creation (2026-09-08)

- Claude OAuth active usage now performs the original GET /api/oauth/usage with
  OAuth authorization, beta header, default Claude Code user-agent and bound proxy.
  Responses are bounded to 1 MiB and 30 seconds. Shared D1 response cache uses the
  original three-minute success/one-minute negative TTLs; concurrent requests join
  the lease holder and cached results recalculate countdowns on each read.
  Credential generation and administrator version invalidate cached observations.
- Active results include five-hour, seven-day, Sonnet and Fable windows and merge
  back into passive sampling fields with account CAS. Missing active Fable data
  retains the previous passive sample. Setup-token active reads remain local,
  since those credentials lack profile scope. Upstream failures are sanitized;
  account edits reject stale writes. Provider fingerprint/TLS customization and
  automatic recoverable-error clearing still need parity work.
- Native verification exposed missing default base_url and rejected Claude token
  types. Creation now accepts original OAuth/setup-token forms and defaults to
  https://api.anthropic.com. The shared account request builder handles those
  types with their actual access_token, removes x-api-key, adds OAuth beta using
  the original default/Haiku/count-token distinctions, and preserves request
  content. Diagnostics retain their token kind instead of forcing API-key mode.
  Missing access_token is rejected rather than using an unrelated legacy key.
  Full Claude Code mimicry/fingerprint transformation, custom-relay semantics and
  advanced token-renewal policy remain separate incomplete areas; this is not a claim
  of complete Anthropic forwarding parity or live-provider acceptance.
- Frontend usage transports accept opaque account IDs and allow 60 seconds for
  single queries / 180 seconds for batches. All 46 account API transport tests
  passed: `/tmp/sub2api-usage-frontend.log`. The two positive creation regressions
  now pass. Original frontend build/typecheck and native core account scenario
  passed (14.4s, 91 local migrations), including Claude OAuth creation with only
  nested access_token and active-to-passive usage synchronization:
  `/tmp/sub2api-claude-token-browser.log`. Seven request-construction tests cover
  both token kinds, diagnostics, beta rules and missing-token rejection; two
  gateway tests exercise encrypted token loading, forwarding and one settlement.
  Final Worker typecheck and all 218 files / 2,429 tests passed:
  `/tmp/sub2api-claude-token-final.log`.
  Upstream responses remain local fixtures, not live-provider verification.

### Account usage APIs (2026-09-08, provider coverage incomplete)

- Registered GET accounts/:id/usage and POST accounts/usage/batch for OpenAI OAuth
  active usage and Anthropic OAuth/setup-token passive usage. Batch deduplicates
  IDs, isolates per-account errors and runs at most six workers. Missing accounts
  return 404 individually; malformed requests return 400. Original admin guards
  apply through the existing app middleware.
- Migration 0090 stores a ten-minute probe-attempt throttle and a bounded lease
  in D1. Force bypasses the attempt TTL but does not start a second probe while
  one is active; such a concurrent read currently returns the stored snapshot.
  Probe failures preserve the previous observation, as in the original OpenAI
  service. Missing windows, active rate limits, force and WSv2-enabled stale
  snapshots trigger the refresh check. Local usage_projection window aggregates
  keep account, standard and user costs separate from supplier quota percentages.
- Evidence: typecheck and 217 files / 2,412 tests passed, including nine new service
  cases for refresh/cache, active lease exclusion, partial batch errors, malformed
  input and passive cost/statistics. `/tmp/sub2api-usage-service-full.log`.
  Native account-browser scenario passed (14.3s, original frontend build/typecheck
  and 90 local migrations), including forced single OAuth usage with 25%/50%
  observed windows and batch partial errors: `/tmp/sub2api-usage-service-browser.log`.
  Upstreams are local protocol fixtures. P0 static registration gaps fall from
  20 to 18, but registered routes do not establish complete provider semantics.

- Implemented the OpenAI OAuth parent-account probe using the original
  codex-auto-review Responses request, saved encrypted credentials/account ID,
  canonical identity headers, bound proxy and a 15-second abort limit. It reads
  only quota headers and closes the response stream immediately. Valid quota
  headers remain usable on non-2xx responses; absent headers never become a
  fabricated zero snapshot. CAS persistence preserves unrelated extra fields,
  health state and admin control_version and rejects concurrent account edits.
  The parser retains raw primary/secondary data and normalizes 5h/7d by window
  duration, including the original unknown-duration ordering and negative-reset
  clamping. Typecheck and 22 probe/projection tests passed:
  `/tmp/sub2api-usage-probe-verified.log`. Tests use local simulated upstreams.
- Verified that the original account list calls both GET accounts/:id/usage and
  POST accounts/usage/batch. Active OpenAI OAuth usage can probe Responses headers;
  Anthropic passive usage only reads saved samples. Batch uses passive for
  Anthropic OAuth/setup-token, limits concurrent work to six and isolates errors.
  These are supplier quota observations, distinct from local billing statistics.
- Added tested window projection helpers matching the original Codex percentage,
  reset timestamp precedence, observation-relative reset and expired-window rules;
  Anthropic passive fractions/status fallback and distinct five-/seven-day expiry
  semantics; local statistics window alignment. Typecheck and nine projection
  tests passed: `/tmp/sub2api-usage-projection.log`.
- Remaining coverage includes Gemini, Antigravity, Grok and credential shadows,
  plus complete account-list verification and normal-traffic passive sampling.
  API-key/provider branches not implemented yet return
  explicit errors. These two APIs are not considered fully reimplemented.

### Mixed Responses/Chat account scheduling and retry (2026-09-08)

- Text gateway requests with protocol conversion enabled now merge native and
  alternate-protocol candidates, deduplicate account IDs and retain each account's
  actual upstream endpoint. Both protocols enter the same pool, ordered by account
  priority, instead of discarding the alternate pool while a native account exists.
  Pool identity follows the public request endpoint and remains stable through
  protocol changes; broader cross-endpoint concurrency sharing remains open.
- Each reserved account gets its own prepared request and response converter.
  HTTP/semantic retries can change protocols without reusing the previous attempt's
  request body or response format. Final credential checks still reject stale
  account-mode selections. Observation records the actual final upstream path.
  Original Responses-only Codex and legacy capability-row conversions are retained.
- SQLite coverage verifies mixed priority ordering for both public endpoints;
  handler coverage verifies Responses failure followed by Chat success for both
  client response formats. A further regression checks invalid tool conversion
  discovered during failover returns 400 and releases the lease/funds reservation.
  This exposed the old unconditional text-attempt retry policy masking local
  parameter errors as 502; invalid_request_error/400 now terminates immediately.
  Worker typecheck and all 214 files / 2,375 tests passed after the correction:
  `/tmp/sub2api-mixed-protocol-validated.log`.
- Follow-up matrix verifies both physical failover directions for both client
  endpoints, each with buffered and streaming responses (8 combinations). It
  asserts public wire format, final output, exactly one monetary settlement and
  both lease releases. All 143 gateway handler tests passed after expanding the
  matrix: `/tmp/sub2api-mixed-stream-handler.log`. Production code is unchanged
  by this verification; the previous full-suite baseline remains 2,375 tests.
- Native original-account browser scenario passed (14.3s, frontend build/typecheck,
  89 local migrations): a new priority-0 Responses account returns 503 before the
  existing Chat account succeeds. The fixture rejects success unless the higher
  priority attempt actually occurred. Log: `/tmp/sub2api-mixed-protocol-browser.log`.
  These are local upstream fixtures, not live-provider verification.

### Account Responses policy now participates in gateway routing (2026-09-08)

- The gateway already contained Responses/Chat request and response converters,
  but original-form account selection ignored openai_responses_mode and the
  automatic openai_responses_supported observation. Only diagnostics used them.
  A shared original-compatible policy now controls both diagnostics and gateway
  candidate filtering, including external channel aliases. Forced modes override
  probe results; absent or incorrectly typed probe flags default to Responses.
- Both public endpoints can select the eligible alternate protocol through the
  existing conversion path. The final credential read repeats the policy check,
  rejecting a stale selection after an account-mode edit. This applies to original
  form API-key accounts; explicit legacy account_models capability rows retain
  their established contract. Embeddings and other providers are unaffected.
- Evidence: Worker typecheck and 214 files / 2,370 tests passed. Four SQLite policy
  scenarios cover both public endpoints and final-read rejection after a mode
  change. The native original-account browser scenario passed, including the
  default Chat-to-Responses request, its usage/quota behavior and error cooldowns,
  followed by an explicit force-Chat edit and Responses-to-Chat request whose
  returned Responses output text is checked. Original frontend build/typecheck
  and 89 local migrations passed. Fixtures now distinguish normal forwarding,
  diagnostics and error cases in both protocols; they are not live-provider proof.
  Logs: `/tmp/sub2api-account-protocol-verified.log` and
  `/tmp/sub2api-account-protocol-browser-final.log`.
- Mixed-protocol selection and failover are connected above. This change does not
  claim complete protocol or frontend parity.

### Single OAuth creation privacy initialization (2026-09-08)

- Matched the original single-create handler's ForceOpenAIPrivacy timing: commit
  the account and vault, execute the privacy request, and return its observed
  privacy_mode in the created account. Existing training_off input is rechecked.
  Provider refusal and transport failure preserve successful account creation
  while reporting training_set_cf_blocked or training_set_failed truthfully.
- Single creation now commits the same durable privacy job as batch creation.
  Synchronous execution shares the job lease with queue consumers; interrupted
  work remains recoverable. Batch execution remains asynchronous. Initial privacy
  observation advances routing config_version without changing the initial admin
  control_version. Manual privacy and background recovery retain their existing
  control-version behavior. The normal creation idempotency snapshot is updated
  with the observed result; replay does not repeat the provider action.
- Worker frontend creation now allows 60 seconds for the bounded initialization
  and preserves its existing idempotency retry key. No original fields or actions
  were removed. Antigravity initialization remains unimplemented.
- Evidence: Worker typecheck and 214 files / 2,366 tests passed, including five
  new single-create success/refusal/transport/interruption/replay scenarios.
  Frontend account API tests passed (45). Original frontend build/typecheck and
  native core account browser scenario passed (14.2s, 89 local migrations), now
  asserting privacy_mode and initial control_version on the original OAuth form's
  creation response. Logs: `/tmp/sub2api-single-privacy-full.log`,
  `/tmp/sub2api-single-privacy-frontend.log`, `/tmp/sub2api-single-privacy-browser.log`.
  Provider traffic is simulated locally; full API parity remains incomplete.

### Single API-key create/edit probe triggers and lease replacement (2026-09-08)

- Single OpenAI API-key creation now commits and dispatches the same durable
  Responses initializer as batch creation. Normal account PUT re-arms its probe
  inside the account update transaction; scheduling-only actions and unrelated
  bulk credential-field operations do not acquire this new side effect.
- Re-arm replaces the old job lease, clears its result and queues current account
  state. Old consumers can neither complete the replacement job nor overwrite
  current account settings: the job lease and account snapshot CAS guard both
  boundaries. Outbox reset failure rolls back the edit, preserving the old job.
- Automatic Responses verdicts advance config_version for routing invalidation
  without advancing control_version, which represents the administrator's edit.
  A background observation therefore does not by itself invalidate a displayed
  If-Match version. Snapshot CAS still protects an edit/probe overlapping in D1.
  Manual mutations and other runtime-state writers retain their existing version
  behavior; this is not a claim that every concurrent UI write issue is closed.
- Replaced the update helper's positional policy booleans with named options,
  preserving reauthorization, bulk-extra merge and batch-field health semantics.
- Native regression exposed a real race: a concurrent automatic probe advanced
  config_version and silently prevented upstream 429/temporary-rule cooldowns
  from being saved. Shared runtime observation persistence now retries once
  against current metadata only when the original administrator control version
  and credential reference still match. It merges only the observed cooldown
  fields, retaining probe results; administrator edits still reject stale writes.
- Evidence: Worker typecheck and all 214 files / 2,361 tests passed. SQLite tests
  cover create, edit, overlapping old/new jobs, atomic rollback on re-arm failure
  and stable admin control versions after successful automatic probes. The old
  in-memory account adapter was updated to model transactional outbox inserts.
  Both temporary and 429 observations are tested across automatic probe writes,
  with separate administrator-race rejection coverage. Original frontend build,
  typecheck and the native core account browser scenario passed (14.0s, 89 local
  migrations): `/tmp/sub2api-observation-verified.log` and
  `/tmp/sub2api-observation-browser.log`. Upstreams are local protocol fixtures;
  this does not claim live-provider or full frontend parity verification.
- Single OAuth privacy, account-controlled protocol conversion and mixed-protocol
  scheduling/failover are connected above. Other providers and remaining API gaps
  are still open. The full frontend/API objective remains active.

### Batch API-key Responses tool-capability initialization (2026-09-08)

- Migration 0089 distinguishes OpenAI privacy and Responses initialization jobs.
  Batch API-key creation now commits a Responses probe job in its account/vault
  transaction. The dispatcher emits a general initialization event and continues
  accepting already queued legacy privacy event envelopes. Job type checks keep
  changed account kinds from executing an inappropriate initializer.
- Probe the original version-aware Responses URL with the lexicographically
  first concrete mapped upstream model, or gpt-5.4. Send the original probe_ping
  function schema, tool_choice=required, max_output_tokens=512 and stream=false.
  Preserve the current saved API key, proxy and permitted header overrides,
  canonical Codex probe headers and per-probe window UUID.
- Mirror original verdicts: 404/405 false; conclusive 2xx requires function_call;
  other non-2xx conservatively true as endpoint evidence. Failed 2xx or incomplete
  max_output_tokens results preserve the prior flag. Network/read failures,
  over-256-KiB responses and rejected redirects are inconclusive. The shared
  bounded transport enforces a 15-second fetch/body deadline. This conservatively
  avoids negative conclusions from truncated large bodies; it does not mimic
  Go's prefix-only verdict on an oversized response.
- CAS merges only extra.openai_responses_supported, preserving other metadata,
  credentials and health. An account changed while probing retries through the
  durable job. Original diagnostic auto mode already consumes this flag.
- Evidence: Worker typecheck and all 214 files / 2,355 tests passed. Tests cover
  original verdict/status cases, deterministic model/URL construction, actual
  payload/headers, proxy routing, inconclusive results, unchanged vault/health,
  oversized responses and CAS refusal against a concurrent edit. Local production
  Workerd/browser journey passed in 14.1 seconds: both initialization job types
  travel through the real local queue, then the original account API reports
  training_off and openai_responses_supported=true. Frontend build/typecheck and
  all 89 local migrations passed. Provider responses are fixtures, not live tests.
- Single-create/update probe triggers are now connected above. Responses-to-Chat
  fallback in the full gateway, Chinese-provider special modes, Grok probes and dynamic Codex identity
  settings remain open. Batch OpenAI privacy and probe jobs do not close the
  full frontend/API reimplementation objective.

### Durable batch OpenAI privacy initialization (2026-09-08)

- Migration 0088 adds account initialization jobs. OpenAI OAuth batch creation
  commits its pending job in the same D1 transaction as the account, vault and
  idempotency result. If the outbox insert fails, no account/vault orphan remains.
  Immediate queue-send failure does not falsely report account creation failure;
  the committed task remains recoverable by Cron.
- A bounded dispatcher leases delivery for up to 20 due tasks per sweep. Queue
  consumers lease execution, retry internal/CAS failures, recover expired leases,
  and acknowledge completed duplicates without another provider request. Account
  deletion cascades the job. Events carry account IDs only, never access tokens.
- Consumer reads the current account and credential, so rotation before delivery
  does not use an obsolete token. Shared manual/background privacy code checks
  account type/shadow status, decrypts with account-bound AAD, honors selected
  proxy, sends the original request with a 15-second bound and CAS-persists only
  the observed account snapshot. Changes during the request retry through the
  durable task instead of overwriting a fresh account.
- Provider refusal/challenge/transport outcomes retain original Force semantics:
  persist training_set_failed/training_set_cf_blocked as completed observations,
  never claim training_off without upstream success. Such results remain manually
  retryable from the original account action rather than retrying indefinitely.
- Evidence: Worker typecheck and all 213 files / 2,328 tests passed. SQLite and
  the production queue consumer tests cover successful/challenged results, failed
  send recovery, stale execution lease, duplicate delivery, rotation, deletion,
  CAS retry with preserved settings and outbox transaction rollback. Local
  production Workerd/browser journey passed in 14.0 seconds with all 88 migrations
  and frontend build/typecheck: batch-create OAuth, consume the actual queue
  event and poll the original account API until privacy_mode=training_off.
  Provider responses are local fixtures, not live OpenAI validation.
- Batch OpenAI Responses initialization is now implemented above. Antigravity
  privacy and Grok capability initialization remain open, as does the original
  single-create synchronous privacy behavior. This
  slice closes durable OpenAI batch privacy delivery only; the full frontend/API
  reimplementation remains active.

### Original batch account creation transaction and replay (2026-09-08)

- Registered POST /admin/accounts/batch. Reuses the single-account creation
  transaction for encrypted credentials, group/model association, provider
  validation and redacted storage. Return original per-row name/id/success/error
  results with success/failed totals. Individual invalid accounts do not roll
  back other successes. Validate all OpenAI long-context billing flags before
  creating any row; apply original base_rpm normalization for batch inputs.
- Reserve a batch idempotency record before row creation. Deterministic per-index
  operation keys reuse successfully committed account transactions after a
  response/finalization failure. Completed batches replay the frozen aggregate;
  changed bodies with the same key conflict before any new account is created.
  Callers without a key remain supported with an internally generated operation.
- Frontend batch types now include the original name/id fields. Worker requests
  retain the same idempotency key after network failure and use a two-minute
  timeout; the pending key clears after a received result. Existing optional
  account DTO adaptation remains compatible and redacts secrets.
- Evidence: Worker typecheck and all 213 files / 2,319 tests passed; frontend
  account transport 45 tests passed. Tests exercise partial failure, encrypted
  vault contents/no orphans, global prevalidation, changed-request rejection,
  completed replay and resume after finalization failure. P0 unregistered
  frontend calls decreased from 21 to 20 of 141. Local production Workerd/browser
  journey passed in 14.2 seconds: mixed valid/invalid batch, aggregate replay,
  reload original account page and observe exactly one successful account row.
  Frontend production build/typecheck and all 87 local migrations passed.
- OpenAI batch privacy now uses the durable initialization pipeline described
  above, including the subsequent OpenAI Responses initializer. Antigravity
  privacy and Grok probes remain missing; storage and these jobs alone do not
  prove full batch-import parity. Unsupported provider
  creation/execution remains open. The full objective is active.

### Original batch credential-field administration (2026-09-08)

- Added POST /admin/accounts/batch-update-credentials for original account_uuid,
  org_uuid and intercept_warmup_requests fields. Validate field/value types and
  every account's existence before any mutation. Apply each field patch in order
  and return original success/failed counts, ID lists and per-account results.
  Duplicate input IDs preserve original repeated-update behavior.
- Each account update atomically rotates encrypted storage and the redacted UI
  projection using current control-version CAS. Partial vault failures leave the
  failed account unchanged while reporting successes accurately. Explicit null
  and empty non-secret assignments are preserved as in the original handler.
  Credential-field updates retain health errors and scheduling/enabled flags;
  they do not invoke the broader normal credential-edit health reset. Shadows
  reject these fields and catalog-write permission is required.
- Evidence: Worker typecheck and all 213 files / 2,313 tests passed; original
  frontend transport suite 44 tests passed. Tests cover existence prevalidation,
  invalid inputs, all three fields, null assignment, duplicate IDs, partial vault
  rollback, retained secrets/settings/health and RBAC. Static P0 unregistered
  calls decreased from 22 to 21 of 141. Local production Workerd/browser journey
  passed in 14.0 seconds, including two-account batch org_uuid update, reread of
  both original DTOs and successful actual gateway forwarding afterward.
  Frontend build/typecheck and all 87 local migrations passed. The browser uses
  local upstream fixtures and does not prove live-provider UUID behavior.
- This completes the storage/API contract for these fields, not unsupported
  Claude OAuth execution, UUID injection or warmup interception semantics.
  Remaining provider and frontend features stay within the active objective.

### Default 429 mutation honors original account error-policy gates (2026-09-08)

- Fixed a downstream policy bypass: the temporary-rule evaluator skipped custom
  error-code policy, but generic OpenAI 429 persistence still wrote an account
  cooldown for excluded statuses and pool-mode accounts. The shared persistence
  boundary now applies original ShouldHandleErrorCode and pool-mode precedence.
- API-key custom-code lists containing numeric entries filter the default state
  mutation; empty/effectively empty lists handle all statuses, matching Go's
  numeric-entry parsing. A matching custom list overrides pool mode. Without a
  custom override, API-key/Bedrock pool mode skips default account mutation.
  OAuth/setup-token accounts ignore these API-key switches. Saved fields and
  control versions remain unchanged when a status is excluded.
- Explicit pool-mode temporary rules still run before this default gate and
  can save a model-scoped cooldown. The default gate does not widen that state
  into a global 429 block. The shared path also covers the normal admin text
  diagnostic persistence callback; compact-specific callbacks remain separate.
- Evidence: Worker typecheck and all 213 files / 2,302 tests passed, including
  default-gate persistence, preserved metadata/control versions, original list
  parsing and explicit-rule precedence. Full custom-status error handling,
  configured same-account pool retries, OAuth 429 retry windows and other
  provider/stream/media policies still need work. The full objective is active.
- Local production Workerd/browser journey passed in 13.9 seconds. The admin API
  configures pool mode, a custom list excluding 429 and a custom list including
  429; actual gateway calls confirm persisted account cooldown only for the
  matching custom list, with recovery between policies. All 87 local migrations
  and frontend build/typecheck passed. An initial attempt encountered a 412
  between GET and PUT; the test now rereads the version and retries the same
  narrow configuration patch up to three times, preserving production CAS.
  These upstream responses are local fixtures, not live-provider verification.

### OpenAI error-rule producers and model-specific scheduling (2026-09-08)

- Shared text acquisition now evaluates saved OpenAI/Codex temporary error
  rules against bounded copies of real non-2xx upstream responses. It preserves
  the original response, case-insensitive keyword matching, valid rule ordering,
  numeric/string duration parsing and original reason fields. Explicit API-key
  custom-code policy bypasses these rules; pool-mode 401 and ordinary 529 keep
  their separate precedence. This is not completion of all custom-code policies.
- Persist known-model non-401 failures under the final mapped model in
  extra.model_rate_limits. Unknown-model and first rule-matched 401 failures use
  account-wide temporary state; repeated 401 history escalates health to an
  authentication error. CAS compares the selected credential/config/control/UI
  snapshot; stale observations cannot overwrite refreshed credentials/settings.
  A matching rule still requests failover if persistence loses a concurrent race.
- Rule-matched 429 does not additionally write the generic account-wide cooldown.
  Matching otherwise non-retryable statuses can fail over through the existing
  model/endpoint-isolated pool. Ordinary and alias candidates, final credential
  reads and initial async Gemini selection now honor mapped model cooldowns.
  Forced admin diagnostics remain available to test a blocked model.
- Model scope parsing honors exact RFC3339 timestamps and expiry, OpenAI native
  image families and Anthropic Fable family keys. Other models remain eligible.
  Discovery SQL and request-body image-tool intent, Antigravity model resolution,
  provider-specific hard quota precedence, image/diagnostic error producers,
  timeouts and semantic streamed errors still need separate parity work.
- Evidence: Worker typecheck and all 212 then-existing files / 2,289 tests
  passed, plus a new scope test file with 4 passing tests. SQLite exercises real
  persistence, mapped final-read exclusion, regular/alias candidate refusal,
  expiry, 401 escalation, disabled/unmatched/custom/pool policies and CAS races.
  Local production Workerd/browser journey passed in 13.5 seconds: save rules
  through the admin API, receive a real fixture upstream 400, inspect the stored
  mapped-model reason, observe the next gateway request return 503, recover via
  admin API and observe 200. Frontend build/typecheck and 87 migrations passed.
  The first browser attempt timed out on an existing menu click before the new
  scenario; waiting for the diagnostic dialog to close and scrolling the row
  before opening the menu stabilized the repeated journey. Upstream fixtures
  are local protocol evidence, not live-provider verification.
  The full frontend/API audit remains active; route-registration totals alone
  do not establish correctness of these policies.

### Temporary account scheduling state and recovery (2026-09-08)

- Added original GET/DELETE /admin/accounts/:id/temp-unschedulable. GET reports
  active account-wide state, typed reason fields or a legacy plain-text reason,
  expiry and the original inactive response. The original modal already calls
  recover-state to recover; its GET no longer encounters a missing route.
- DELETE clears temporary until/reason and extra.model_rate_limits, following
  ClearTempUnschedulable. Preserve independent rate-limit/overload blocks,
  health, enabled/schedulable flags, quota counters, credentials and other
  extras. CAS rejects stale writes and recovery_revision invalidates stale pool
  failure state. Catalog-read/write permissions distinguish the two operations.
- General recover-state now also removes overload, temporary status, model rate
  limits and Antigravity quota scopes, matching the original broader recovery.
  status=temp_unschedulable no longer returns unsupported. Active-account lists
  exclude temporary and overload blocks. Original root fields remain visible in
  the account projection; transport signatures accept opaque account IDs.
- Database-time temporary/overload eligibility is checked at ordinary and alias
  selection, final credential reads, discovery, model plaza, capacity/lifecycle
  calculations and initial async Gemini account selection. Already-assigned
  async result retrieval is unaffected. Expired blocks recover naturally.
- Evidence: Worker typecheck and 212 files / 2,279 tests passed; frontend account
  transport 44 tests passed. Local production Workerd/browser journey passed in
  13.3 seconds with actual GET, DELETE and filtered-list calls, all 87 migrations
  and frontend build/typecheck. SQLite covers active/expired/missing/legacy
  reasons, scoped versus general clearing, preserved vault/settings and actual
  route/final-read refusal. The browser slice exercises inactive-state APIs;
  it does not claim an active temporary-state modal or live provider trigger.
- P0 unregistered frontend calls decreased to 22 of 141. Automatic upstream
  error-rule triggers, model-scoped eligibility and special provider retry /
  timeout policies remain open. Persisted account-state handling is not proof
  that those producers are implemented. The full objective remains active.

### Original manual OpenAI privacy repair (2026-09-08)

- Implemented POST /admin/accounts/:id/set-privacy using the original OAuth
  account action and shared OpenAI privacy transport. PATCH the original
  training_allowed=false settings URL with the saved access token and bound
  proxy, a 15-second manual deadline, bounded response and no redirects.
- Persist training_off only for an upstream 2xx response. Cloudflare challenge
  responses become training_set_cf_blocked; rejection, transport failure and
  timeout become training_set_failed. Return the original account DTO so the
  existing page chooses its success/error message from the actual privacy mode.
  The frontend transport now adapts Worker fields and preserves opaque IDs.
- CAS compares credential reference, config/control versions and the original
  UI JSON. Concurrent account edits return 412 instead of overwriting fresh
  settings. Preserve vault contents, health, enabled/scheduling state, quotas
  and unrelated extra fields. API keys, setup tokens and shadow accounts are
  rejected before any upstream request. Catalog-write RBAC applies.
- Evidence: Worker typecheck and all 212 files / 2,268 tests passed; frontend
  account transport 43 tests passed. Local production Workerd/browser journey
  passed in 13.8 seconds, including the original Set Privacy menu after token
  refresh, stored training_off and redacted response. Frontend production
  build/typecheck and 87 local migrations passed. SQLite tests exercise refused,
  blocked, transport-error, proxy and concurrent-edit outcomes; the browser
  upstream is a protocol fixture, not live OpenAI validation.
- P0 frontend calls without route registration: 24 of 141 (previously 25).
  Antigravity privacy and other unsupported providers remain incomplete; this
  does not close the full frontend/API audit.

### Group OAuth-only association and privacy dispatch policy (2026-09-08)

- Original group settings have distinct semantics: require_oauth_only constrains
  account association; require_privacy_set is evaluated when selecting an
  account. Do not reinterpret the first flag as retroactive deletion or a new
  scheduling rule for existing associations.
- Migration 0087 enforces OAuth-only groups on new/changed account-group links
  inside D1 transactions, including account creation, edits and bulk writers.
  API-key failures return a typed error and roll back account/vault/link changes.
  Existing associations and priority-only updates are not retroactively removed.
  OAuth accounts can still associate. Both group flags now require booleans on
  create/update instead of silently accepting arbitrary JSON values.
- Ordinary and external-alias gateway candidate queries and the final credential
  read now apply the OpenAI group privacy gate. Only exact training_off qualifies,
  following Account.IsPrivacySet. Missing/failed/whitespace-suffixed values do
  not qualify. Other currently supported platforms have no original privacy
  gate. Synchronous images share the guarded final credential boundary.
- Follow the current OpenAI scheduler's group-scoped behavior: a privacy
  rejection does not mutate shared account health. Disabling the group's flag
  restores eligibility immediately, including callers with a previously selected
  candidate. Catalog/capacity display semantics were not redefined in this slice.
- Evidence: Worker typecheck and all 212 files / 2,260 tests passed, covering
  create/edit transaction rollback, OAuth association, normal and alias routing,
  final reads, exact privacy values and unaffected Gemini dispatch. Local
  Workerd/browser account journey passed in 13.3 seconds: save the group privacy
  flag, observe actual gateway 503, clear it and observe 200 on the same account.
  Frontend production build/typecheck and all 87 local migrations passed. The
  flag was changed through the production admin API; this slice does not claim
  a newly tested group-edit modal journey or live-provider validation.
- Provider-specific privacy actions, other unsupported account executors and
  remaining group policy fields still need work; the overall audit is active.

### Saved OpenAI account refresh uses canonical OAuth transport (2026-09-08)

- Single and batch saved-account refresh now share token transport and profile
  enrichment with the original interactive OpenAI flow. Removed the stale
  `codex_cli_rs/0.82.0` identity and the unbounded response.json path. Preserve
  existing saved-refresh error codes while using bounded bodies, deadlines,
  manual redirects and proxy transport from the shared implementation.
- Go BuildAccountCredentials replaces metadata actually returned by a new
  token; the old Worker only filled blank fields. Returned email, account/user/
  organization IDs, plan and subscription expiry now replace stale values;
  omitted settings and refresh tokens remain. The executor credential slot is
  rotated with access_token and legacy SSO/password/cookie residue is removed.
- Best-effort account/subscription lookup and privacy checks use the new token
  and selected proxy. The stored privacy mode follows original Ensure semantics:
  retain an already resolved mode and retry absent/failed modes. Empty tokens,
  oversized responses and shadows cannot rotate the vault. CAS races and vault
  write failures roll back the complete local mutation; replay does not repeat
  token rotation or profile requests.
- Worker single refresh timeout is 60 seconds in the original frontend adapter;
  batches allow 180 seconds for five waves of five accounts plus metadata work.
  The original UI, selected IDs, version checks and idempotent retry are retained.
- Evidence: final Worker typecheck and all 212 files / 2,256 tests passed;
  frontend account transport has 42 passing tests. Existing direct/proxy/replay
  tests now verify new metadata replaces nonempty old metadata, the privacy and
  subscription calls use the fresh token, and old refresh tokens survive when
  no replacement is returned.
- Local Workerd/browser journey passed in 12.9 seconds, including the original
  saved-account Refresh Token menu, replacement of the existing email/plan in
  the returned account and a subsequent successful diagnostic whose upstream
  fixture requires the rotated token. Frontend production build/typecheck and
  all 86 local migrations passed. This is local fixture evidence, not live
  provider or production validation.
- Remaining differences include personal-access-token refresh modes, the
  original privacy fallback after failed token refresh, and specialized provider
  executors. This does not claim all account refresh modes are complete.

### Original OpenAI authorization and token-only creation (2026-09-08)

- Implemented `/admin/openai/generate-auth-url`, `/exchange-code`, and
  `/refresh-token` against the local original Go service, OAuth constants and
  repository request contracts. Authorization uses the original Codex client,
  scopes, default callback, random hex state/verifier/session IDs and S256 PKCE.
- Migration 0086 stores owner-bound, 30-minute authorization sessions in D1;
  verifier data uses the credential AES-GCM envelope with a separate AAD
  namespace, and state is stored as a hash. Exchanges validate owner/state/expiry
  before upstream calls, claim a bounded lease to prevent parallel exchanges,
  delete successful sessions, and release rejected attempts for retry.
- Token exchange/refresh use fixed upstream endpoints, original canonical auth
  identity without an inference-only version header, form bodies, manual
  redirects, bounded response bytes and a deadline covering fetch and body reads.
  Selected proxy IDs survive frontend transport and apply to token, profile and
  privacy requests. Missing/inactive/expired proxies fail closed.
- Token DTOs use original Unix-second expiry fields. Best-effort ID-token
  metadata honors the original two-minute expiry tolerance and UTF-8 decoding.
  Account-check selection ignores deactivated/expired workspaces; canonical
  personal plans are preserved and personal subscription expiry is fetched when
  workspace metadata would otherwise be mixed with them. Privacy PATCH returns
  the original success/failure/Cloudflare-blocked modes, never invented success.
  Claims are display/routing metadata, not Worker authentication authority.
- OAuth routes require catalog-write permission, do not capture authorization
  codes/RT aliases in request-audit bodies, and return no-store responses.
  Interactive token requests have a 60-second frontend timeout; Worker token
  transport is bounded at 20 seconds and best-effort profile requests at 5 seconds
  each. Saved-account refresh was subsequently consolidated with this canonical
  transport/profile implementation, as recorded in the section above.
- Fixed original OAuth creation: the form submits credentials.access_token and
  omits api_key/base_url. Worker now derives its encrypted executor credential
  and provider default URL for supported OAuth executors, while stripping OAuth
  password/SSO/cookie residue. Original form fields and controls remain intact.
- Evidence: 66 focused OAuth/RBAC/audit/transport tests passed; final Worker
  typecheck and all 212 files / 2,250 tests passed. Frontend transport: 42 tests.
  Production frontend build/typecheck and all 86 local migrations passed in the
  Workerd/browser runner. The original account journey passed in 13.6 seconds:
  generate URL → paste callback URL → exchange → save → connect with new token,
  followed by RT → original create form → persisted OAuth row with opaque group.
  The first browser run exposed an outdated fixture model expectation after Go's
  reauthorization metadata replacement; the fixture now checks the actual
  original default model rather than altering the UI to preserve stale mapping.
- This is local protocol evidence, not live OpenAI login or production proof.
  TLS impersonation and dynamic Codex identity overrides, specialized OAuth
  providers/import modes, and the rest of the admin API gaps remain outstanding.

### Persist reauthorized OAuth credentials (2026-09-08)

- Added original `POST /admin/accounts/:id/apply-oauth-credentials`, used by
  `ReAuthAccountModal`. It accepts only type/credentials/extra, requires an
  existing OAuth/setup-token account, rejects shadow credential writes, and
  validates the original OpenAI long-context billing boolean before mutation.
- Extra is merged into current settings. Reauthorization follows original
  sensitive-credential preservation: omitted tokens survive, incoming metadata
  replaces previous metadata, and password/SSO/cookie residue is stripped from
  both legacy and incoming data. Worker mirrors a newly submitted access token
  into its executor credential slot. Returned account data remains redacted.
- Account configuration, encrypted vault rotation, health recovery and pool
  recovery revision are committed in one D1 transaction with version guards.
  Failed vault writes roll everything back; concurrent edits return 412 without
  overwriting newer settings. Existing disabled/schedulable settings are retained.
  Optional If-Match is supported without requiring headers absent from Go's UI.
- Original frontend transport now accepts opaque IDs and adapts the saved account;
  fallback account type uses credential_kind instead of misclassifying OAuth as
  API key when the compatibility type field is absent.
- Evidence: frontend transport 41 tests passed; Worker typecheck and all 210
  files / 2,220 tests passed, including rotation, metadata/settings preservation,
  malformed input, non-OAuth rejection, RBAC, stale edits and transaction rollback.
- Local Workerd/browser account journey passed (11.4s), including a production
  reauthorization save request followed by an actual gateway Responses request
  whose outbound fixture requires the newly saved token. Frontend production
  build/typecheck and all 85 local migrations passed in that runner. This uses
  a protocol-checking local upstream, not a live OpenAI authorization flow.
- This section covers the persistence step for existing supported Worker account
  executors. The later OpenAI authorization section above records URL/code/RT
  implementation and original modal evidence; other provider executors and
  specialized import modes remain outstanding.

### Group capacity: empty active groups (2026-09-08)

- Original `GroupCapacityService.GetAllGroupCapacity` initializes a result for
  every active group. Worker previously discovered groups only through eligible
  accounts and existing pool registrations, omitting new empty groups and groups
  whose accounts were all blocked. The same D1 batch now reads active group IDs
  and returns zero concurrency capacity for these groups.
- Original `ListSchedulableCapacityByGroupIDs` excludes inactive, paused,
  expired and rate-limited accounts but does not subtract monetary quota
  exhaustion. Preserve that distinction from the actual dispatch quota guard.
- SQLite regressions cover empty/fully blocked groups, disabled group omission,
  expiry opt-out, elapsed/current cooldown, and exhausted monetary quota.
  Typecheck and all 210 Worker test files / 2,210 tests passed. This slice did
  not run a browser or live-provider check. Global cross-group concurrency,
  provider temporary blocking and session/RPM parity still need implementation
  or further audit; this is not completion of the capacity subsystem.

### Original account test modal: OpenAI text protocols

- The actual administrator modal sends `model_id` and consumes SSE TestEvents.
  The previous Worker handler ignored that body and returned health JSON, so a
  successful health check did not complete the selected-model test in the UI.
- Default text tests for OpenAI API key accounts now execute a real streaming
  Responses or Chat Completions request with account model mapping, credential header overrides,
  and the bound proxy. They emit original `test_start`, `content`, and
  `test_complete` events. A failed proxy never falls back to a direct request.
- Protocol selection matches original `openai_compat/upstream_capability.go`:
  `extra.openai_responses_mode` overrides the boolean
  `extra.openai_responses_supported`; missing or invalid support flags keep
  Responses. It does not retry arbitrary errors through another protocol.
  Chat Completions sends the trimmed prompt (default `hi`) and accepts `[DONE]`
  or a finish reason followed by EOF, matching the original parser.
- Responses success requires `response.completed` with completed status; truncated streams,
  `[DONE]` alone, and upstream failure events report failure. Fragmented CRLF,
  bounded response size, cancellation, and sanitized failures are covered.
- Evidence: Worker typecheck, 62 focused tests, and full suite passed
  (200 files, 1,996 tests). The original account browser journey passed in 4.6s,
  including opening the unmodified test modal, displaying generated content,
  returning to the retry state, then saving the Chat Completions override and
  successfully repeating the test through that endpoint. This
  uses local Workerd and a protocol-checking upstream fixture, not live OpenAI.
- OpenAI OAuth text diagnostics now use the decrypted `access_token`, the
  ChatGPT Codex endpoint, `chatgpt_account_id`, SSE identity headers, original
  structured greeting/instructions, and `store:false`. OAuth ignores API-key
  Chat Completions overrides. Existing Worker Codex accounts retain their
  configured endpoint and account-id projection. Missing OpenAI OAuth tokens
  fail without substituting a legacy API key.
- `scripts/codex-original-contract.mjs` extracts the original alias table,
  compiled identity version/originator and instructions. Shared model
  normalization implements the original spelling/family rules, preserves
  unknown names and normalizes mapped OAuth models before execution.
- OAuth evidence: typecheck and full suite passed (201 files, 2,049 tests),
  followed by 72 passing boundary/model tests. The D1 integration checks actual
  endpoint, access token, account header, identity pairing, normalized model,
  and terminal content. The expanded OAuth browser journey now passes after
  the action-menu correction below, covering both API key protocols and OAuth.
- The browser exposed a table-scroll/menu race: scrolling an offscreen action
  button into view queues a scroll event that can arrive after the click and
  immediately close its menu. AccountsView now closes the menu only when its
  anchor actually moves from the opening position. Long menus also have a
  viewport height limit and allow internal scrolling without dismissing them.
  The test continues to use ordinary clicks; no force-click or arbitrary sleep
  masks the original failure. Frontend typecheck/build passed with the journey.
- `gateway/account-provider-request.ts` now materializes OAuth Responses for
  both diagnostics and forwarding. OpenAI OAuth uses the access token and
  ChatGPT endpoint; existing Codex accounts preserve their configured endpoint.
  Both use original model normalization, structured string input, retained
  explicit/system instructions, compiled client identity, stream:true and
  store:false. API-key provider requests keep their existing protocol.
- OpenAI OAuth Chat Completions requests now pass through the existing
  Chat-to-Responses bridge after selecting the actual account; the returned
  dispatch selects the matching stream/JSON response conversion. Non-streaming
  Responses consumes the authoritative SSE terminal document using existing
  deadline, lease renewal, settlement and cancellation machinery. Its JSON
  preserves output/usage and exposes the public model. Terminal-only Chat
  output is emitted without duplicating previously streamed text.
- Evidence: the isolated Workerd/browser journey passed in 5.2s with a separate
  OAuth group, model price and customer key, all four combinations of Responses
  / Chat Completions and stream / JSON, plus the original diagnostic modal.
  Gateway tests verify access token, upstream account-id, normalized model,
  preserved instructions, one settlement and one lease release. Truncated
  non-streaming Responses returns 502 and settles failed. This remains a local
  upstream fixture, not a live ChatGPT connection.
- Remaining OAuth work includes custom/dynamic client identities, credential shadows, Agent Identity, specialized
  endpoints, and non-OpenAI inbound protocol conversions. These are not proven
  by the four OpenAI-compatible text forwarding cases.

### Account header overrides on text forwarding

- Original `account_header_override.go` limits this feature by account type:
  OpenAI/Anthropic/Kimi/Zhipu/DeepSeek API keys, plus Grok API keys/OAuth.
  OpenAI OAuth is not eligible. Shared `gateway/account-header-overrides.ts`
  now contains the original eligibility and defensive filtering rules.
- Text gateway requests now apply saved eligible overrides after provider auth
  and protocol headers are constructed. The diagnostic uses the same planner;
  its previous unconditional OAuth override application was removed. Model
  synchronization shares the filtering helper, and upstream billing probes
  now also honor provider eligibility.
- Authoritative authentication, framing, proxy and per-request session headers
  cannot be overwritten. Disabled/malformed flags, blank/non-string/invalid
  values and forbidden names are ignored as original runtime filtering requires.
- Evidence: full Worker suite/typecheck passed (202 files, 2,069 tests). The
  original admin browser journey passed in 5.0s with the local upstream requiring
  the header saved through account PUT on both actual text forwarding and the
  Responses/Chat diagnostic requests. OAuth forwarding tests assert ineligible
  saved overrides are absent. Specialized media and legacy health probes still
  need their own header-override parity audit.
- Save-time validation now runs in the shared account credential parser used
  by create/update and the per-account bulk executor. It normalizes names and
  values, preserves named empty templates, removes entirely blank placeholders,
  rejects duplicate case-insensitive names/forbidden fields/invalid values,
  enforces 64 entries and original UTF-8 byte length limits, and validates the
  optional boolean switch. Only submitted fields are validated; legacy malformed
  stored entries remain defensively skipped at runtime. Save and runtime use
  the same entry validator, with rejection vs skipping appropriate to each path.
- Save evidence: full suite passed (202 files, 2,081 tests), followed by 67
  focused tests/typecheck after expanding the create rejection assertion. D1
  tests prove an invalid create leaves no account/secret, an invalid edit leaves
  credential_ref/control_version untouched, and a valid edit returns normalized
  headers while retaining empty template values.
- This slice does not complete other providers, compact/Grok
  modes, or automatic capability discovery and gateway-wide protocol parity. Those still need
  original-service parity and browser action evidence; legacy health JSON is
  not accepted as evidence that these diagnostic modes work.

### OpenAI image account diagnostics (2026-09-08)

- Removed the pre-mapping image exclusion that returned ordinary health JSON
  to the original SSE test modal. Image-family detection now runs after account
  model mapping, matching original `testOpenAIConnection`.
- API-key tests use `/v1/images/generations`, the original default/custom prompt,
  n=1 and response_format=b64_json, including saved eligible header overrides.
  OAuth tests use the original gpt-5.4-mini Responses orchestrator and selected
  image tool model, verbatim-prompt instructions, reasoning/include/tool_choice
  fields, actual access token, ChatGPT account and canonical Codex identity.
- Both paths emit image/revised-prompt TestEvents. OAuth terminal image results
  take precedence over deduplicated output-item fallback results, as in the Go
  collector. Finished image items can succeed without a terminal envelope;
  partial images, empty results and provider errors cannot. API-key URL-only
  responses fail instead of showing a successful test with no preview.
- Shared transport preserves proxy binding/cancellation and bounds responses
  to 16 MiB. Focused tests cover fragmented JSON/SSE, request contracts, image
  completion/failure and mapped encrypted-account HTTP routes. Typecheck and
  full Worker regression passed: 205 files, 2,113 tests.
- Native Workerd/Playwright account journey passed in 7.4 seconds. It opens the
  original test modal for both API-key and OAuth accounts, executes gpt-image-2,
  observes revised prompts, verifies visible PNG previews actually decode
  (naturalWidth=1), and checks Retry is enabled. Mock outbound fixtures reject
  wrong endpoints, tokens, model/tool bodies and missing API-key header
  overrides. This is local integration evidence, not live provider or production
  proof.
- Shadow/AgentIdentity credentials, dynamic/custom OAuth identity, compact and
  other provider modes still require their own implementation and verification.

### Native compact account diagnostic (2026-09-08)

- The original compact selector now executes native remote compaction v2 on
  ordinary `/responses` with a compaction_trigger. It uses ordinary account
  model mapping (never the legacy compact-only mapping), OAuth normalization,
  compiled Codex probe identity, remote_compaction_v2 beta feature, random window
  UUID and a stable per-account SHA-256-derived session/conversation UUID.
  API-key header overrides apply last; proxy binding and cancellation remain.
- Success requires a compaction/compaction_summary output item, accepting the
  original SSE added/done, terminal output and unary JSON forms. A plain 200
  text response cannot establish compact support. Provider bodies and encrypted
  compact blobs are not exposed in modal errors or stored capability errors.
- The probe writes original extra fields checked_at/last_status/last_error and
  supported. Explicit 404/405/501 or compact-unsupported 400/403/422 mark false;
  transport/auth/429/5xx preserve the prior support judgment. Writes preserve
  other extras and increment both account versions; credential/config/control
  and complete UI snapshot CAS prevents a stale probe overwriting later edits.
- Typecheck and full Worker suite passed: 206 files, 2,141 tests. SQLite API
  tests cover mapped requests, capability success/unsupported/transient states,
  unrelated-field preservation and a concurrent account edit.
- Native Workerd/Playwright account journey passed in 8.2 seconds. For both
  API-key and OAuth accounts it selects Compact probe in the unchanged modal,
  verifies completion and enabled Retry, then reloads account data to verify
  persisted supported/status/error fields. Outbound mocks reject incorrect
  tokens, mapped models, beta/session headers and missing API-key overrides.
  This is isolated local integration evidence, not a live-provider/deploy check.
- Compact HTTP 401 now atomically marks the same account snapshot unhealthy,
  records a safe Authentication failed (401) reason, and projects it as the
  original status=error/error_message. Existing gateway credential reads reject
  the account immediately, including a read after earlier route selection.
  SQLite tests prove before/after credential availability, error-list filtering,
  preserved enabled/schedulable/capability flags, and no stale 401 write after a
  concurrent config-version change. Full regression: 206 files, 2,143 tests.
  Native Workerd browser journey passed in 9.5 seconds: API-key/OAuth compact
  401 failures enable Retry, and after reload the original account status error
  tooltip visibly shows the authentication failure. Mock provider details do
  not appear in the modal. This remains local integration evidence.
- This completes neither original 429 cooldown reconciliation
  nor Codex usage-header synchronization, shadow/AgentIdentity recovery,
  fingerprint convergence/custom identity, or all capability-aware scheduling.
  Those side effects still need original-service parity and their own tests.
- Next 429 work must cover persisted rate_limited_at/rate_limit_reset_at,
  administrator filtering (currently explicitly unsupported), runtime selection
  and credential reads, media/plaza/capacity, and reset/recovery behavior.
  Original reset extraction is in `ratelimit_service.go` and Codex header parsing
  in `openai_gateway_usage.go`; do not merely save UI fields without enforcing
  them in scheduling. Header reset takes precedence over recognized error-body
  reset timestamps; an unparseable 429 must not invent an expiry.
- Added `gateway/openai-rate-limit-reset.ts` as the shared reset-time parser,
  following original Normalize/calculateOpenAI429ResetTime and recognized error
  body parsing. It handles inverted/single/missing window metadata, exhausted
  weekly-before-short limits, maximum available fallback, absolute-before-relative
  body resets, OpenCode compound durations and distinct header/body timestamp
  precision. Invalid/unknown bodies and Retry-After alone produce no invented
  reset. Typecheck and 18 focused tests pass.

### Compact 429 persistence, scheduling and clear action (2026-09-08)

- Compact probes now feed the shared reset parser into the snapshot-guarded
  account update. A recognized reset persists original rate_limited_at and
  rate_limit_reset_at and clears a prior authentication error, matching original
  reconciliation. Unknown resets preserve prior runtime state; concurrent edits
  invalidate the write. Provider error bodies are not saved.
- A shared database-time cooldown predicate now guards text discovery/selection,
  final credential reads after cached routes, media selection/exact Gemini reads,
  model plaza, account lifecycle group resolution and capacity queries. Expired
  timestamps cease blocking automatically. Original active/rate_limited filters
  now distinguish currently cooling accounts instead of returning 422.
- Registered POST /admin/accounts/:id/clear-rate-limit under catalog-write RBAC.
  It clears persisted account cooldown using CAS and increments recovery_revision
  to invalidate local pool cooldown state when configurations are registered.
  Existing enabled/schedulable/health fields are preserved by this action.
- Full Worker regression/typecheck passed: 207 files, 2,165 tests. An additional
  repository regression passed with its 36-test file: discovery, route selection
  and cached-route credential reads reject cooldown and recover after expiry.
  SQLite compact HTTP tests cover unknown/racing 429, prior-error recovery,
  filtering, manual clearing and expiry. Native browser journey passed in 10.5s:
  both API-key/OAuth show the original 429 badge, appear in filtered results,
  and lose the badge after the clear endpoint. All provider responses are local
  mocks; no live or deployed behavior is claimed.
- Remaining: synchronize original Codex usage/plan fields;
  implement model-scoped/Antigravity quota and temporary scheduling state and
  their full clear semantics. The new clear action currently covers account-wide
  cooldown and Worker pool recovery, not those unimplemented provider states.

### Ordinary diagnostics and actual gateway 429 (2026-09-08)

- Final account credential reads now include the config/control/UI snapshot.
  Actual OpenAI/Codex text gateway 429 responses are reconciled before existing
  retry/error handling. The selected secret and complete snapshot must still
  match before account cooldown can be persisted. Concurrent edits or manual
  clearing invalidate old responses; failed persistence does not hide the
  provider result. Existing pool failure accounting remains in place.
- Ordinary account diagnostics, including OpenAI image diagnostics, share this
  reconciliation through their response callback. Other provider types do not
  receive OpenAI cooldown semantics. Header resets avoid reading the body;
  fallback cloned error bodies are bounded to 64 KiB and two seconds without
  consuming the original response or awaiting a potentially blocked tee cancel.
- Typecheck/full Worker suite passed: 208 files, 2,174 tests. SQLite tests prove
  actual credential snapshots, header/body priority, state version increments,
  future credential rejection, unknown/oversized errors and concurrent edits.
  Transport tests cover a stalled error stream and header-only fast path; the
  handler test verifies the hook is called on actual upstream 429.
- Native Workerd browser journey passed in 14.3 seconds. A user OAuth gateway
  request receives 429, account GET shows a future persisted reset, the next
  ordinary request is blocked with 503, and clearing via the administrator
  endpoint restores a 200 forward. This is local mock-provider integration,
  not deployment or live upstream evidence.
- Remaining include HTTP-200 in-stream rate-limit signals, media gateway error
  reconciliation, provider-specific scoped limits, Codex usage/plan metadata,
  and the other administrator API/capability gaps already listed above.

### Original single-account recovery actions (2026-09-08)

- Registered POST /admin/accounts/:id/recover-state and /clear-error with the
  original Account response shape under catalog-write RBAC. Recovery clears
  health errors/account cooldown, resets health failures/leases and advances
  health-probe generation, both account versions and pool recovery_revision.
  Snapshot CAS rejects concurrent edits. Credentials, explicit enabled and
  schedulable choices and unrelated UI extras remain intact. Worker credential
  reads use current encrypted DB values, without an OAuth token cache to flush.
- Batch clear-error now also removes persisted account cooldown, retaining its
  existing atomic guards/audit/idempotency and stale-probe invalidation.
- Typecheck/full suite passed: 208 files, 2,176 tests. After the batch adjustment,
  all 14 account-operation tests passed, including cooldown removal, unrelated
  extras, disabled-account preservation and idempotent recovery revision.
  Native Workerd browser journey passed in 10.9 seconds: after an actual mocked
  401, the original Recover State menu action returns 200 and updates the row
  in place, removing the authentication error indicator for API-key and OAuth.
- This recovers the runtime states implemented in Worker. Full original
  model-specific/Antigravity quota and temporary-unschedulable state handling
  remains outstanding, as do those providers' credential-cache/refresh semantics.
  Registration inventory now has 27 unmatched P0 calls; registration alone
  remains insufficient evidence of complete frontend/backend parity.

### Original account quota reset (2026-09-08)

- Registered POST /admin/accounts/:id/reset-quota with the original Account
  response. It atomically resets quota_used/quota_daily_used/quota_weekly_used,
  removes daily/weekly start/reset timestamps and account cooldown, and keeps
  configured limits, reset policy, credentials and unrelated scheduling blockers.
  Parent-linked shadow accounts are rejected. Snapshot CAS and version increments
  prevent stale writes and invalidate scheduler configuration snapshots.
- The account response now exposes configured positive API-key quota limits and
  corresponding counters at top level, enabling the unchanged original Reset
  Quota menu item. Unconfigured quota fields are omitted, matching original DTO
  semantics instead of fabricating a zero quota on every account.
- Typecheck/full Worker suite passed: 208 files, 2,178 tests. SQLite HTTP tests
  cover all three counter resets/window removal, cooldown clearing, preserved
  limits/reset policy/health/manual scheduling and rejection of shadow resets.
- Native Workerd/Playwright account journey passed in 11.3 seconds: configured
  limits make the original Reset Quota menu item available, clicking it returns
  200, and all three counters are zero while the configured total limit remains.
  This verifies local UI/API integration, not automatic provider usage accrual.
- Account quota enforcement/usage accumulation, automatic expired-window rollover
  in the DTO and fixed-reset timezone fields still require original implementation
  parity. This endpoint is not evidence that the full account quota subsystem
  works. Registration inventory has 26 unmatched P0 calls remaining.

### Account quota window projection (2026-09-08)

- Account GET/list now use shared original quota DTO rules: total used remains
  cumulative; daily/weekly used displays zero when its rolling or fixed period
  has expired (including missing/invalid start), without rewriting stored extra.
  Fixed reset mode/hour/day/timezone and saved next-reset timestamps are exposed.
  Invalid configured timezones use UTC for calculation, matching the Go service.
- Fixed dates reproduce Go time.Date's zone-offset resolution and calendar-day
  stepping. Local Go verification confirmed New York/Berlin spring gaps and
  autumn duplicated hours; these four cases are included alongside Shanghai,
  Sunday/Monday weekly resets and boundary-millisecond tests.
- Typecheck/full Worker suite passed: 209 files, 2,192 tests before four extra
  Go-verified DST cases and HTTP projection assertions; all 83 focused tests
  passed afterward. Tests check stored usage
  remains intact while the public field reports an expired period as zero.
- This fixes quota display semantics. Account quota settlement accumulation,
  persisted fixed-window rollover and scheduling enforcement remain unfinished;
  configured account limits must not be assumed effective until those are tested.

### Account quota settlement accrual (2026-09-08)

- Usage queue projection now prepares account quota increments in the same D1
  transaction as usage_projection, inbox receipt and account-stat rollup. Only
  API-key/Bedrock accounts with a positive configured limit accrue. Cost is
  standard_cost_micros times account_rate_multiplier_ppm, rounded in integer
  micro-units; account-statistics pricing overrides and customer charges do not
  determine quota cost.
- Total usage always increments for an eligible account; configured daily/weekly
  dimensions increment or roll over according to the shared original calendar
  rules. Fixed reset timestamps update on rollover. Complete UI/config/control
  CAS uses a schema constraint to abort the transaction on concurrent changes,
  leaving the queue event available for retry. Inbox replay cannot increment twice.
- Manual quota reset now stores an internal cutoff (omitted from Account DTO).
  Delayed settlements at/before that cutoff still project usage history but do
  not re-add pre-reset quota. Events settled after the reset accrue normally.
- Tests prove standard 50µ ×1.25 rounds to 63µ even when account statistics and
  user charge are both 40µ, repeated-message deduplication, a later rollup failure
  rolling back quota/inbox together, reset races, free/unlimited/OAuth exclusion,
  rolling/fixed windows and delayed pre-reset events. Native Workerd browser
  journey passed in 11.3 seconds: after original Reset Quota, a real local gateway
  request and queue delivery make total/daily/weekly counters grow equally.
- Final typecheck and Worker regression passed: 210 files, 2,204 tests, including
  the reset-cutoff change. The browser proof uses isolated mock provider traffic.
- This is asynchronous accumulation, not account quota reservation/enforcement.
  Scheduling must still reject exhausted counters, including final credential
  reads and media paths; queue lag/concurrent in-flight overshoot need explicit
  treatment. Provider-specific notification/scoped-quota behavior remains open.

### Account quota dispatch guard (2026-09-08)

- Added shared original IsQuotaExceeded policy using the same rolling/fixed
  window projection. API-key/Bedrock accounts are exhausted when any live
  configured dimension has used >= limit; OAuth counters do not apply.
- Text route candidate construction (ordinary and fallback paths) now filters
  exhausted accounts. Final credential reads independently recheck quota after
  cached routes, also protecting synchronous image dispatch that shares this
  credential boundary. Exhaustion returns credential_unavailable rather than
  decrypting and forwarding with the exhausted account.
- Typecheck/full Worker regression passed: 210 files, 2,207 tests. After adding
  candidate filtering, the complete 44-test repository file passed again. SQLite
  tests verify each total/daily/weekly boundary, rejection after earlier account
  selection, removal from candidates and recovery after reset/window expiry.
- Remaining: asynchronous Gemini/media candidate paths, catalog/plaza/capacity
  parity, and in-flight/queue-lag overshoot. This is an observed-counter guard,
  not an atomic account quota reservation or proof of hard spend caps.

### Asynchronous Gemini quota selection (2026-09-08)

- New Gemini media generation/provider-job account selection applies the shared
  account quota policy before decrypting a credential. Ordered candidates are
  read in pages of 100 so exhausted first-choice accounts do not hide later
  eligible accounts, including those beyond the first page. Actual credential
  kind controls quota eligibility.
- Exact-account resolution for an already assigned provider job intentionally
  remains available after quota exhaustion; polling/downloading existing work
  must not select another account or lose access to its result.
- Provider tests cover no upstream call when quota is exhausted, preserved
  assigned-job credential access, and selecting an eligible account after 100
  exhausted candidates. Catalog/plaza/capacity filtering and concurrent/queue-lag
  quota overshoot remain outstanding; this is not a hard quota reservation.
- Final typecheck/full Worker regression passed: 210 files, 2,209 tests.

### Midnight user dashboard regression (2026-09-08)

- Running the complete suite after Shanghai midnight exposed a real mismatch:
  the browser supplied a Shanghai calendar date while user usage filters used
  UTC midnight. The administrator dashboard already honored timezone.
- User usage date filters, default periods, today totals, and trend buckets now
  use validated timezone/calendar boundaries; returned date labels preserve
  the requested local day. GET timezone attachment remains in the existing
  frontend API client. No frontend capability was hidden to avoid the failure.
- Browser API-to-Worker integration now fixes the clock at both 00:05 and 23:55
  Shanghai, proving statistics, trend/model aggregates and recent usage contain
  the current event. Full Worker suite and typecheck passed: 201 files, 2,059
  tests, including the OAuth changes above.
- API-key daily history now shares validated timezone/calendar boundaries and
  local date labels with the dashboard. The requested number of days counts
  calendar dates, including DST dates with 23 or 25 hours; ownership checks and
  UTC defaults remain in place. SQLite API tests cover Shanghai midnight and
  both New York DST transitions, include exactly the first/last millisecond of
  the local day, exclude adjacent days, and compare the same events against
  dashboard trend totals. Typecheck and the full Worker suite passed: 204 files,
  2,099 tests. These tests do not establish live provider or production behavior.

### Claude API-key text diagnostics and authentication

- The original administrator test modal now calls Anthropic Messages with its
  selected mapped model and consumes the same TestEvent stream as OpenAI.
  The request follows original `createTestPayload`: cached text greeting and
  Claude Code system prompt, 1,024 max tokens, temperature 1, stream:true,
  beta=true, API-key beta headers and compiled Claude client identity. Each
  request gets a new random device/session metadata value; eligible saved
  header overrides apply after defaults.
- Both x-api-key and the original `extra.anthropic_apikey_auth_scheme` Bearer
  option work. The gateway credential projection now carries this setting to
  the shared request builder, fixing actual forwarding that previously ignored
  it while model sync/diagnostics could use it. Authentication headers remain
  mutually exclusive and cannot be replaced through arbitrary overrides.
- Claude content deltas and message_stop/[DONE] become original modal content
  and completion events. Errors report failure without raw provider details;
  truncated streams do not receive a fabricated successful completion.
- Evidence: original create-form/diagnostic browser journey passed in 5.4s with
  a protocol-checking Anthropic fixture requiring the mapped model and Bearer
  auth. Full Worker suite passed (203 files, 2,089 tests), followed by typecheck
  and diagnostic tests after naming the shared function `accountTextDiagnostic`.
  Tests cover both auth modes, fresh metadata, saved headers, errors/truncation,
  actual gateway native usage settlement and release. Live Anthropic, Claude
  OAuth, Bedrock/Vertex, and other diagnostic modes remain incomplete.

### Gemini API-key text and image diagnostics

- Gemini API-key account tests now use the selected mapped model with
  streamGenerateContent?alt=sse and x-goog-api-key. The shared account diagnostic
  stream handles native and wrapped Gemini candidates, text parts, image
  inlineData and completion markers. Errors/truncation cannot masquerade as
  successful health JSON. The configured proxy remains part of the shared fetch.
- Payloads follow original createGeminiTestPayload. Text uses the greeting and
  system instruction; original Gemini image families use TEXT/IMAGE modalities,
  1:1 aspect ratio, and the supplied/default image prompt. A models/ prefix is
  removed before building the native model-action URL. Image events use the
  existing frontend preview contract; response processing is bounded at 16 MiB.
- Evidence: Worker typecheck and full suite passed (204 files, 2,096 tests),
  including D1 selected-model integration, native/wrapped responses, image
  event ordering, auth/payload shape, upstream errors and truncated streams.
  The original administrator browser journey passed in 6.7s, creating Gemini
  through its AI Studio form, exercising text then image models, and checking
  the preview image actually decodes. This uses a local upstream fixture.
- Gemini OAuth, service-account/Vertex, Antigravity, image-edit inputs beyond
  the original diagnostic contract, and real external-provider validation
  remain outside this passing slice and still require implementation/evidence.

| Priority | Business chain | Required evidence |
| --- | --- | --- |
| P0 | Administrator login, session recovery, RBAC and permissions | Actual browser authentication; unauthorized reads/writes rejected; read operations work for read-only administrators |
| P0 | Provider account creation/editing, credentials, group binding, scheduling, model selection and gateway execution | Original forms and actions; opaque IDs; CAS; complete field semantics; a changed setting demonstrably changes routing |
| P0 | Groups, user access, API keys, channel prices, balances and subscriptions | Create/edit/revoke/assign paths; expiry and quotas; one settlement; no cross-user data leaks; correct costs |
| P1 | Account usage, dashboard, request explorer, operational settings, redemption and payment administration | Real aggregates and filters; original dialogs/actions; no fabricated success or zero statistics |
| P1 | Shared dependencies used by P0 forms (including proxies and provider discovery) | Implement end-to-end behavior; cannot be dismissed as a peripheral page |
| P2 | Monitoring, risk/prompt audit, backups, plugins and remaining platform integrations | Preserve original controls; map original services to Worker execution; test actions after core chain closure |

P2 means later in the work queue, not removed scope. A feature needed by a P0
journey inherits P0 priority even if its standalone page would be P2.

## Reproducible inventory

- `node worker/scripts/admin-api-inventory.mjs` regenerates
  [ADMIN_API_INVENTORY.json](ADMIN_API_INVENTORY.json).
- The initial static scan finds 433 literal/template API-client call sites:
  140 P0, 140 P1, 153 P2. It is a review queue, not a test pass metric.
- 41 P0, 80 P1 and 105 P2 call sites initially have no candidate registration.
  Parameter routes can falsely look like matches, dynamic helper URLs are not
  resolved, and views can fetch directly. Every candidate still needs semantic
  and browser verification. Regeneration updates counts as routes are added.
- [ADMIN_BROWSER_FAILURES.json](ADMIN_BROWSER_FAILURES.json) records the latest
  complete patrol of all 26 original administrator leaf pages. It intentionally
  fails on missing contracts; it never expects hidden pages or redirects to pass.
  Captured page attribution is approximate for requests crossing navigation.

## Implemented in this work (local, not deployed)

### Independent account scheduling (P0)

Original reference: `backend/internal/handler/admin/account_handler.go`,
`SetSchedulable`, and the unchanged `AccountsView` controls.

- Single and bulk scheduling previously either threw in the API adapter or
  changed `accounts.enabled`. Scheduling now has its own validated boolean in
  the existing account configuration, defaulting to true for legacy rows.
- Single changes use the displayed control version; subsequent changes and
  account edits retain the returned version. Bulk changes preserve enabled
  state, health facts, per-target conflict outcomes and idempotent replay.
- Text routing (including composite routes), embeddings, model discovery,
  model plaza, image account selection and group capacity exclude paused accounts.
  Re-enabling scheduling never enables an administratively disabled account.
- Migration `0081_account_schedulable_audit.sql` adds the independent immutable
  audit action without altering historical records. Account templates/styles
  are unchanged.

### Account today-statistics contracts (P1, on the P0 account page)

Original references: `AccountHandler.GetTodayStats/GetBatchTodayStats` and
`AccountUsageService.GetTodayStatsBatch`.

- Added single and batch routes with the original `WindowStats` shape, using
  settled usage facts, independent account/standard/customer cost snapshots,
  server calendar boundaries, empty results and deduplicated opaque IDs.
- Bounded request size and 1000 IDs; one JSON-parameter aggregate avoids D1
  bind limits. Today reads the retained raw projection once, not raw plus rollup.
- Batch POST is explicitly a read query for RBAC/step-up while retaining the
  existing authenticated, trusted-origin boundary. It cannot authorize writes.

### Original model directory and upstream synchronization (P0)

Original references: `AccountHandler.GetAvailableModels/SyncUpstreamModels`,
`backend/internal/service/upstream_models.go`, original provider model constants,
and `account_header_override.go` / `anthropic_apikey_auth.go`.

- Added GET account model directory, POST saved-account model sync, and POST
  create-form sync preview. Static P0 unregistered call candidates fell from
  41 to 38; this does not establish semantic coverage for the remaining calls.
- Default OpenAI/Claude/Gemini catalogs are generated from local Go constants
  with `node worker/scripts/account-model-defaults.mjs`. Mapping/passthrough
  behavior is retained; directory reads do not decrypt or contact providers.
- Sync decrypts stored credentials, uses native provider model endpoints and
  Codex OAuth manifest identity, applies eligible header overrides, and honors
  Claude's configured bearer scheme. It bounds response sizes and timeouts,
  rejects redirects, and never returns upstream response bodies in errors.
- Direct capability metadata is normalized and supplemented from the fixed
  public registry with a six-hour KV cache. Only 404/405 can fall back to concrete
  mapped model IDs; incomplete metadata warns without replacing a good snapshot.
- Complete metadata is atomically stored only if account config and credential
  versions still match. Saving an older open editor preserves this observation.
  Both sync POSTs require catalog and operations permissions.
- Actual browser journey now clicks the original sync button, saves its model
  mapping and group selection, and verifies persisted metadata plus GET directory.
  The outbound provider is a protocol fixture; this is not a live vendor test.
- Remaining: create-form preview is API-tested but not yet browser-tested;
  unsupported provider/credential kinds, custom proxies, and gateway behavior
  for all original account settings remain open work. No UI was reduced.

### Original general bulk edit transport and mutation (P0)

Original reference: `adminServiceImpl.BulkUpdateAccounts` in `admin_account.go`
(especially credential/extra merge semantics), plus `BulkEditAccountModal.vue`.

- The original general bulk dialog previously sent fields to a Worker endpoint
  that accepted only enable/schedule changes. A separate versioned `updates`
  envelope now executes the shared account-update transaction for each target.
- Frontend transport snapshots selected or all filtered targets before writing,
  preserves opaque IDs, and sends one target per invocation to bound D1 usage.
  There is no UI selection cap. Filter changes during updates cannot cause the
  adapter to skip later pages. Removed targets report partial failure.
- Bulk extras merge with existing extras; encrypted credentials use the same
  safe patch path as single edits. Each successful account update commits its
  replay receipt atomically. Ambiguous client retries retain key and versions;
  stale targets fail individually instead of overwriting concurrent edits.
- Priority-only edits now update actual account-group scheduling priorities and
  relation versions, not just the display projection. Relationship validation
  and inserts use JSON parameters; a 100-group edit stays below 50 D1 statements.
- Browser coverage includes original Bulk Edit controls for concurrency and
  priority, result counts, and persisted account/group readback.
- This closes transport and the tested mutations, not every original field's
  runtime behavior. Proxy execution, provider-specific extra normalization,
  quotas/load-factor behavior and unsupported credential kinds still require
  implementation/audit. Batch create and dedicated batch-credential routes
  remain unimplemented; they were not replaced by fabricated success responses.

### Group API-key directory (P0 access administration)

- Added the original group-scoped paginated API-key route and removed its
  frontend Worker rejection. Opaque group IDs pass through unchanged.
- Reuses the existing key projection (no raw token or hash), excludes revoked
  keys, validates group existence and pagination, and scopes count plus rows to
  the same group. Reading requires catalog and user-read permissions.
- Native D1/application tests cover real key creation followed by group isolation,
  revoked-key filtering, pagination, missing groups and authentication; RBAC
  tests reject catalog-only reads. This helper has no current Vue caller, so no
  browser action is claimed for it.
- The original Go group statistics handler is still a mock returning zeros.
  Do not port the mock as completion: real group statistics remain open work.

### Original account creation and mixed-channel check (P0)

- Extended the real browser journey through original OpenAI creation, API-key
  entry, group binding, model preview, post-create sync and visible list result.
  This passed on real Workerd (3.3s for the expanded account journey).
- Added the missing POST `accounts/check-mixed-channel` used before Claude
  creation. It follows `admin_account.go`: compares Anthropic/Antigravity
  platforms, skips the edited account, and returns the first group's warning
  details. It is a read query with catalog-read permission and origin protection.
- D1 tests verify actual group/account detection and exclusions; 50 account and
  security tests passed, followed by 16 RBAC tests including the new read case.
- Creation initially exposed a P0 routing defect: the original form's
  `credentials.model_mapping` did not participate in Worker account selection.
  The tested text path is now repaired as described below; do not extrapolate
  that evidence to every provider/endpoint or older stored accounts.
- Final real browser rerun passed (3.8s), including both OpenAI and Claude
  creation through the original forms and the live mixed-channel check.

### Original account whitelist and text gateway routing (P0)

- Original-form account creation and model-mapping edits now select original
  model routing semantics. Explicit Worker `model_capabilities` updates retain
  their separate restrictive behavior; empty explicit capabilities stay closed.
- Candidate selection and credential loading both apply the account whitelist.
  Empty mappings allow all models within the already-authorized/priced group;
  exact matches precede longest trailing-prefix matches. Targets are literal.
  OpenAI passthrough ignores stale whitelist data. Model discovery also checks
  the same basic whitelist and account scheduling state.
- Text requests send the selected account's mapped model in the upstream body
  and native model URL; downstream processing uses that actual model name to
  restore the client's public name. Catalog IDs and frozen prices remain intact.
- Real browser proof: original form creates an OpenAI API-key account with no
  manual account-model rows; a credential mapping is saved; a real Key is issued;
  `/v1/models` lists the model and `/v1/chat/completions` reaches the fixture with
  a different mapped model. The downstream response retains the public name.
  The full original account journey passed (3.8s).
- Full Worker suite: 188 files / 1869 tests passed. New policy tests cover exact,
  wildcard, literal target, denied model and passthrough behavior; native D1 tests
  cover no-manual-row routing, discovery, credential recheck and explicit closure.
- Remaining P0: migration/compatibility for older stored original-form accounts,
  provider-specific alias/OAuth rules, alternate media/model-plaza paths and
  more streaming/endpoint permutations. These remain scope, not supported claims.

### Provider model-policy boundaries (P0)

- Added original Gemini customtools-alias fallback, whitespace normalization,
  and the conservative OpenAI OAuth foreign-family exclusions (including bare
  k3 IDs and namespaced/case-insensitive model names). Explicit mappings and
  unknown aliases retain the original behavior.
- Fixed passthrough precedence: a boolean `openai_passthrough: false` overrides
  legacy `openai_oauth_passthrough: true`. Directory, scheduler, credential
  check and account model picker now agree; a stale old flag cannot reopen the
  whitelist after the administrator disables passthrough.
- The model-discovery SQL predicate lives alongside the JS policy. A shared
  D1/JS test matrix exercises OAuth, aliases, wildcard semantics, special names
  and explicit overrides. Discovery uses the group's upstream-name override.
  A source-driven test checks every foreign prefix in the original Go file.
- Validation: full Worker suite passed (188 files / 1872 tests), followed by
  the added Go-source comparison in the policy suite. The real original account
  browser journey passed again (3.8s), including creation, key issuance, model
  discovery and mapped text forwarding. Other endpoints and older-account
  migration are still incomplete scope.

### Identifiable older account routing repair (P0)

- Migration 0082 restores original routing for old accounts with an existing
  nonempty string-valued model mapping, no capability rows and no explicit
  routing-mode field. Existing capability restrictions and explicit false
  settings are preserved; empty/absent mappings do not prove original intent.
- The migration preserves credentials, notes, enabled/schedulable state and
  memberships. It advances account config/control versions, letting gateway
  revision triggers refresh cached candidate state and rejecting stale editors.
- Tests apply the real migrations around preexisting fixtures, verify intended
  and excluded cases, gateway revision advancement and one-time execution.
  All migration plus gateway-repository regressions passed: 36 files / 110 tests.
  This migration has not been applied to a production database.
- Older ambiguous empty-mapping accounts still need a deliberate model-policy
  edit or a stronger source of original intent; broad unconditional enablement
  would overwrite administrator capability decisions.

### Model plaza account eligibility (P0 discovery dependency)

- Model plaza now uses the shared account whitelist/provider predicate and
  original-form routing mode instead of requiring manual capability rows.
- Retains the existing public/private group visibility, prices and explicit
  capability restrictions. Paused scheduling and denied mappings hide models;
  group upstream overrides are evaluated without exposing upstream identifiers.
- Native D1/HTTP tests exercise each transition and verify public responses do
  not leak account mapping targets. Combined plaza, repository and policy suites
  passed: 3 files / 47 tests. No frontend capability or template was removed.
- Media execution was reviewed separately in the following slices.

### Synchronous image account model mapping (P0)

- Fixed the synchronous image handler to pass the group-resolved model into
  credential eligibility checks and forward the selected account's mapped name
  for direct, Responses-adapter and streaming dispatch inputs. It resolves the
  name independently per account attempt rather than cascading prior mappings.
- Original reference: `openai_images.go` applies `account.GetMappedModel` before
  forwarding. Native handler test proves no-manual-capability-row execution,
  group override followed by account mapping, whitelist rejection without an
  upstream call, and one successful settlement. All 48 sync-handler tests passed.

### Asynchronous Gemini image account mapping (P0)

- Batch model discovery and Gemini account selection now share the account
  whitelist predicate, use the group-resolved model, allow original-form
  accounts without manual capability rows, and exclude paused accounts.
- Per-item Gemini generation sends the selected account's mapped model.
  Native provider jobs instead persist that model when the task is created;
  queue retries use the persisted value even if account mappings change.
- Migration 0083 adds an immutable provider model snapshot. Older jobs retain
  the task model used by the previous implementation; the migration does not
  reinterpret them using mutable account configuration. Not deployed.
- A queue regression caught and fixed a missing snapshot column in job reads.
  The test now covers saved-model readback, immutable-update rejection, a
  different mapping returned by later account lookup, submission/recovery and
  settlement. A real SQLite/D1 test covers original-form eligibility, group
  overrides, mapping, paused scheduling, explicit capability closure and
  whitelist denial for both discovery and execution.
- Media plus migration suites passed 53 files / 348 tests; the additional
  native account-policy test passed with all 16 handler tests. Typecheck passed.
  Full Worker regression then caught missing migration ledger entries in 0082
  and 0083; both were corrected. Final full suite: 189 files / 1879 tests passed,
  including incremental migration recovery and repeat-run idempotency.
  Vendor network behavior and remaining provider/platform capabilities are
  still outside this local slice's evidence.

### Account expiration affects actual routing (P0)

- Original references: `Account.IsSchedulable` in `account.go` rejects expired
  accounts when auto-pause is enabled; `admin_account.go` defaults auto-pause
  to true and treats nonpositive Unix seconds as clearing expiration.
- Previously these original form fields were stored without execution effects.
  Worker now validates the boolean and integer timestamp, defaults auto-pause
  consistently, and normalizes zero/negative expiration to null.
- Shared database-time expiry checks apply to normal/alias candidate selection,
  final credential reads, model discovery/plaza, Gemini image selection/listing
  and capacity calculations. Account expiry is distinct from OAuth token expiry.
  Final credential checks protect requests holding cached route candidates.
- Native D1 tests cover future and boundary/past expiration, auto-pause opt-out,
  clearing expiry, rejected malformed admin writes, and media eligibility.
  Already-created provider jobs retain their existing reconciliation lifecycle;
  this change does not retroactively cancel accepted tasks.
- Worker full regression passed 189 files / 1881 tests before the additional
  media-expiration assertions; the updated media handlers passed all 16 tests.
  Typecheck passed. The original-account Workerd/browser journey passed (8.3s):
  after a successful mapped call, an admin API expiry edit makes calling return
  503, and clearing expiry restores 200. This proves live execution changes;
  the expiry inputs themselves were exercised through HTTP, not browser clicks.

### Account load factor affects pool scheduling (P0)

- Original references: `Account.EffectiveLoadFactor`, gateway load collection
  and `admin_account.go` create/update/bulk validation. Load factor is a
  scheduling denominator; actual concurrency remains the slot limit.
- Original account writes now validate integer values up to 10000 and normalize
  nonpositive values to null (the original editor sends zero when cleared).
  Candidate projection carries a configured positive factor into the pool sync
  payload and its fingerprint, so edits invalidate the scheduling configuration.
- Pool ranking uses the factor when present and concurrency otherwise. The
  independent concurrency admission check is preserved. SQLite DO initialization
  adds a nullable load-factor column to existing objects; every account load and
  save includes it. Older objects/callers retain concurrency-based behavior.
- State-machine and Workerd binding tests prove the relative-load ordering and
  rejection when both real concurrency limits are full. Native admin/D1 tests
  cover validation, clear semantics and candidate propagation. One old fixture
  incorrectly used decimal 1.25, which original Go integer binding rejects; it
  now uses an integer, with explicit decimal rejection coverage.
- Typecheck, 189 Worker test files / 1882 tests, and the complete 10-file /
  19-test local binding suite passed. No production deployment was performed.
- Follow-up found that partial pool account upserts could clear an omitted
  load factor. They now preserve the existing value, matching priority/weight
  partial-update semantics. Authoritative sync still clears omitted factors.
  The explicit preservation/clear regression and all 20 pool tests passed,
  together with typecheck.

### Original proxy management: inventory and basic mutations (P0 dependency)

- `frontend/src/api/admin/proxies.ts` and original `proxy_handler.go` define
  paginated inventory, active/all with optional account counts, detail, create,
  update/toggle, delete/batch, accounts, connectivity/quality and data transfer.
  Account forms require `/admin/proxies/all`; returning an invented empty list
  would conceal the missing functionality and is not an acceptable completion.
- Original proxy records include HTTP/HTTPS/SOCKS5/SOCKS5H, host/port/auth,
  expiry, fallback mode (none/proxy/direct), backup proxy and warning days.
  Migration 0084 adds durable inventory, encrypted credentials, backup foreign
  keys and account-reference deletion guards. List/detail/create/update/delete
  and associated-account endpoints now use that inventory; active/all supports
  original with_count and paginated inventory supports filter/sort/search.
- Credential fields use AES-GCM with a proxy-specific AAD. Admin projection
  retains original password-edit capability; non-admin routes never return this
  projection. Create idempotency stores only a safe resource receipt, rejecting
  changed request replays and returning the existing resource for retries.
  Update accepts optional If-Match and always uses a read-version CAS internally.
- Original empty identity/auth update semantics and expiry/fallback defaults are
  retained. Account and backup references block deletion, including a database
  trigger guarding the account-reference race. Catalog-read/write RBAC applies.
- Native D1 tests cover actual counts/accounts, encrypted storage, replay,
  malformed inputs, stale updates, backup validation and referenced deletion.
  Full Worker regression: 190 files / 1887 tests passed; typecheck passed.
  Original proxy create/edit browser journey passed, including all 84
  migrations and active-directory readback. Expanded associated-account browser
  journey passed (2.4s): a real account references the proxy, inventory count
  becomes one, and the original account-count button opens the correct list.
- Account-reference triggers also reject new assignments to nonexistent or
  concurrently deleted proxies. Unchanged legacy proxy references are not
  revalidated during unrelated account edits; repairing legacy dangling
  references remains a separate inventory reconciliation concern.
- Transport, connectivity/quality probes and
  import/export remain outstanding. No probe success or fabricated latency is
  returned. Merely accepting `proxy_id` does not enable proxy use.
- Expiration sweep now runs with scheduled recovery. Original
  `ResolveProxyFallbackTarget` rules are preserved: none/unresolved cycles keep
  bindings, direct clears the proxy, expired backup chains are traversed, and
  unexpired inactive backups are accepted just as original Go does. A snapshot
  dependency-version guard rejects concurrent edits; each proxy's status change,
  account rewrites, origin marker and observation invalidation are transactional.
  Account config/control versions advance for routing refresh and stale editors.
  Scans process at most ten expired proxies per invocation, draining on later
  cron ticks. An existing origin marker prevents repeated automatic reassignment.
- Original `POST accounts/:id/revert-proxy-fallback` is now available, restoring
  the saved source and clearing the marker atomically. Missing fallback state
  returns the original ACCOUNT_NOT_IN_FALLBACK contract; a deleted source gives
  a conflict rather than creating a dangling reference. Shadow-account
  propagation remains tied to the still-unimplemented shadow-account feature.
- Native tests prove fallback rules, rollback on injected account-update failure,
  stale snapshot rejection, idempotent scans and manual revert. Full Worker
  before the final revert test passed 191 files / 1892 tests; the updated expiry
  suite passed five tests and typecheck. A real Workerd/D1 binding test also
  passed, proving cross-statement transaction/count behavior and version updates.
  Account list/detail now hydrate embedded proxy display details and the fallback
  origin name from current inventory using indexed references. This fixes the
  original table showing a dash despite a stored proxy binding and keeps rename
  changes visible. Passwords and encrypted auth material are excluded from the
  embedded account projection. Native tests cover list/detail, renamed proxies,
  expiry formatting and secret exclusion. Full Worker: 191 files / 1894 tests
  passed; typecheck passed. Transport and probe actions remain unfinished.
  The extended original proxy/account browser journey passed (2.3s). The first
  display assertion correctly failed because the original proxy column is
  hidden by default; the journey now enables it through More Actions -> Proxy
  and verifies the bound proxy name, preserving original display defaults.
- Original batch-create/delete endpoints are now implemented using the shared
  encrypted creation and reference-protected deletion routines. Creation trims
  string fields, names records `default`, and identifies duplicates by
  host/port/username/password regardless of protocol, as original Go does.
  Per-item creation failures are counted as skipped; duplicate lookup failures
  fail the request. Deletion reports actual deleted IDs and per-target reasons.
- Worker transport shards create inputs into five-record requests and deletion
  into ten-record requests, aggregating all results without reducing original
  UI selection/import limits. The Go transport remains a single request.
  These limits bound D1 work per request; they are not user-facing batch limits.
- Native partial-result/deletion tests and three frontend transport tests pass,
  including opaque ID preservation and unchanged Go behavior. The original
  quick-add and multi-select delete browser journey passed (3.4s): seven input
  proxies span create requests, appear in the original table and are deleted
  through the original confirmation dialog. Full Worker: 190 files / 1888 tests
  passed; typecheck passed, and the browser asset build checked frontend types.
- Original account status filtering was also checked against
  `accountListFilteredQuery`: active/unschedulable filters intentionally do not
  test account expiry. Do not change those filters to match gateway eligibility;
  rate-limit/temporary-pause filters remain unsupported pending real state.

## Confirmed remaining gaps

### Proxy transport implementation in progress

- Consulted Cloudflare's official TCP sockets and node:tls references. The
  web-crawler CLI attempt failed with registry DNS ENOTFOUND; the official
  pages were read with the browser search tool instead:
  https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
  https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/
- Added `gateway/proxy-tunnel.ts`, a stream-based HTTP CONNECT/SOCKS5 handshake
  implementation for an already-connected proxy. It handles fragmented replies,
  proxy-only authentication, complete SOCKS bound-address frames, bounded CONNECT
  headers, safe errors and stream-lock cleanup. No provider credentials are
  supplied to this handshake. Six wire-format/negative tests and typecheck pass.
- The main text gateway now invokes this module through `proxy-fetch.ts` for
  bound accounts; this is not yet evidence of working native proxy forwarding.
  Actual proxy fixture tests are still required. HTTPS proxies
  additionally require TLS to the proxy followed by TLS to the upstream; native
  socket startTls is documented as a one-time upgrade, so nested TLS needs
  explicit runtime verification rather than assuming a second upgrade works.
- Added `gateway/proxy-http.ts` for HTTP/1.1 over an established upstream TLS
  stream. It serializes gateway JSON with exact UTF-8 Content-Length, sends
  upstream authorization only inside that stream, strips proxy credentials,
  and requests identity encoding. Responses handle bounded headers/interim
  responses, fixed lengths, chunk framing/trailers, close-delimited bodies and
  no-body statuses. Gzip/deflate are decoded when returned despite identity.
- Streaming tests prove headers return before delayed SSE data and aborting a
  pending read closes the connection. Malformed/ambiguous framing, truncation,
  cancellation and credential separation are tested. Combined handshake/HTTP
  suite: 13 tests passed; typecheck passed. Nested TLS,
  brotli decoding and real proxy network validation
  remain before the proxy feature can be accepted as operational.
- Added encrypted proxy lookup and native TCP/startTls orchestration, wired into
  the main text request path only. HTTP CONNECT/SOCKS5/SOCKS5H negotiate before
  upstream TLS; HTTPS proxies explicitly fail pending nested-TLS implementation.
  No implicit direct fallback is performed. Account credential projection carries
  the current proxy binding, treating numeric/string zero as no binding.
  Three injected-socket tests cover credential separation, rejected CONNECT,
  and cancellation before asynchronous dial completion. These mocks verify
  orchestration, not real TLS. Full Worker suite: 194 files / 1,910 tests passed;
  typecheck passed. Local Workerd regression: 11 files / 20 tests passed.
  An additional real Worker/D1/DO gateway test passed: the same account first
  succeeds directly, then fails after binding an unsupported HTTPS proxy despite
  a successful direct outbound fixture. This verifies fail-closed route wiring,
  not native proxy network success.
  Credential refresh for providers
  beyond the existing OpenAI OAuth implementation also remains incomplete;
  preserving those original capabilities remains in scope.
- Saved-account model synchronization now honors the account proxy, matching
  original `upstream_models.go` (`upstreamModelsProxyURL` and the transport call).
  Preview without a saved account stays direct, and optional public models.dev
  metadata enrichment remains separate from the authenticated upstream request.
  Proxy failure cannot trigger the 404/405 configured-model fallback and cannot
  persist a successful metadata snapshot. The existing request deadline covers
  proxy negotiation and response reads, mapping deadline cancellation to 504.
  Four tests cover selected transport/auth, failure without direct fallback or
  snapshot writes, and numeric/string zero legacy sentinels. The model suite
  passed 19 tests; typecheck passed. Full Worker regression before the two final
  sentinel cases passed 194 files / 1,912 tests. Extended Workerd gateway test
  passed with the real admin sync route also returning the proxy failure.
- Health lifecycle and synthetic request probes now read the saved proxy binding
  alongside the account and invoke the same proxy transport. This follows the
  original account-test service's use of `account.Proxy.URL()` and avoids marking
  a proxy-bound account healthy merely because direct access succeeds. Existing
  deadlines also classify cancellation from proxy transport as timeout. Missing
  or unsupported proxies produce failed observations without direct fallback.
  Two real SQLite/queue-consumer regression cases prove the resulting unhealthy
  status and failed synthetic history; both probe suites passed 41 tests.
  Typecheck passed; full Worker regression passed 194 files / 1,916 tests, and
  local Workerd binding regression passed 12 files / 21 tests.
  Native TCP/TLS success remains unverified and is still required for acceptance.
- Proxy socket cancellation audit added checks immediately after both socket
  `opened` waits. A connection opening after cancellation can no longer continue
  into proxy authentication or upstream request preparation. Two deferred-open
  regression cases verify no writes and a single close for TCP and upstream TLS
  waits. Typecheck and the combined 18-test proxy suite passed. These remain
  injected-socket tests, not a substitute for native TCP/TLS validation.
- Existing OpenAI OAuth manual and batch account refresh now use the saved proxy
  binding, matching original `OpenAIOAuthService.RefreshTokenWithClientID` routing.
  The URL-encoded refresh form is serialized through the shared transport with
  the existing 20-second deadline. Redirects are manual, and failed HTTP response
  bodies are cancelled to release proxied connections. Proxy transport failures
  retain the existing refresh error envelope and leave vault/config versions
  unchanged. Rotation and idempotent replay are tested through both direct and
  injected proxy transports; an unsupported real proxy configuration is tested
  for no direct fallback and no state mutation. Typecheck and the 34-test account
  suite passed. This does not implement other providers' refresh or prove native
  TCP/TLS success. Full Worker regression passed 194 files / 1,920 tests.
- Synchronous image generation/editing and both direct-images/Responses image
  adapters now select the account proxy for buffered and live output paths.
  Proxy HTTP supports streamed request bodies with chunk framing; Fetch runtime
  serialization supplies multipart boundaries and binary bytes without an extra
  whole-upload buffer. String bodies keep exact UTF-8 Content-Length. Cancelled
  and failed uploads cancel their source reader, and pre-upload socket failures
  cancel unlocked serialized bodies. Tests cover binary byte preservation,
  multipart boundaries, cancellation, and both image adapters failing without
  direct fallback or settlement when a configured proxy is unavailable.
  Typecheck and 65 focused tests passed. These prove serialization and route
  wiring, not actual native TCP/TLS proxy connectivity.
  Full Worker regression passed 194 files / 1,925 tests; local Workerd binding
  regression passed 12 files / 21 tests.
- Existing asynchronous Gemini generation and provider-native batch clients now
  use the saved account proxy. Both initial selection and exact account lookup
  hydrate the proxy ID; each submit, ambiguous-submit lookup, poll and cancel
  phase obtains its account-specific fetcher. Exact lookup uses current proxy
  configuration so admin fallback changes apply to running jobs, while the
  immutable provider model snapshot remains unchanged. Injected custom job
  clients remain explicit test/integration overrides. Tests verify proxy/auth
  selection and error propagation without direct fallback. Typecheck and full
  regression passed 194 files / 1,927 tests. Native network proof, HTTPS nested
  TLS and provider-native file result support remain outstanding. Local Workerd
  regression passed 12 files / 21 tests.

### Upstream billing discovery: account switch foundation

- Original `upstream_billing_probe.go` was inspected for settings, scheduling,
  identity restrictions, proxy routing and rate write-back. This is a separate
  remote Sub2API billing discovery feature, not the generic health probe.
- Added `PUT accounts/:id/upstream-billing-probe` with original boolean request
  and opaque account-ID response. Only supported API-key identities may use it.
  Disabling atomically disables automatic rate synchronization too; re-enabling
  does not re-enable rate sync. Existing snapshots and unrelated extras survive.
  Server-side control-version CAS prevents replacing concurrently edited data.
  Typecheck and 20 focused account-switch/RBAC regression tests passed.
  Full Worker regression passed 195 files / 1,930 tests.
- Settings and periodic execution were subsequently implemented below; manual
  request global coordination and complete browser journeys remain outstanding.
- Added `upstream-billing-contract.ts` from original response validation and
  rate functions. It validates token billing schema, finite nonnegative rates,
  group/user resolution, observed RFC3339 time, peak-window/timezone consistency
  and effective rate arithmetic, returning only allowed fields. Peak calculations
  use the current local minute; automatic write-back uses the resolved base rate
  rounded to four decimals and accepts only `(0,100]`. Single-digit peak hours
  remain valid as in original `parseMinutes`. Typecheck and 25 contract tests passed.
- Added single-account `POST accounts/:id/upstream-billing-probe` and an actual
  observation engine. It decrypts the API key, uses the normalized billing URL,
  preserves safe credential header overrides, forbids redirects, respects the
  account proxy, and bounds reads at 64 KiB with a 10-second request deadline.
  Non-OpenAI official API domains short-circuit to unsupported without sending
  credentials. Successful declarations receive a freshness window; failures keep
  previous data and freshness, while Retry-After and unsupported delay are honored.
  An accepted base rate and snapshot are written atomically only if account config,
  credentials, prior JSON and proxy version still match. Rate changes invalidate
  config/control versions; observation-only writes preserve those versions.
  Typecheck and nine SQLite observation tests passed, covering actual requests,
  response limits, stale edits, proxy changes, rate restrictions and old-data
  retention. Full regression before the final two proxy cases passed 197 files /
  1,962 tests; local Workerd regression passed 12 files / 21 tests. The manual
  route now uses persisted settings as described below. Native proxy connectivity
  and full browser testing of this interface remain unverified.
- Added `POST accounts/upstream-billing-probe/batch`: validate 1–20 inputs before
  work starts, deduplicate opaque IDs, use at most four concurrent observations,
  and return ordered per-account snapshots/errors with sanitized unexpected
  errors. It uses the same observation engine as the manual single-account API.
  The frontend batch call now allows 90 seconds: the global 30-second default
  could expire before five waves of 10-second upstream requests finish.
  Typecheck and 19 focused backend/RBAC tests passed; full Worker regression
  passed 198 files / 1,966 tests. Frontend transport tests verify opaque IDs and
  partial-result preservation. This concurrency bound is per invocation; global
  coordination and the periodic runner still need implementation.
- Added migration 0085 and real settings GET/PUT with original defaults (enabled,
  30 minutes) and a 5–1440 minute interval. Single and batch manual requests read
  the saved interval. Cron invokes a D1-leased periodic scan: at most 20 due,
  opted-in, enabled API-key accounts, four active observations, a two-minute
  ownership token, and token-checked release. Each observation rechecks account
  opt-in and due time. A concurrent scan returns without work; disabled settings
  prevent acquiring a scan lease. Unexpected storage failures are reported after
  active work drains rather than silently discarded.
  Settings and lease/filter tests use real SQLite; typecheck passed. Full Worker
  regression passed 199 files / 1,968 tests and Workerd passed 12 files / 21 tests
  before the final error-reporting refinement, which passed focused settings tests.
  This coordinates periodic scans; simultaneous manual HTTP requests still lack
  the original global four-slot/single-account coalescing mechanism.
- Re-ran all retained administrator pages against the locally migrated Worker.
  No page exceptions or request transport failures were observed. The patrol
  still fails honestly on 12 distinct missing API paths, now recorded in
  `ADMIN_BROWSER_FAILURES.json`: backups (four), email templates, plugins,
  channel monitors, risk control (two), prompt audit (three). Proxy inventory
  and upstream billing settings no longer appear in the failure set. This is
  page-load evidence; it does not prove every interactive action works.
- Account-editor concurrency audit fixed stale `extra` saves replacing newer
  billing observations. Operational model/billing snapshots now come from the
  current row, and absent snapshots cannot be resurrected by an old form.
  Changing upstream URL, effective credential contents, credential kind, proxy
  identity or provider configuration clears the old billing snapshot while
  preserving other extras. The shared single/bulk account update executor applies
  these rules. Typecheck and 67 targeted account/model/probe tests passed,
  including stale saves, cleared snapshots and three identity-change cases.
  Full Worker regression passed 199 files / 1,973 tests.
- Original billing-rate cell accepted only two-digit peak hours despite the Go
  contract accepting `9:00` too. It now accepts one/two-digit hours, with eight
  component tests including peak entry/exit for both spellings. An original
  account-browser journey now clicks the manual billing probe against a local
  authenticated upstream fixture and checks the returned multiplier. Its first
  attempt mistakenly toggled the already-visible column off; the test was fixed
  without changing the original default column visibility.
- The real browser then exposed a D1-specific false conflict: account updates
  trigger a gateway revision update, so D1 `meta.changes` includes more than the
  matched account row. Probe persistence and the probe switch now check
  `UPDATE ... RETURNING id` instead of requiring a total change count of one.
  Twelve focused SQLite tests passed after this fix; native browser revalidation
  covers both enabling the probe and displaying its successful result.
  The extended original account browser journey passed (3.8s), including the
  actual billing-button click, authenticated fixture response and `1.25x` display.
- The follow-up request-path audit found the existing manual account health-test
  endpoint still bypassed proxies even though periodic health/synthetic probes
  were wired. It now uses the account proxy and classifies deadline cancellation
  consistently. Health persistence uses `RETURNING id` for a matched-row result.
  Three cases verify proxy success, fail-closed behavior and rejection of stale
  persistence after a concurrent account edit. Typecheck and 42 account tests
  passed. This fixes the existing health-test path; it does not establish parity
  for every original provider-specific streaming diagnostic mode.
  The older in-memory SQL test double was updated to support health `RETURNING`;
  full Worker regression then passed 199 files / 1,976 tests.

The last full browser patrol found missing requests for (the proxy inventory
entries were subsequently implemented and have focused browser evidence):

- Accounts: upstream-billing-probe settings and proxies/all. Today-stats/batch
  now passes the real account journey and no longer fails in the full patrol.
- Shared/settings: proxies, email templates, backup list, backup schedule,
  S3 configuration and image storage.
- Plugins: plugin list. Proxies: inventory/all and an uncaught page rejection.
- Channel monitoring: monitor list.
- Risk control: configuration and runtime status.
- Prompt audit: configuration, runtime, events.

Opening a page is not enough. The old patrol also used a removed Worker-only
account edit form. The replacement exercises the original scheduling control
and original account/group form. Continue with create, bulk edit, provider
credential lifecycle, model sync/test, group and API-key dialogs. API-level
"unsupported" rejections in these journeys are remaining work.

## Validation evidence

- Pre-change Worker baseline: typecheck and all 1835 tests passed.
- Scheduling: 73 account/control/gateway tests passed; 364 affected media,
  lifecycle, capacity, audit and migration tests passed.
- Frontend: 36 account-adapter tests and 7 original account surface guards passed;
  frontend typecheck passed.
- Today stats: 11 statistics tests passed, including timezone/duplicate/empty
  cases and reading after rollup. Read security: 5 tests passed.
- Full original admin browser patrol after the fixes: failed on 15 distinct
  endpoint/method/status combinations, with remaining gaps above. Do not
  describe the migration as complete or production verified.
- Real Workerd/browser account journey passed: today statistics, two scheduling
  toggles, original edit form/group change, and persisted read-back. Cloudflare
  asset build and all 81 local migrations passed in that runner.
- The browser journey found a missing account-priority projection: the adapter
  borrowed group-membership priority 0, invalidating the original min=1 form.
  The backend now provides the original account schema default 50 when absent,
  while retaining explicitly saved values. The original form now submits.

- Model sync slice: 66 focused Worker tests passed (15 model tests, 14 RBAC
  tests and 37 account tests); an additional stale-editor metadata regression
  passed in the provider-account suite. Frontend selector + adapter: 40 passed.
- The expanded original account browser journey passed (1.8s), including
  persisted model mapping and capability metadata. Both TypeScript checks passed.

- General bulk edit: full Worker suite passed (187 files, 1859 tests), followed
  by 52 passing account tests after the priority-only scheduling correction.
  Frontend bulk dialog + transport passed 90 tests, including removed-target
  handling. Typechecks passed. The final real Workerd/browser journey passed
  (2.5s), including actual account-group priority readback after bulk editing.

## Next work

1. Finish original account model routing across older stored accounts, provider-specific rules, model plaza and media; broaden gateway action evidence beyond the passing text creation journey.
2. Audit P0 create/edit/bulk/delete/credential and routing fields against Go;
   exercise group, user, key and subscription mutations from original dialogs.
3. Close shared account/settings dependencies, then rerun full page patrol.
4. Implement remaining P1/P2 contracts and action journeys without UI reductions.
5. Run relevant binding tests and deployment verification after local closure.
   No deployment or production data mutation has been performed in this work.
