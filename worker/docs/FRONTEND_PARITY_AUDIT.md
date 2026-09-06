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
