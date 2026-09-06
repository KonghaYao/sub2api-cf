# Frontend parity audit and migration rule

Baseline: `origin/main` at `5097b3145`. Audited release: `ccdc74cb1` (`v0.40.0`).

## Non-negotiable rule

Existing Vue templates, styles, classes, field sets, actions, and routes are the product contract.
Cloudflare support must be implemented below that contract in the API adapters, Worker handlers,
D1 schema, Durable Objects, KV, R2, and Queues. A Worker-specific branch must not replace a form,
hide an existing control, remove a column, or redirect an existing page to conceal a missing backend
capability.

If a capability cannot execute yet, the original control remains present and the backend returns an
explicit typed error. It must never silently discard a submitted field or return an unfiltered list.

## Audit size

- 294 frontend files changed: 22,475 insertions and 3,426 deletions.
- 93 Vue SFCs changed.
- 43 Vue templates changed.
- 39 Vue files contain class-attribute changes.
- No standalone CSS/SCSS/LESS file and no Vue `<style>` block changed. The visual regressions came
  from replacement templates, conditional rendering, and added/changed layout classes.

## Highest-priority parity gaps

### Provider accounts

- Create and edit use Worker-only replacement forms instead of the original forms.
- The replacement forms omit account types, providers, credentials, notes, proxy, scheduling,
  priority/load, expiry, quota, rate/window/session controls, model mapping, TLS fingerprinting,
  privacy, billing probes, and provider-specific options.
- List columns, filters, row actions, tools, and bulk actions are conditionally removed.
- Several original operations are not backed by Worker endpoints.

### Other administrator and user pages

- Sidebar and router hide or redirect Dashboard, Channel Monitor, Plugins, Proxies, Risk Control,
  Prompt Audit, custom administrator pages, and several payment routes.
- Settings, Ops, and Usage replace their original page shells with Worker-only reduced pages.
- Groups and Channels hide fields, statistics, ordering, and advanced pricing controls.
- API adapters for users and accounts silently discard some original fields and filters.

## Migration order

1. Restore provider-account templates and all original account controls without style changes.
2. Add lossless account CRUD compatibility storage: normalized core columns, encrypted full
   credentials, non-secret UI configuration, opaque IDs, CAS, and exact clear/omit semantics.
3. Implement every account list filter/sort and every visible account action; no silent fallback.
4. Restore Settings, Ops, Usage, Groups, Channels, routes, and sidebar to their original templates.
5. Implement the Worker contracts behind those restored pages, simplifying internals only where the
   observable behavior and data contract remain correct.
6. Run focused contract/parity tests once per changed slice. Reserve full browser journeys
   for cross-cutting changes; normal releases use typechecks, a SPA build, and health/version smoke.

## Account compatibility storage contract

- D1 stores only non-secret UI configuration and normalized searchable/sortable fields.
- The existing AES-GCM credential vault stores the complete credential object. Token, key, cookie,
  password, service-account, and private-key values never enter plaintext D1 columns or responses.
- Create and update accept the original account DTO. Omitted fields are preserved; explicit null,
  empty object, or empty array values clear the corresponding field.
- List and detail return the original non-secret fields plus `credentials_status`; they never decrypt
  or return credential values.
- Fields not yet used by a runtime executor are identified as stored configuration, not presented as
  active runtime behavior.


## v0.41 incremental release — 2026-09-06

- Restored seven account templates/styles and retained full account DTOs in API adapters.
- Migration 0064 adds non-secret account UI configuration; full credentials stay encrypted.
- Validation: 25 Worker account tests, 36 frontend adapter/parity tests, Worker typecheck
  and Cloudflare SPA build passed. Full suites were not repeated.
- Production pre-migration D1 Time Travel bookmark:
  `00000029-000003ab-000050de-481778af4738c0904c314ea16e8a062a`.
- Release commands now typecheck/build/migrate/deploy without automatically running full
  unit and binding suites. `pnpm run check` remains available explicitly.
- Next slice: account list type/privacy filtering and retained sorting contracts.

## v0.41.1 incremental release — 2026-09-06

- Account type and stored privacy filters now constrain both D1 count and paged results.
  Missing legacy UI config falls back to the normalized credential kind; `__unset__`
  matches absent/non-text/blank privacy metadata.
- Added priority, expiry, and schedulable sorting with deterministic ID tie-breaks.
- Focused SQLite account suite: 17 tests passed. No schema migration required.
- Default staging/production commands now run Worker typecheck, SPA build/typecheck,
  verified D1 migration runner, and deployment. Full `check` stays opt-in.
- Remaining account work includes runtime status filters, upstream billing/last-used
  sorting, and execution contracts for the restored actions.
- v0.41.0 was published as Worker version `8d8dcb12-7a65-4066-9371-fa69c16aaa0d`;
  local HTTP smoke timed out, so deployed health has not been established.

