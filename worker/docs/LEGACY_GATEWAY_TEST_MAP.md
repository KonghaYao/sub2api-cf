# Legacy gateway test migration map

This ledger maps behavior from the Go gateway to observable Worker contracts.
It is deliberately behavior-based: a passing test count is not evidence that a
whole Go suite has migrated.

Status vocabulary:

- **Retain** — the public wire behavior is still required and has a Worker test.
- **Replace** — the intent remains, but the Go process/Redis/repository mechanism
  is replaced by a Cloudflare-native seam with its own contract test.
- **Remove** — the behavior depends on a host/container capability that is not
  part of the Workers-only product and must not be emulated.
- **Pending** — no sufficiently equivalent Worker evidence exists yet. Pending
  is recorded explicitly instead of being counted as coverage.

## Exact protocol behaviors retained in this migration

| Go source and behavior | Decision | Worker evidence |
|---|---|---|
| `pkg/apicompat/chatcompletions_responses_test.go`: `BasicText`, `SystemMessage`, forced upstream stream, `store=false`, encrypted reasoning include | Retain | `test/gateway/legacy-chat-responses.test.ts` — forced bridge stream and allow-listed controls |
| Same: `ToolCalls`, assistant text plus tools, tool result identity, omitted arguments become `{}` | Retain | `test/gateway/legacy-chat-responses.test.ts` — assistant/reasoning/tool identity |
| Same: `ToolStrict`, service tier, parallel tool calls and Chat tool choice conversion | Retain | `test/gateway/legacy-chat-responses.test.ts` — tool projection |
| Same: max token preference/floor and reasoning effort | Retain | `test/gateway/legacy-chat-responses.test.ts` — 128-token floor and reasoning controls |
| Same: GPT-5 sampling controls are stripped, non-reasoning sampling controls remain | Retain | `test/gateway/legacy-chat-responses.test.ts`; non-reasoning branch is also exercised by the first case |
| Same: JSON object/schema response formats | Retain | `test/gateway/legacy-chat-responses.test.ts` — JSON schema projection; `test/gateway/protocols/responses.test.ts` — reverse format projection |
| Same: image URL, file data, file ID, empty media and `content:null` handling | Retain | `test/gateway/legacy-chat-responses.test.ts` — multimodal/empty-content golden |
| Same: buffered Chat response reasoning, tools, refusal, usage, incomplete reason and public model restoration | Retain | `test/gateway/protocols/responses.test.ts` |
| `chatcompletions_responses_request_invariants_test.go`: parallel answered tools remain paired; orphan/dangling history is removed for a Chat-only upstream | Retain | `test/gateway/protocols/responses.test.ts` — normalized tool history and truncated arguments |
| `responses_created_at_wire_test.go`: upstream timestamp preservation and stable stream timestamp | Retain | `test/gateway/legacy-responses-wire.test.ts` |
| `responses_stream_event_wire_test.go`: zero indices and complete function-call fields remain present on the wire | Retain | `test/gateway/legacy-responses-wire.test.ts` |
| `service_tier_passthrough_test.go`: buffered and streamed service tier preservation | Retain | `test/gateway/protocols/responses.test.ts`; `test/gateway/legacy-responses-wire.test.ts` |
| `streaming_stop_reason_test.go`: content filtering maps to `incomplete/content_filter`; length maps to max-output termination | Retain | `test/gateway/legacy-responses-wire.test.ts`; `test/gateway/protocols/responses.test.ts`; `test/gateway/protocols/anthropic.test.ts` |
| `anthropic_responses_test.go`: `response.failed` after partial or empty output closes the Anthropic message and emits exactly one terminal sequence with usage | Retain | `test/gateway/legacy-anthropic-contract.test.ts` |
| Same and `chatcompletions_anthropic_bridge_test.go`: text/tool/usage/stop-reason buffered and streaming bridges | Retain | `test/gateway/protocols/anthropic.test.ts` |
| Same: abnormal EOF is finalized once; truncated tool use keeps `tool_use` termination | Retain | `test/gateway/protocols/anthropic.test.ts` — explicit finalizers |
| `responses_to_anthropic_tool_pairing_test.go`: `tool_use` / `tool_result` identity and pairing | Retain | `test/gateway/protocols/anthropic.test.ts` — paired Responses and Chat projections |
| Anthropic upstream HTTP error classes and non-reflection of provider payloads | Retain | `test/gateway/legacy-anthropic-contract.test.ts` |
| `gemini_chat_completions_compat_service_test.go`: supported inline image output is retained and invalid media is omitted | Retain | `test/gateway/legacy-gemini-contract.test.ts` |
| Gemini semantic error status (`RESOURCE_EXHAUSTED`, etc.) overrides a generic transport status | Retain | `test/gateway/legacy-gemini-contract.test.ts`; complete class matrix in `test/gateway/protocols/gemini.test.ts` |
| Gemini model names cannot inject paths, queries or fragments | Retain | `test/gateway/legacy-gemini-contract.test.ts`; `test/gateway/protocols/gemini.test.ts` |
| Gemini SSE fragmented input, malformed event termination, cumulative deltas and exactly one terminal sentinel | Retain | `test/gateway/legacy-gemini-contract.test.ts`; `test/gateway/protocols/gemini.test.ts` |
| `openai_codex_models_service_test.go`: conservative unknown-model fallback | Retain | `test/gateway/legacy-codex-contract.test.ts` |
| Same: known GPT-5.6 reasoning choices/default and priority service tier | Retain | `test/gateway/legacy-codex-contract.test.ts` |
| Same: dedicated image models are omitted and other model service tiers remain empty | Retain | `test/gateway/legacy-codex-contract.test.ts` |
| `openai_codex_models_handler_test.go`: ETag is computed from the final client body and supports weak/comma validators | Retain | `test/gateway/legacy-codex-contract.test.ts`; authenticated route in `test/gateway/handler.test.ts` |
| `openai_codex_function_call_id_test.go`: native function/custom/tool-search call IDs use the `fc_`/`ctc_`/`tsc_` family, keep call/output pairs aligned and compact oversized IDs deterministically | Retain | `test/gateway/providers/request.test.ts` — Codex provider plan normalization through the public request builder |

