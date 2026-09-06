# Sub2API Cloudflare Worker

This directory is the replacement runtime for the current Go service. During
the migration the Go backend remains only as a contract reference; new runtime
features belong here and must use Cloudflare-native bindings.

## Local setup

1. Install dependencies with `pnpm install` in this directory.
2. Build the SPA with `pnpm run build:assets`.
3. Apply local D1 migrations with `pnpm run db:migrate:local`.
4. Start the local Worker with `pnpm run dev`.

Development and staging still use placeholders. Production is bound to the
dedicated D1, KV, R2, Queue, and Durable Object resources created for this
project.

## Core gateway configuration

The first Worker-native gateway slice supports:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses` (plus the `/responses` compatibility alias)
- native JSON and SSE pass-through for OpenAI-compatible HTTPS upstreams

Gateway JSON requests are capped at 2 MiB before and after gzip/deflate
decompression. Unknown or stacked content encodings are rejected before any
account lease or billing reservation is created.

Set three independent production secrets before accepting traffic:

```sh
wrangler secret put API_KEY_PEPPER --env production
wrangler secret put CREDENTIALS_MASTER_KEY --env production
wrangler secret put ADMIN_TOKEN --env production
```

Each value must be high entropy; the last two keying secrets and the admin
token must not be reused. Bootstrap a first user/group/account after applying
D1 migrations (one bootstrap request accepts up to 20 models):

```sh
curl -X POST https://YOUR_WORKER/api/v1/admin/bootstrap \
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{
    "user":{"email":"admin@example.com","balance_micros":100000000},
    "group":{"name":"default"},
    "account":{"name":"primary","base_url":"https://api.openai.com/v1","api_key":"UPSTREAM_KEY","max_concurrency":4},
    "models":[{
      "public_name":"gpt-5-mini",
      "endpoint":"both",
      "input_micros_per_million":250000,
      "output_micros_per_million":2000000
    }]
  }'