## v0.42 Groups UI and form storage — 2026-09-06

- Restored the Groups view to baseline `5097b3145`, including templates, styles,
  actions, columns and original capability-loading behavior. Added a fixed parity hash.
- API adapter preserves every submitted field while translating existing units/names.
- D1 0065 stores the allowlisted advanced group form configuration. Omitted fields
  survive updates; null/empty values round-trip. Normalized core fields remain authoritative.
- The response lists advanced fields under `compatibility.stored_only_fields`: saving
  these fields does not implement their gateway policy. Nonempty account-copy requests
  return an explicit 409; unknown top-level fields return 400.
- Focused validation: 24 Worker catalog/SQLite tests and 24 frontend Groups tests
  (including original view tests, adapter preservation and parity) passed.
- Remaining: advanced pricing/routing/reasoning policy execution, group copy/order
  operations, live capability and usage/capacity summary contracts, plus deployed
  authenticated CRUD verification. This is a storage/UI slice, not Groups completion.
- Worker typecheck and Cloudflare SPA build passed. Production D1 pre-migration
  bookmark: `00000029-000003f3-000050de-c8e62995ffcefe18eb6015357dcce68f`.

## v0.42.1 Groups sort action — 2026-09-06

- The original sort dialog now calls a native Worker route for 1–100 groups.
  Opaque IDs, per-group control versions and a request idempotency key are preserved.
- D1 applies the complete sort batch and replay record atomically. A stale version,
  including a race after the read, rolls back the whole batch with HTTP 412.
- Validation: 15 SQLite group tests and 11 frontend adapter/parity tests passed;
  the race regression proves no partial sorting. No schema change.
- Still missing: group duplication, statistics and API-key listing, usage/capacity
  summaries, live discovery, composite route operations, per-user rate multipliers,
  account copying, and execution of the advanced stored-only configuration fields.
- v0.42.0 deployment version: `2a765763-e7a7-4e36-88ab-0aa13789c65b`.
  D1 0065 applied successfully; current-machine HTTPS smoke timed out.

## v0.42.2 Groups duplicate action — 2026-09-06

- The original duplicate button now calls the Worker. Retry keys survive ambiguous
  failures for both opaque and numeric administrator IDs; the backend scopes replay
  to the authenticated actor and source group.
- Copies normalized group fields (including multipliers/quotas/image billing), stored
  advanced UI configuration, model mappings, active model prices, channel membership,
  and account bindings with exact priority/weight. OAuth-only source configuration
  excludes API-key accounts from copied bindings. Existing credentials stay on the
  original account; no credential rows are copied or returned.
- New group ID/name, inactive status, fresh timestamps, zero control versions and
  independent price IDs/version 1. Name collisions advance Copy/Copy 2 (bounded at 100).
  Source configuration CAS, all relations and the replay record commit atomically.
- Does not copy user permissions, user-specific rate/RPM overrides, API keys, subscription
  plans/entitlements, retired prices, usage, financial history or runtime state.
- Validation: 2 SQLite duplication journeys (including rollback/retry) and 22 frontend
  tests passed; Worker typecheck passed. No schema change.
- Remaining visible gaps: statistics/API-key listing, usage/capacity summaries, live
  discovery, composite routes, per-user rate multipliers, copying accounts into an
  existing group, and advanced stored configuration execution.
- v0.42.1 deployed as `3f5bf6b0-e098-4ec4-b3ab-bda7e29520e6`; production HTTP
  health has not been established from this machine.

## v0.42.3 Groups actual usage summary — 2026-09-06

- Restored the original usage-summary request. It returns every group's opaque ID
  and today/yesterday/cumulative actual customer cost in USD, including inactive
  groups and genuine zero-usage groups. Browser timezone parameters do not affect it.
- Server `GROUP_USAGE_TIMEZONE` defaults to Asia/Shanghai, matching the original
  backend deployment default. Calendar boundaries reuse the existing DST-aware
  utility; yesterday is a calendar day rather than a fixed 24-hour subtraction.
- Aggregates exact `usage_projection.amount_micros`, which maps to legacy actual_cost.
  Provider cost and standard pricing are not substituted. Ungrouped usage is excluded.
  D1 0066 adds a covering group/time/cost index. Cumulative queries still scan retained
  projected group usage; durable rollups can replace that scan in a later performance slice.
- Summary reflects asynchronously projected settlements; pending Queue events are
  not included. Imported history must exist in the projection to contribute to totals.
- Validation: 3 SQLite/HTTP tests and 21 original frontend/adapter/parity tests passed,
  covering Shanghai boundaries, New York DST, empty groups, index use and unauthenticated access.
