# Sub2API Cloudflare Worker

This directory is the replacement runtime for the current Go service. During
the migration the Go backend remains only as a contract reference; new runtime
features belong here and must use Cloudflare-native bindings.

## Local setup

1. Install dependencies with `pnpm install` in this directory.
2. Build the SPA with `pnpm run build:assets`.
3. Apply local D1 migrations with `pnpm run db:migrate:local`.
4. Start the local Worker with `pnpm run dev`.

The development, staging, and production resource IDs in `wrangler.jsonc` are
distinct placeholders. Create separate Cloudflare resources for every
environment and replace every placeholder before the first remote deployment.

## Checks

Run `pnpm run check` for TypeScript and unit tests. The Worker deliberately
returns an explicit 404 for API routes that have not migrated yet instead of
silently serving the SPA shell.

## Durable Object state contracts

`UserStateDO` stores money only as safe integer micro-units. Its internal
`POST /configure` creates the initial profile and requires `schema_version`,
`mutation_id`, `user_id`, `balance_micros`, and `enabled`. The same mutation
and values may be retried as a no-op; after initialization every different
configuration mutation is rejected.

Later balance changes use `POST /balance/adjust` with `schema_version`,
`mutation_id`, and a non-zero signed safe-integer `amount_delta_micros`.
`POST /enabled` changes enabled state independently with `schema_version`,
`mutation_id`, and `enabled`. Callers must reuse each stable mutation ID only
with its original parameters. Opening balances, adjustments, enabled changes,
and settlements are appended to the immutable ledger in the same SQLite
transaction as the profile/request mutation. `GET /snapshot` returns the latest
100 requests and ledger entries.
`POST /release` is canonical; `POST /cancel` remains a compatibility alias.

`PoolStateDO` restores expired leases when an instance starts, schedules the
earliest active lease with a Durable Object Alarm, and reschedules or clears the
alarm after state changes. Request IDs remain tombstones for seven days so a
retry cannot silently acquire a second account lease.

Queue messages use the versioned envelope `event_id`, `event_type`,
`occurred_at_ms`, `aggregate_type`, `aggregate_id`, and `payload`. D1 outbox
rows carry the same routing and occurrence fields before a Queue consumer is
introduced.
