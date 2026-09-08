# Worker 辅助运行设置实现

日期：2026-09-07。仅隔离工作树实现和本地测试，未读取生产凭据、发外部邮件、访问生产或部署。

## 原始缺口与已实现范围

原前端 `/admin/settings` 之外的 overload-cooldown、rate-limit-429-cooldown、panel-rate-limit、stream-timeout、rectifier、beta-policy 全部没有 Worker 路由/设置消费者。现在由 `control/runtime-settings.ts` 提供 exact 前端 GET/PUT 数据契约，独立 `0083_runtime_settings.sql` 保存，管理员权限、字段/范围验证和乐观并发更新。没有新增强制 If-Match 或 Idempotency-Key，避免旧页面保存再次报缺少版本；可选 If-Match 和数据库版本 CAS 会拒绝并发覆盖。

| 辅助端点 | 默认值及实际消费者 |
| --- | --- |
| overload-cooldown | enabled=true，10分钟；HTTP529失败的重试与最终失败均按设置向Pool发送冷却 |
| rate-limit-429-cooldown | enabled=true，5秒；优先使用合法Retry-After，没有时使用配置；禁用仅停用默认冷却 |
| panel-rate-limit | enabled=true，user240/heavy60/publicIP300 RPM，admin豁免；D1原子分钟窗口按用户ID、重查询及可信公网IP计数，拒绝429附Retry-After |
| stream-timeout | 默认禁用，temp_unsched/5分钟，10分钟内3次；真实流空闲/总时长超时写入幂等事件，达到阈值后临时Pool冷却或health unhealthy并禁用Pool；none/disabled不改变调度 |
| rectifier | 默认主开关、thinking签名/budget开，API Key签名关；Anthropic上游明确400错误后同账号单次修复重试，成功只结算一次；DeepSeek/Kimi/GLM透传签名契约不改 |
| beta-policy | 默认过滤fast-mode；context-1m仅Sonnet5匹配通过，其余过滤；真实Anthropic beta header按账号类型、模型通配与fallback执行pass/filter/block |

所有新设置都在后续请求读取D1，没有只保存字段而不消费的假实现。暂无额外外部资源配置；D1迁移必须在部署前应用。

## app.ts 集成（由主代理负责）

```ts
import { runtimeSettingNames, runtimeSettingHandlers } from './control/runtime-settings'
import { enforcePanelRateLimit } from './control/panel-rate-limit'
// 路由之前注册；保留现有 admin origin/step-up 安全中间件。
app.use('/api/v1/*', enforcePanelRateLimit)
for (const name of runtimeSettingNames) {
  const handlers = runtimeSettingHandlers(name)
  app.get(`/api/v1/admin/settings/${name}`, handlers.get)
  app.put(`/api/v1/admin/settings/${name}`, handlers.put)
}
```

主settings/frontend由用户代理拥有，邮件/admin-key由审计代理拥有，websearch和主网关策略由主代理另行协调。本模块未把它们列作已完成。

## 与Go行为的明确边界

- Go thinking budget整流可能提高max_tokens到64000；Worker在当前请求已有资金预约后不扩大用户输出授权，只在原max_tokens足够时把budget调整到min(32000,max_tokens-1)。无法在原授权范围内修复的请求仍返回真实上游错误。
- Panel限流用D1全局原子分钟计数实现，未依赖单个Worker内存计数。只对可信CF源IP的公网请求限公开接口，认证用户不因共享IP耦合；现有认证失败响应仍由原端点负责。
- stream-timeout `error`沿用Worker健康状态机制；后续健康探测仍可恢复该账号，并非不可恢复的永久禁用。
- Retry-After最高按2小时有界处理；不是对所有供应商私有配额重置header的完整实现。
- 所有上游400整流读取使用已存在的16KB/250ms脱敏诊断边界，不能读取无界错误体；只增加一次明确整流尝试。

## 验证

```sh
pnpm --dir worker exec vitest run test/control/runtime-settings.test.ts test/gateway/handler.test.ts
# 2文件138项通过
cd worker
pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/runtime-settings.e2e.ts
# 1项真实workerd/D1/DO通过
```

真实绑定证据：管理员通过PUT保存overload=2分钟，网关调用本地529上游，真实Pool cooldown剩余110-120秒；用户余额维持1000000 micros、reserved=0。并非仅检验数据库保存成功。