## Gateway routes, subroutes and embeddings

| Go source and behavior | Decision | Worker evidence or gap |
|---|---|---|
| `server/routes/gateway_test.go`: Responses compact registration | Retain | `/v1`, root and `/backend-api/codex` aliases in `test/gateway/legacy-gateway-routes.test.ts`; both public aliases, compact whitelist normalization, unary forwarding and exact terminal billing in `test/gateway/handler.test.ts` |
| Same: Responses input-token counting registration | Retain | aliases in `test/gateway/legacy-gateway-routes.test.ts`; both public aliases, official upstream/no-billing behavior, custom-relay local estimation and malformed-upstream error cleanup in `test/gateway/handler.test.ts` |
| Same: unsupported Responses subpaths are rejected | Pending | Route allow-list exists, but a dedicated negative contract for every reserved subpath has not migrated |
| Same: alpha search, synchronous/async images, video and custom voice routes | Pending | Media/search products require Queue/R2 task contracts and are not represented by the text gateway tests |
| Chat request with only a Responses-capable account | Replace | `test/gateway/protocols/chat-from-responses.test.ts`, `test/gateway/repository.test.ts`, `test/gateway/handler.test.ts` and `test/e2e/chat-to-responses.e2e.ts` prove explicit OpenAI/Codex cohort fallback, forced Responses SSE, terminal-without-EOF return, buffered/streamed Chat output, failure fidelity, zero-billable cyber policy, Codex body normalization, public model restoration, interleaved tools, exact billing and one released Pool lease on real local bindings |
| `integration/e2e_gateway_test.go`: Claude/Gemini model lists and normal generation | Replace | Local Worker request contracts in `test/gateway/handler.test.ts`; production-binding E2E remains Pending |
| Same: complex Claude tools/thinking and cross-platform Claude↔Gemini routing | Pending | Pure codecs cover core tools, but there is no full deployed-binding cross-provider test yet |
| `openai_embeddings_test.go`: upstream URL, batch input pass-through, public model restoration and input-only usage | Retain | `test/gateway/handler.test.ts` — embeddings success/billing contract |
| Same: invalid/streaming embedding input is rejected before billing/capacity | Retain | `test/gateway/legacy-gateway-routes.test.ts` |
| Same: embeddings-specific access-state/non-access failover distinction | Replace | `test/gateway/handler.test.ts` proves structured access-state, account-capacity and provider-transient failures switch accounts, while request/permission/model failures do not; every attempt has one Pool lease while billing and API-key monetary reservation/settlement remain request-scoped and exactly once |
| Gemini `embedContent` conversion and native result shape | Retain | `test/gateway/handler.test.ts` — Gemini embedding contract |

