# Scheduling settings lifecycle audit (local changes after 0.43.0)

## Go semantics and Worker implementation

- `openai_low_upstream_rate_priority_enabled`: only OpenAI/Codex legacy selection (advanced disabled). After fixed affinity/capacity constraints, lower upstream token rate precedes ordinary priority only when at least two eligible accounts have distinct known rates. Unknown rates are neutral when that evidence is absent. Advanced mode retains its weighted upstream-cost factor.
- `openai_oauth_scheduling_rate_multiplier`: OAuth scheduling reference, default 1, not a billing price. API-key reference comes from a fresh compatible `/v1/sub2api/billing` probe. It is never inferred from local account cost or user wallet. Current-time peak is recomputed using the upstream timezone/window, not copied from an old `effective_rate_multiplier`.
- Probe snapshots now carry credential-reference/base-URL/platform identity. Old unbound or mismatched snapshots become unknown until a real probe succeeds; failed probes cannot carry a previous identity's successful data.
- `account_scheduling_thresholds`: integer 1–100 per OpenAI/Anthropic/Grok, with 100 disabled. OpenAI official OAuth/Codex uses `/backend-api/wham/usage`, exact 5h/7d windows; Anthropic OAuth uses `/api/oauth/usage`. Requests are sent through the account proxy/identity helper, bounded to 8s and 64KiB, no redirects. Secret-version/provider/URL-bound cache is fresh for 60s; a previous valid observation is used for at most 120s. Failed/absent quota is unknown, not proof of exhaustion. API-key wallets and generic OpenAI token headers are never used as official quota. Unsupported custom OAuth origins are not queried at official endpoints.
- Grok threshold uses actual most-constrained rolling requests/tokens response headers (including `x-rate-limit-*` aliases), with 25h reset ceiling. It does not use official billing 7d/30d figures. Credential changes invalidate the observation, and elapsed reset permits selection again.
- Reached thresholds exclude the selected account from further attempts and release its Pool lease; all exhausted attempts cancel financial holds. They do not mark an account unhealthy. A generated response is settled normally; mere rejection is free.

## Isolated ungrouped scheduling

`0095_ungrouped_scheduling.sql` keeps all existing non-null financial foreign keys. Enabling `allow_ungrouped_key_scheduling` lazily creates a dedicated `worker-ungrouped-default` composite group. It starts with **no models or prices**. Administrators must explicitly configure that independent catalog; nothing is copied from any ordinary group.

Database triggers bind only accounts without ordinary group assignments. Adding an ordinary assignment atomically removes the virtual assignment; removing the last ordinary assignment restores it. Linking a private/grouped account into the virtual pool is rejected. The virtual identity, standard/public billing character, rate multiplier 1, and absence of group fallbacks are protected. The group cannot be deleted or manually enabled against the system switch. Other public-group restrictions still apply to users.

User/admin Key create and explicit `group_id:null` patch map to this dedicated identity and run the existing authoritative group-access checks. UI advertises the virtual group only while enabled. Disabling the setting disables the group atomically, so both gateway authorization and financial DO reauthorization reject it. Selected-account credential lookup also now checks group enabled. The same stable group ID is used throughout request observations, reservation, Pool, settlement and usage.

The full workerd test additionally exposed and fixed two pre-existing composite-group bugs: management rejected explicitly attaching a model to a composite group, and UserState/SubscriptionState DO financial authorization rejected composite despite the gateway accepting it. Both now preserve normal group/user checks while accepting composite as a group type.

## Local evidence

- `/tmp/scheduling-final-workerd.log`: 7 tests passed across Pool scheduler, official quota and isolated ungrouped lifecycle in real workerd/D1/DO.
- Official quota fixture at 85% and threshold 80 returns 503; wallet remains 1,000,000 micros and reserved becomes 0. After the window reset, the same key succeeds and the wallet becomes 999,983 (17 micros exactly once). Account health is not set unhealthy.
- Ungrouped model absent: 404. After explicit default catalog/price configuration and removing the account's private assignment: 200, wallet 999,973 (27 micros). Reassigning the account to its ordinary group prevents further access. Disabling ungrouped returns 403 and the balance remains unchanged, with zero holds.
- `/tmp/scheduling-regressions.log`: 149 focused gateway, composite, scheduler and SQLite probe tests passed. `/tmp/ungrouped-keys-tests.log`: 38 user/admin Key tests passed, including explicit null group creation and disabled-switch rejection. `/tmp/scheduling-probe-identity.log`: 7 probe tests passed, including identity-change failure dropping stale data.
- `/tmp/scheduling-ui-parity.log`: original SettingsView template/style parity passed with one exact-normalized explanatory title addition. All original controls remain.
- Worker TypeScript was green after these changes; later full checks in `/tmp/scheduling-final-tsc.log` reported concurrent Antigravity platform-expansion gaps owned by root, not this scheduling work.

## Boundaries

No production state, credentials, deployment or real provider quota was accessed for these changes. Official and inference traffic in workerd is intercepted by an explicit local fixture. This proves route/authorization/billing wiring and protocol parsing, not that a particular production OAuth token can reach a provider quota endpoint. Threshold unknown is deliberately distinct from healthy or exhausted. Production deployment/verification remains root's responsibility.

## Follow-up: Antigravity cross-client lifecycle

`handler.ts` now bridges explicitly authorized OpenAI Chat/Responses and Anthropic Messages routes to the native Gemini adapter. Function tools require complete prior call context; unsupported built-in tools, strict schema guarantees, unknown content blocks, stateful Responses fields, compaction and token-count operations are rejected rather than silently approximated. Anthropic system messages remain system instructions; supported stop sequences/top-k are preserved. Other Anthropic thinking/output controls are explicitly rejected at this seam.

Unary responses extract actual native usage before translating client output. The SSE bridge reads through EOF, preserves trailing usage chunks, and requires a real successful finish; errors and truncation do not manufacture `completed`. The same test uncovered the existing native Gemini tracker ending at STOP before a separate usage chunk, which estimated 510 micros instead of the reported 27. Native Gemini now drains through EOF too. Gemini generationConfig output limits are also projected into reservation validation, preventing conversion from bypassing model maximums or under-reserving funds.

Final local evidence: `/tmp/anti-cross-final-workerd.log` 7 tests passed, including root native catalog/account/Gemini lifecycle and all three client protocols (stream and unary each 27 micros, two-call wallet 999946), error-only free, truncation failed, excessive output rejected, insufficient funds rejected with no hold. `/tmp/anti-cross-final-unit.log` 143 focused tests passed. `/tmp/anti-cross-final-tsc.log` TypeScript passed. Root owns Antigravity envelope/provider changes and the fixture, this follow-up owns handler and cross-client tests. No production provider was contacted.