其他关键证据：

- beta过滤+签名400重试，实际转发header和第二次body符合策略，只产生1次结算和1次租约释放。
- 真实网关流停顿120秒，SQLite插入1条超时事件，配置7分钟冷却得到Pool cooldown_ms=420000，并且仅1次结算。
- Key/API账号限流、独立用户共享IP、公开IP限流、管理员豁免、关闭后立即允许均通过真实权限+SQLite路由。
- 超时事件按request_id去重、旧窗口事件过期、threshold/error/none动作均验证。

日志：`/tmp/runtime-settings-integrated.log`、`/tmp/runtime-settings-stream-route.log`、`/tmp/runtime-settings-bindings.log`。

当前全项目tsc剩余错误来自其他代理正在修改的auth测试KV类型断言；本模块无typecheck错误。主代理需在合并后完成全项目检查及真正app.ts挂载回归。

## Advanced Pool scheduling (local, 2026-09-07)

All ten exposed score weights now have an actual consumer: priority and configured concurrency/weight; one-hour deduplicated upstream success/error samples; first generated SSE token time (not a heartbeat/role frame); actual bounded per-account queue depth; provider-reported rate-limit remaining/reset windows; configured account acquisition billing multiplier normalized with the Go log-median formula; completed upstream Responses IDs scoped by user + API key + Pool/model; and session affinity. No provider quota is inferred from a customer balance. Missing provider headers or token samples retain neutral factors.

Advanced scheduling is opt-in and applies only to OpenAI/Codex inference. Disabled scheduling and other platforms retain existing account selection. Top-K selection is request-seeded and replay-stable. Queues are FIFO, capped at 128 per Pool / 32 per account, and expire after five seconds. Explicit cancellation tombstones address a measured workerd behavior: aborting a service-binding fetch alone does not promptly abort its DO handler. The explicit cancellation endpoint now removes a queued request within the one-second test deadline and cannot leave an active ghost lease. Cancellation records expire after one minute; telemetry deduplication matches the seven-day lease tombstone retention.

Completed JSON and Responses SSE IDs are bound for one hour. Another user or Key cannot resolve that binding. Stateful continuations stay on their original account; weighted migration requires supplied assistant context and complete tool-call coverage, then removes the upstream-specific previous-response ID. Advanced selection reauthenticates the current Key/user/group/IP policy after waiting and rejects changed financial configuration before sending upstream traffic.

Validation: 157 targeted unit tests; 18 real workerd/D1/DO/Queue lifecycle cases. The latter cover error-only/partial/cancelled streams and exact balances, persisted error/TTFT score selection, actual quota/reset windows, queue allocation/release/cancellation, completed SSE/JSON response affinity, cross-Key refusal without a debit, and disabling a Key during queue wait without an upstream call or charge. `tsc --noEmit` and diff whitespace checks pass. Logs: `/tmp/pool-scheduler-final-unit.log`, `/tmp/pool-scheduler-final-workerd.log`. These are local fixture results, not evidence of production deployment or external provider availability.

## Upstream billing probe (local, 2026-09-07)

The missing account billing-probe settings, opt-in, manual probe, batch probe and paginated rate-snapshot endpoints now have Worker consumers. The snapshot refresh reuses the actual account-list filters/pagination and returns ETag/304. Global settings validate a 5–1440 minute interval. Account-level probe and automatic-rate-sync flags remain separate, as in Go; scheduled maintenance runs only explicitly opted-in due accounts and defaults to one account per isolated Queue message.

The probe uses the account's decrypted API credential for the configured compatible upstream's GET `/v1/sub2api/billing`. Official provider domains are recorded unsupported without probing. Redirects are never followed. The whole request/read has a ten-second deadline and a 64-KiB body limit. The response parser requires the Sub2API schema, finite consistent token rates and a valid observation timestamp; peak configuration is validated against its timezone. Only declared billing fields are retained. Failed probes preserve previously received data with its existing freshness boundary; unsupported endpoints back off eight intervals, bounded by one day.