## Multiplatform scheduling suites

The following classifications apply test-by-test by behavioral family in
`gateway_multiplatform_test.go` and `gemini_multiplatform_test.go`.

| Original test family | Decision | Worker evidence or gap |
|---|---|---|
| Select only active/schedulable accounts with the requested model capability | Replace | D1 capability intersection in `test/gateway/repository.test.ts`; Pool snapshot contracts in `test/state/pool-state-machine.test.ts` |
| No accounts, all excluded and no model support return typed capacity failures | Replace | Worker repository/Pool and sanitized handler error contracts; provider-specific cases remain Pending |
| Priority, weight, least-recently-used/load-aware selection and exclusion on retry | Replace | Pool Durable Object selection tests; no Go in-memory scheduler is retained |
| Platform forcing and composite alias ownership | Replace | Explicit `(group, model, endpoint)` D1 routes and account-model capabilities; native provider-adapter routing tests must remain green |
| Sticky session hit/clear/model mismatch/in-group rules | Replace | `test/state/pool-state-machine.test.ts`, `test/e2e/pool-affinity.e2e.ts`, `test/gateway/handler.test.ts`, and repository routing fixtures prove route-scoped Pool affinity hit, TTL refresh, failed/disabled/removed-account clearing and fallback rebinding. Only explicit sanitized session headers or `prompt_cache_key` participate; their API-key/user/group/model/endpoint-scoped HMAC is persisted, never raw prompts, identifiers, or credentials. Group/model changes select a distinct canonical Pool namespace and digest, so a mismatched binding cannot hit. Legacy content-derived fallback and sticky waiting are intentionally not retained. |
| Gemini OAuth preference over API key, forced platform fallback and OAuth model snapshots | Pending | Provider credential adapters are being migrated separately; API-key-only behavior must not be counted as OAuth coverage |
| Reusing context group / lite fetch / fallback-cycle resolution | Remove | Gin request-context and repository-fetch optimizations are process-specific. Worker performs one D1 route projection and has no equivalent mutable context cache |
| Mixed-scheduling feature flags tied to Go account types | Replace | D1 account capabilities plus Pool state replace Go type switches; exact mixed-provider preference coverage is still Pending |

## `pkg/apicompat` suite-level audit