- Remaining: real capacity/concurrency/session/RPM stats, detailed group stats and
  API-key listing, live discovery, composite routes, user multipliers and advanced
  configuration execution. Capacity values are not inferred from usage.
- v0.42.2 deployed as `56c263de-2f99-43ed-a3ff-9a624d943322`.

## v0.42.4 Groups concurrency capacity — 2026-09-06

- Restored the capacity-summary request with real active upstream concurrency
  from authoritative POOL_STATE lease snapshots. D1 0067 records only pools
  configured by successful routing, so administrator reads cannot create empty
  Durable Objects while discovering capacity.
- The handler reads all eligible account ceilings and registered pools in one D1
  batch, then fetches pool snapshots with at most 16 concurrent calls. Snapshot
  reclamation removes expired leases before returning counts. A failed snapshot
  changes the entire group's concurrency status to `unknown`; it never becomes 0.
- Worker has no recoverable counterpart to the legacy Redis active-session or
  account-RPM authorities. Those values are explicitly `unknown` and null. The
  original UI renders only the proven concurrency badge and does not infer values
  from usage records.
- Validation: 4 Worker D1/DO-boundary tests and 20 frontend contract, column and
  parity tests passed; Worker typecheck passed. Remaining: session/RPM authority,
  detailed group stats/API-key listing, live discovery, composite routes, user
  multipliers and advanced configuration execution.
- Worker typecheck and SPA build passed. D1 0067 pre-migration bookmark:
  `00000029-0000048f-000050de-3a9f1845c7e1921cd9aad86ae7df8791`.

## v0.42.5 Groups user rate multipliers — 2026-09-06

- Restored the original per-user multiplier endpoint behind the retained modal.
  The list keeps legacy entry fields, including companion RPM overrides; optional
  search and bounded paging are available to direct clients without changing the
  modal's array response.
- A save replaces the group's rate-multiplier set: users omitted from the request
  return to the group default. RPM overrides remain intact. The explicit clear
  operation removes both rate and RPM overrides, matching the original combined
  persistence model.
- Rate inputs are converted once to deterministic integer ppm before D1 writes.
  Gateway route resolution already selects the user ppm before calculating the
  reservation and settled usage amount. The frontend now also carries opaque
  Worker user IDs through both rate and RPM dialogs.
- Group control versions and idempotency keys protect writes. D1 0068 adds the
  group-first lookup index used by list/search and clear operations.
- Validation: 3 new rate administration SQLite journeys plus 2 gateway billing
  override tests passed; Worker typecheck, frontend typecheck and Cloudflare SPA
  build passed. Full suites were intentionally not repeated.
- Production D1 pre-migration bookmark: `00000029-000004db-000050de-fff18bb107b7c0685ec925059274e09f`.

## v0.42.6 Groups composite routes — 2026-09-06

- The restored composite-route dialog now has native list, create, update,
  delete and preview routes. D1 0069 restricts rows to composite groups and
  concrete Worker providers; endpoint, exact/prefix matching, priority and
  stable route ID ordering are explicit.
- Gateway resolution consults enabled explicit routes before selecting a group
  model. A match constrains the selected model and account candidates to its
  target platform, then applies its upstream-model rewrite. No matching rule
  remains an explicit preview miss rather than fabricated configuration.
- Writes use opaque IDs, CAS and idempotency keys. The original Groups template
  and styles remain unchanged.
- Validation: 2 SQLite CRUD/preview journeys and the gateway routing/billing
  fixture (5 tests total), Worker typecheck and SPA build passed. Full suites
  were intentionally not repeated.
- Production D1 pre-migration bookmark: `00000029-00000527-000050de-5046e408c7d8458c57974226c1c3f699`.

## v0.42.7 Groups custom model directory — 2026-09-07

- The existing Groups model-list controls now execute at the gateway. When enabled,
  `/v1/models` and its provider-compatible projections return only configured
  models in the exact UI order; unavailable names are skipped. Disabled or absent
  configuration retains the normal routable catalogue.
- The setting deliberately changes directory discovery only. It does not turn a
  display preference into an access-control rule: an already routable model still
  resolves through the normal gateway route for direct API calls.
- Group create/update validates and normalizes the saved configuration (boolean
  switch, unique trimmed names, bounded list), and continues to use the existing
  group CAS and idempotent D1 write transaction. The existing candidate endpoint
  and original template/style already use this same Worker-backed configuration.
- Validation: 45 targeted SQLite control/gateway tests, Worker typecheck, frontend
  typecheck and Cloudflare SPA build passed. No schema migration was required.

## v0.42.8 Groups model-to-account routing — 2026-09-07

- The retained model-routing switch and account rules now constrain gateway account
  candidates for matching group models. Exact patterns win; otherwise the longest
  trailing-wildcard prefix wins. A configured account that is not currently an
  eligible group candidate yields the normal `no_upstream_accounts` failure.
