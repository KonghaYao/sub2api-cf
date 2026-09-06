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