| Go test suite | Decision | Notes |
|---|---|---|
| `chatcompletions_responses_test.go` | Retain + Pending | Core requests/responses/streaming retained. Legacy `functions[]`, built-in `x_search`, and every accumulator edge are not yet each represented by an independent Worker golden |
| `chatcompletions_responses_bridge_test.go` | Retain | Developer/system roles, formats, parallel tools and invalid history are represented in Worker protocol tests |
| `chatcompletions_responses_request_invariants_test.go` | Retain | Pairing behavior is represented; every original fixture sequence is not duplicated |
| `chatcompletions_responses_stream_lifecycle_test.go` | Retain | Balanced text/reasoning/tool lifecycle and idempotent terminal behavior are represented |
| `chatcompletions_responses_bridge_custom_tools_test.go` | Retain + Pending | Codex-native function/custom/tool-search call-ID family normalization is retained; custom/freeform, namespace and client `tool_search` lowering/restoration remains incomplete |
| `chatcompletions_responses_reasoning_cache_test.go` | Replace + Pending | Stateless wire reasoning is retained; cross-request reasoning cache must be a DO/KV design and is not complete |
| `chatcompletions_responses_tool_output_media_test.go` | Retain | `test/gateway/protocols/responses.test.ts` covers nested/JSON/data-URL images, ordered multimodal reinjection, duplicate call IDs and preservation of structured siblings |
| `chatcompletions_x_search_test.go` | Pending | `x_search` request projection exists in Chat→Responses, but full round-trip and billing are not proven |
| `responses_to_chatcompletions_tool_name_test.go` | Retain | First tool delta requires a name; subsequent empty names are not emitted |
| `responses_to_chatcompletions_codex_events_test.go` | Pending | Custom tool and Codex-specific reasoning event families are not complete |
| `responses_created_at_wire_test.go` | Retain | Stable timestamp and required presence represented |
| `responses_stream_event_wire_test.go` | Retain + Pending | Standard function/message/reasoning wire fields represented; `custom_tool_call` and object-valued `tool_search` arguments remain Pending |
| `responses_namespace_test.go` | Pending | Namespace collision detection and restoration are not implemented |
| `responses_client_tools*.go` | Pending | Client tool manifest/item-id restoration is not implemented |
| `service_tier_passthrough_test.go` | Retain | Standard Chat↔Responses buffered and streaming paths represented |
| `streaming_stop_reason_test.go` | Retain | Max tokens, content filter and completed terminal mapping represented |
| `chatcompletions_anthropic_bridge_test.go` | Retain + Pending | Text/function tools and streams retained; `test/gateway/protocols/anthropic.test.ts` covers base64 image-bearing tool results for Responses and Chat upstreams. URL/file media and remaining bridge variants are Pending |
| `chatcompletions_anthropic_reasoning_passback_test.go` | Pending | Signed Anthropic thinking round-trip cannot be claimed from plain Chat reasoning text |
| `anthropic_responses_test.go` | Retain + Pending | Core request/response/SSE/tools/errors retained; native image, cache-control and all output-config variants are not complete |
| `anthropic_to_responses_stream_test.go` | Pending | Worker currently implements Responses→Anthropic and Chat→Anthropic, not a native Anthropic→Responses event codec |
| `responses_to_anthropic_*_test.go` | Retain + Pending | Standard function pairing and termination retained; custom grammar/read-tool buffering/invalid block sanitation require more fixtures |
| `responses_anthropic_cache_creation_test.go` | Retain | Input/cache read/cache creation usage fields are represented by Anthropic codec tests |

## Broad `openai_*_test.go` disposition

| Original behavior family | Decision | Rationale/evidence |
|---|---|---|
| Request limits, lenient JSON normalization, compressed bodies and sanitized read errors | Retain | `test/gateway/handler.test.ts` |
| Authentication, public model rewriting, upstream credential replacement and error sanitation | Retain | `test/gateway/handler.test.ts` |
| Usage extraction, reservation, exact settlement, disconnect drain and recovery | Replace | Worker billing DO/Queue/recovery tests replace Go transaction/Redis mechanics |
| Retryable upstream status, credential failure and capacity exclusion | Replace | Pool Durable Object owns atomic leases and retry exclusion |
| Compact/input-token/Codex aliases and Codex manifest | Retain | Handler plus legacy route/Codex contracts |
| OAuth setup/refresh/PAT/account identity tests | Pending | Provider-native credentials are a separate migration slice |
| WebSocket v2/live/realtime tests | Pending | Requires Workers WebSocket Pair and/or Durable Objects |
| Images/video/audio/search/media intent tests | Pending | Requires Queue/R2 task lifecycle; not part of this text protocol slice |
| Profit veto/legacy diagnostics tied to Go services | Replace | Exact integer reservation/settlement replaces floating Go service hooks; commercial policy parity still needs its own ledger |
| Go HTTP client pool, proxy fallback, uTLS/JA3/TLS fingerprint and local transport tuning | Remove | Workers owns sockets/TLS; these controls cannot and must not be exposed |
| Process-local benchmarks, goroutine cancellation and local connection-pool tests | Remove | Cloudflare runtime behavior is verified with Worker stream/abort contracts and production observability instead |

## Remaining high-value protocol work

1. Complete output-before-commit inspection so a retryable HTTP-200
   `response.failed` can switch accounts only before any Chat bytes are exposed;
   failure code/message, deterministic no-cooldown, cyber zero billing and exact
   settlement are covered, while semantic failover and partial-output fixtures remain.
2. Complete custom/freeform tools, namespace tools, `tool_search` and object
   arguments in both directions.
3. Add native Anthropic→Responses SSE conversion (including signed thinking,
   images and cache-control accounting).
4. Add production-binding E2E for the remaining embeddings providers and error classes.
5. Add deployed Worker E2E for complex Claude tools and both cross-provider
   Claude↔Gemini paths.
6. Extend Worker-native session affinity only where a protocol has a stable,
   explicit conversation signal; do not restore prompt-content hashing or
   process-local sticky waiting.