```

The returned customer API key is shown once. D1 stores only its
HMAC-SHA-256 digest. The upstream key is encrypted with AES-256-GCM and bound
to the account/secret version as authenticated data. Client-supplied proxy,
base URL, SOCKS, uTLS, JA3, and transport controls are rejected.

Ordinary asynchronous Images tasks keep request, result, and image payloads in
private R2 objects. Remote provider image URLs are downloaded only over HTTPS,
without redirects, with a 60-second and 32 MiB remote-image bound. Inline
Base64/data-URL outputs are capped at 8 MiB to stay within the Worker's 128 MiB
memory ceiling while JSON, UTF-16 and decoded representations overlap. For the
strongest DNS-rebinding boundary, set `ASYNC_IMAGE_DOWNLOAD_HOSTS` to a JSON
array (or comma-separated list) of trusted provider CDN hosts; exact hosts and
their subdomains are accepted. If it is unset, public hostnames are accepted
while private/local names and IP ranges remain blocked.

Synchronous and asynchronous Images settlement uses the outputs actually
completed by the provider, even when a provider returns more images than the
requested `n`. A versioned recovery command first commits the final amount in
the balance/subscription, API-key and platform-quota Durable Objects; only
after every authority accepts the same amount may any settlement run. If a
balance hold cannot fully fund already-completed provider work, the remainder
is recorded as user spend debt and future credits repay it before becoming
spendable.

## Email delivery

Before enabling email verification or password reset in production, configure a
Cloudflare Email Service binding named `SEND_EMAIL` and set
`EMAIL_FROM_ADDRESS` to an account-verified sender. The repository intentionally
does not put an environment-specific sender address in `wrangler.jsonc`.

The optional `EMAIL_DELIVERY` Worker service binding remains available as a
compatibility adapter. Registration, reset, account verification, and user
notification-email codes all pass through the Queue consumer with a D1 delivery
lease. Delivery fails explicitly (and is retried) when neither binding is
configured; when both exist, `SEND_EMAIL` is used.

User notification preferences are stored independently from profile rows and
use `notification_preferences_version` (or `If-Match`) for optimistic writes.
The profile response returns that version and verified notification addresses.

The read-only administrative audit stream is available at
`GET /api/v1/admin/audit/events`, with category-scoped detail under
`/api/v1/admin/audit/events/:category/:id`. It requires `admin.audit.read` and
has no clear/delete endpoint.

## Checks

Run `pnpm run check` for TypeScript and unit tests. The Worker deliberately
returns an explicit 404 for API routes that have not migrated yet instead of
silently serving the SPA shell.

Run `pnpm run test:e2e:bindings` for the fully local Cloudflare binding E2E.
It uses the official `@cloudflare/vitest-plugin` and a dedicated
`wrangler.e2e.jsonc`; every invocation starts from isolated Miniflare storage,
applies every D1 migration, and never reads production bindings or secrets. The
suite drives the real Worker fetch router through bootstrap, password
registration/login, user API-key creation, a non-streaming Chat Completions
request, Durable Object admission/billing/pool state, Queue production and
consumption, and final D1 usage/balance projections. It also executes real local
KV and R2 bindings. Outbound provider traffic is handled by a deterministic
test-only Workerd outbound service and cannot reach a real provider.

This command proves local binding compatibility only. It does not replace a
staging/production smoke run against deployed bindings, Cloudflare routing, or
a real provider account.

## Deployment

Use `pnpm run deploy:staging` or `pnpm run deploy:production`. These are the
supported release entry points: they run the Worker checks, build the SPA,
apply the target D1 migrations, and only then deploy the Worker. The default
`pnpm run deploy` intentionally targets production through the same guarded
pipeline; do not invoke `wrangler deploy` directly for a release.

Remote releases use the repository's recoverable D1 migration runner rather
than `wrangler d1 migrations apply`. It imports each SQL file independently
with `wrangler d1 execute --file`, verifies the exact `version` and `name` in
the project's `schema_migrations` ledger, and only then registers the filename
in Wrangler's `d1_migrations` ledger. If an earlier attempt committed the SQL
but stopped before Wrangler registration, the next run repairs the missing
registration without executing that SQL again. Unknown or contradictory rows
in either ledger stop the release before another migration is imported.

Run only one migration/deploy command for a target database at a time. Before a
production schema release, retain the current Time Travel bookmark in the
release record:

```sh
wrangler d1 time-travel info DB --env production --json
pnpm run deploy:production
```

The first command is read-only. The second command is resumable after a failed
file import or an interruption between the verified import and registration.

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

`PoolStateDO` also renews active leases with an ordered idempotency sequence,
so long SSE streams do not silently lose their concurrency slot. Pools are
isolated by group, model, and endpoint so concurrent model traffic cannot
overwrite another model's account snapshot.

Queue messages use the versioned envelope `event_id`, `event_type`,
`occurred_at_ms`, `aggregate_type`, `aggregate_id`, and `payload`. D1 outbox
rows carry the same routing and occurrence fields. Financial settlement and a
`UserStateDO` outbox event are committed in one SQLite transaction. The Queue
consumer writes an idempotent D1 usage projection and coalesces API-key
`last_used_at_ms` updates. A D1 recovery command is written before settlement;
Queue retries and the minute Cron trigger recover transient Durable Object
failures, and exhausted Queue messages are retained in a production DLQ.
Settlement recovery is parked for manual review after 20 failed automatic
attempts instead of consuming Cron work forever.

Account acquisition cost is stored separately from the customer charge. The
v0.31 schema snapshots the canonical cost, an optional scoped account-stat
override, the account's exact PPM multiplier, and the resulting account cost
on each usage row so later pricing edits cannot rewrite historical margins.
The Queue consumer also maintains a sparse 15-minute D1 rollup for account
statistics. Migration does not rewrite the historical usage table; scheduled,
write-budgeted recovery folds recent legacy facts into the rollup while the
read path uses a bounded raw fallback. When a public channel alias resolves to
a unique different upstream model, the account-cost snapshot uses that
upstream model's base catalog price while the customer charge keeps its public
model snapshot. v0.32 also freezes the selected channel price graph at route
time and stores its exact token/per-request, interval, service-tier and time
pricing decision with the usage event. Customer billing therefore cannot be
changed by a later channel edit, and ambiguous prices fail before a hold is
created.
Custom rules currently support input, output and cache-read tokens plus flat
per-request/image prices. Cache-write and image-token dimensions are rejected
until the gateway usage projection carries those quantities. The legacy
`apply_pricing_to_account_stats` switch now uses the frozen channel basis after
any scoped custom account-stat rule and before the account multiplier. Channel
image/video pricing remains fail-closed until the media projection carries its
complete price dimensions.