Automatic synchronization uses the declared resolved multiplier, rounded to four decimals, only when both account switches are still enabled and the value is at most 100. A larger declaration may be displayed but cannot change account cost. Snapshot/rate writes compare account control/config versions, credential identity and a bounded claim token. A concurrent account/credential edit wins; claims are then released without overwriting that edit. A database trigger and the normal account update route reject manual rate changes while automatic sync is active, covering batch SQL writes too.

Migration 0088 adds probe claim/due columns and the rate-write guard. Maximum manual batch size is 20, concurrency is four; the complete authenticated createApp/SQLite test verifies its D1 statement count remains at or below 50. Tests also cover invalid settings, real encrypted fixture credentials, sanitized responses, identity CAS races, oversized automatic rates, due/global-enable behavior, ten-second abort, nullable legacy metadata and credential-safe redirect refusal. The settings/account/migration regression run passed 45 tests; a real workerd/D1 test passed the full settings → opt-in → upstream GET → synchronized rate → maintenance Queue path with customer balance unchanged. Logs: `/tmp/upstream-billing-probe-final.log`, `/tmp/billing-probe-integrated.log`, `/tmp/upstream-billing-probe-workerd.log`. No production access or deployment was performed by this agent.

## Assigned account proxy transport (local verification)

Account `proxy_id` previously persisted in UI configuration while every upstream call used global fetch. Added a shared account fetch seam with fresh encrypted proxy lookup and fail-closed inactive/expired behavior, consumed by inference/rectification, saved and preview model discovery, admin health/model tests, scheduled health/synthetic probes, OAuth refresh, and compatible upstream billing probes. Creating/changing a binding validates the proxy; changing it resets account health for another real probe. Root separately owns proxy directory API and the recursive single-query fallback lookup.

Transport exchanges real HTTP CONNECT or authenticated SOCKS5 byte frames, upgrades the established socket using Workers `startTls(expectedServerHostname)`, then streams bounded HTTP/1.1 bodies (content length/chunked/EOF). Proxy credentials never enter target HTTP headers; upstream credentials are written only after target TLS. Header/idle deadlines, client cancellation, reader cancellation, frame limits, ambiguous framing, decompression size, and socket cleanup are explicit. HTTPS proxy nesting is rejected by directory validation; no unsupported proxy is silently ignored.

Evidence: 10 byte protocol tests pass in both Node and actual workerd stream runtimes. A createApp + migrated SQLite regression creates an AES-encrypted proxy, rejects a nonexistent account binding, saves a valid binding, receives Composer model catalog through CONNECT/TLS fixture, then deactivates the proxy and verifies the next same-account models request returns 503 without direct fetch. Existing focused gateway/account tests: 162 pass. Combined proxy + billing suites: 17 pass; typecheck passes. These are local protocol and API tests; they do not claim a production proxy or certificate endpoint was exercised.

Billing batch budget: a real SQLite 20-distinct-encrypted-proxy case executes 13 probes and returns seven explicit `pending:true,error:probe_deferred_query_budget` entries without reserving them, retaining fewer than 50 D1 statements. Unbound account batches still execute all 20. Scheduled probes naturally revisit pending due accounts. No pending item receives a success snapshot or account rate update.

## OpenAI fast/flex policy and billing

Implemented strict `gateway.openai_fast_policy_settings` rules matching Go semantics: trusted Key-owner user IDs (Worker strings), user-specific rules before global rules, first configured match within each group, account OAuth/API-key scope, canonical service tiers, exact/trailing-wildcard models, and fallback actions/messages. Actions pass/filter/block/force_priority affect the actual selected account request. Empty rules and omitted service tier preserve existing behavior. Unsupported Bedrock scope is rejected because this Worker has no Bedrock account implementation.

Reservation computes the greatest required charge across possible allowed candidate scopes after the policy changes their tier. Account selection re-evaluates the policy against the selected account. A concurrent account scope change yielding an unreserved tier returns a retryable configuration conflict rather than sending an underfunded request. The returned effective tier is passed through synchronous, streaming, and Responses bridge finalization, including account cost and customer usage calculations. Block returns 403 and releases admission, Pool lease, and financial reservation without billing.