- Configuration is normalized and validated on group create/update. It accepts
  Worker opaque account IDs as well as legacy numeric IDs, preserves the original
  form template and styles, and is covered by existing group CAS/idempotent writes.
- Remaining visible Groups advanced fields are still: fallback/default model and
  Messages dispatch, reasoning policy, request/live restrictions, time/price and
  profit controls, media pricing, and Claude Code/MCP configuration.
- Validation: targeted CRUD/configuration and gateway routing tests (46 tests),
  Worker and frontend typechecks passed. No schema migration was required.

## v0.42.9 Accounts OpenAI OAuth subscription priority — 2026-09-07

- The original OpenAI OAuth subscription-tier field remains in its existing
  Accounts form. Its save path now sends a typed `subscription_plan`, normalized
  and stored with the account provider configuration; only OpenAI OAuth accounts
  may set it.
- The retained Settings subscription-priority toggle is now persisted. When it
  is enabled, non-free/non-abnormal OpenAI OAuth plans are placed ahead of the
  regular account pool while retaining each pool's original priority and weight.
  D1 0070 validates the configuration and advances the gateway revision so DO
  pool snapshots refresh coherently.
- The Accounts template/style/class parity fixture passed unchanged. Validation:
  59 targeted Worker SQLite/control/gateway tests, Worker/frontend typechecks,
  58 frontend account parity/modal tests and the SPA build passed.

## v0.42.10 Accounts duplicate action — 2026-09-07

- The original Accounts action-menu duplicate operation now has a Worker route.
  It atomically re-encrypts the copied credential under a new secret ID and
  preserves group links, model capabilities and safe UI configuration.
- Duplicate requests use a deterministic idempotency record: retries return the
  same copied account rather than creating a second clone. The original menu,
  list refresh, template and styles are unchanged.

## v0.42.11 Accounts subscription-plan contract hardening — 2026-09-07

- `provider_config.subscription_plan` now follows the same OpenAI OAuth-only
  contract as the top-level form field on both account creation and update.
  This closes the direct configuration path that could otherwise assign a paid
  subscription plan to an API-key account.
- Validation: focused SQLite account suite (18 tests) and Worker typecheck
  passed. No schema change or visible UI change.

## v0.42.12 Accounts batch delete — 2026-09-07

- The original bulk-delete button now sends opaque account IDs with their
  control versions. The Worker deduplicates compatible targets, rejects empty,
  missing, stale, or conflicting sets before deletion, and retains the original
  list reload and selection clearing behavior on success.
- A single D1 transaction removes each account and its vault, group/model,
  health and pending synthetic-probe state; provider media jobs are detached
  before account deletion. Account-delete triggers advance the gateway revision,
  causing registered pools to refresh without retaining deleted account state.
  The deterministic idempotency response makes an ambiguous retry safe.
- Validation: 20 focused Worker SQLite tests, 38 frontend adapter/parity tests,
  Worker/frontend typechecks and Cloudflare SPA build passed. No schema or
  template/style/class change.

## v0.42.13 Accounts OpenAI OAuth credential refresh — 2026-09-07

- The retained Accounts refresh action now calls the official OpenAI OAuth token
  endpoint for OpenAI OAuth accounts. The Worker retains a rotated refresh token
  when supplied, updates access/id tokens and expiry atomically in the AES-GCM
  vault, and never returns or logs those secrets.
- Requests require an account control-version CAS header and idempotency key.
  Concurrent or stale refreshes cannot overwrite newer credentials; the account
  projection, vault update, health reset and gateway revision update share one
  D1 transaction. Unsupported account kinds remain visible and return typed
  errors.
- A fresh ID token fills missing email, ChatGPT account/user, plan and default
  organization metadata without replacing values explicitly maintained in the
  account. Upstream 4xx, 5xx, transport and timeout failures leave credentials
  untouched.
- Validation: 24 focused Worker SQLite tests, 39 frontend adapter/template
  parity tests, Worker typecheck and Cloudflare SPA build passed. No schema or
  template/style/class change.

## v0.42.14 Accounts OpenAI OAuth batch refresh — 2026-09-07

- The existing Accounts bulk “refresh token” action now uses the Worker rather
  than a missing legacy endpoint. It accepts up to 25 opaque account IDs with
  their control versions, refreshes at most five upstream OAuth requests at a
  time, and reloads the original list after completion.
- Each account has its own atomic vault/CAS/idempotency transaction. A rejected,
  stale, unsupported or failed account reports a typed per-account error without
  affecting successful siblings; retrying the batch replays completed account
  results without another upstream token exchange.
- Validation: 25 focused Worker SQLite tests, 40 frontend adapter/template
  parity tests, Worker/frontend typechecks and Cloudflare SPA build passed. No
  schema or template/style/class change.