Evidence: 136 focused unit/gateway tests pass. Four real workerd/D1/DO lifecycle regressions verify the provider fixture receives the policy-modified tier, filter settles 27 micros, forced-priority streaming settles 54 micros, block leaves zero debit, and 1,500-micro balance sufficient for the original flex estimate is rejected before dispatch when priority requires more. The same request ID connects wallet state, immutable ledger, Key quota usage, and usage projection; all outstanding reservations are zero afterward. TypeScript check passes. Production behavior has not been claimed by this local audit.

Root security helper integration also completed: settings normalize/validate through its dedicated helper; OpenAI/Codex dispatch calls Cyber precheck before admission/reservation with the original request body and trusted principal, and wraps actual upstream responses before semantic prelude handling. Root owns detection rules, migrations, and focused security tests.

## Provider forwarding identity, prompt, TTFT and version lifecycle

Implemented the supported provider fields through the gateway schema and frontend dynamic projection: Codex User-Agent/client version/manual override/automatic stable-version sync/read-only synchronized version; OpenAI TTFT `semantic` versus `visible`; Anthropic OAuth system prompt/JSON blocks, dateline normalization and fingerprint unification. Root mounted `runCodexVersionSync` as an isolated maintenance task. It claims a six-hour slot, calls only the official `openai/codex` GitHub release endpoints (latest, then a bounded 30-release fallback), excludes prerelease/other-component tags, bounds response bytes/time, and retries failures after 15 minutes. Its CAS JSON update preserves the manual override and increments the main control version to prevent concurrent form saves from overwriting background state.

Codex/OpenAI OAuth inference receives matching UA/originator/version; OAuth token refresh omits the inference-only version header. Anthropic OAuth/SetupToken uses Bearer authentication and OAuth beta. Its per-account fingerprint is created/updated through D1 CAS, rejects implausible client UAs, preserves existing header values when an upgrade omits them, and refreshes the same account identity. Saved account tests/model discovery/health/synthetic probes and OAuth refresh consume the same identity settings through the outbound seam. The account execution guard now permits Anthropic OAuth/SetupToken because the corresponding authenticated executor is implemented; it previously rejected all such accounts.

Prompt blocks support enabled flags, text templates and cache control; the default blocks and SHA-256 three-byte fingerprint computation are ported from the Go implementation. Dateline rewriting is limited to the system prompt and `<system-reminder>` regions, leaving ordinary user prose untouched. Original client instructions are retained in the Go-compatible message pair. The effective expanded body is prepared before reservation, and selected-account scope changes cannot silently dispatch a body whose cost was not reserved.

CCH is **not represented as implemented signing**: `backend/internal/service/domain_constants.go` explicitly calls `enable_cch_signing` deprecated/no-op because current CLI requests no longer carry it, and `gateway_billing_block.go` no longer adds that field. Root/frontend own the deprecated-control explanation. No production OAuth account, official GitHub request or real proxy was contacted by these tests.

A real native Codex non-streaming request exposed an additional lifecycle bug: Responses SSE was sent to the JSON parser. Fixed by sharing the bounded Responses accumulator and adding its authoritative native JSON projection, preserving output, usage, IDs, model rewrite and strict terminal validation. Existing Chat conversion continues to use the same accumulator. The buffering loop renews leases, obeys total/idle deadlines, cancels upstream readers, and the prelude now honors client abort. Missing/no-output failures have zero charge; reported partial usage is charged once. Cyber-policy refusal now has explicit zero-cost semantics for both native streaming and buffered non-streaming Responses.

Final evidence before freeze:
- 258 focused provider-settings, gateway and protocol unit tests pass; the preceding admin-account/proxy-focused run also passed 163 tests.
- 7 real workerd regressions pass: Anthropic OAuth settings/native messages and Codex **non-streaming** settings/native JSON (both settle 27 micros); native failed terminal with reported usage (17 micros exactly once); missing terminal (zero); cancellation in under one second (zero); and root's Cyber policy streaming/non-streaming refusals (both zero, session enforcement retained).
- Read-only synchronized version rejection, real SQLite fingerprint persistence/upgrade, release selection/claim CAS, manual override preservation and distinct TTFT clocks are covered locally. TypeScript passed after the native-buffer changes; root owns final whole-tree verification.

Remaining within this assigned field list: CCH is deprecated upstream rather than an unimplemented feature. Production credentials, live provider acceptance and release network access remain deployment verification boundaries, not locally asserted successes. No additional domain was started after the root freeze request.
