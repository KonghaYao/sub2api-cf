# 用户与 Key 推理计费生命周期检查

检查日期：2026-09-07。基线：9e96351df。工作区：`/tmp/sub2api-lifecycle-audit`。

## 已复现并修复的问题

### 1. 响应请求 ID 与账单、用量记录不一致

`app.ts` 为 HTTP 响应生成一个请求 ID，网关再次生成另一 UUID 给预约、账单及观测。真实 Worker 请求成功扣费 27 micros，但响应 `x-request-id` 无法查到对应 DO 请求/用量记录。

修复：网关四个入口通过 `requestIdFor(context.req.raw)` 使用同一请求身份。主代理同时将 request-id.ts 改为服务端随机 UUID，不把可重用的 cf-ray 当作财务幂等键。测试验证响应 ID = DO request_id = usage_projection.request_id，且只有一条负金额 ledger 记录。

### 2. 上游 HTML 200 被当成正常结果并进入收费

同步 JSON 解析失败原本退回按响应字节估算 token，HTML 维护页直接返回给客户 HTTP 200。真实 workerd 红测得到 `<html>upstream maintenance</html>` / 200，期待 502。

修复：JSON 解析失败返回 `502 invalid_upstream_response`，取消用户、Key 和平台额度预约；finally 释放账号租约及并发准入。测试验证余额保持 1,000,000 micros、reserved=0、Key quota_used=0、无 settlement_recovery 残留。

### 3. 仅含 error 的 Chat SSE 被 `[DONE]` 标记为成功并收费

真实上游夹具返回 `data: {"error":{"code":"resource_exhausted",...}}`，再返回 `[DONE]`。原实现只看 DONE，投影为 completed 并扣 328 micros。

修复：Chat SSE 保留顶层 error 失败状态，DONE 无法覆盖。没有实际内容/推理/tool 输出，且没有非零上游 usage 时，记录 failed、0 费用及 0 token。第一版修复验证还抓到费用为 0 但凭错误帧估算出 135 input / 93 output token；最终同时修复用量污染。

保留已生成内容的收费语义：正常流、部分输出后失败、客户端取消均按上游报告的 10 input / 5 output token 扣 27 micros，只有一次结算，释放所有预约。

## 验证矩阵

| 场景 | 本地真实运行时结果 |
| --- | --- |
| 成功同步请求 | HTTP 200，余额 1,000,000 → 999,973；Key 用量 +27；同一 ID 的 usage completed/27；单次 ledger 扣费 |
| 已成功调用后停用用户 / Key / 分组 | 下一次调用及 models 列表立即 401/403；没有第二次预约/扣费 |
| 余额不足 | 403 insufficient_funds；余额 1，reserved=0 |
| Key 总额度不足 | 429 api_key_quota_exceeded；用户余额不变，reserved=0，Key 用量为 0 |
| 可路由模型 / 禁用唯一账号 | models 原先显示模型，禁用账号后列表为空 |
| 不存在模型 | 404 model_not_found；Key 用量为 0 |
| 同步 HTTP 200 顶层 quota error | 429；余额、Key 用量不变；无预约泄漏 |
| 同步 HTTP 200 非 JSON | 修复后 502；不收费、不留预约 |
| 正常 Chat SSE | completed / 27；余额 999,973；单次扣费及零预约 |
| 输出后出现 SSE error | failed / 27；保留真实 usage 计费，单次结算 |
| 客户端取消流 | cancelled / 27；等待有界后台 drain 后单次结算及零预约 |
| 仅有 error + DONE | 修复后 failed / 0，输入输出 token 为 0，余额不变 |
| Responses 桥接及上游输出前故障转移 | 既有 3 项真实 D1/DO/Queue 回归通过，验证唯一结算和租约释放 |
| Queue 重投/财务事件重复投影 | 既有 Queue 与 SQLite 财务事件投影回归通过 |

## 命令与结果

新增 `worker/test/e2e/lifecycle-billing.e2e.ts` 包含 13 项，使用真实 workerd、迁移后的本地 D1、SQLite DO、Queue，并以固定本地上游夹具驱动。

```sh
cd /tmp/sub2api-lifecycle-audit/worker
pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/lifecycle-billing.e2e.ts test/e2e/core-bindings.e2e.ts test/e2e/chat-to-responses.e2e.ts
# 3 files, 18 tests passed
pnpm exec vitest run test/gateway/handler.test.ts test/gateway/usage.test.ts test/gateway/queue.test.ts test/gateway/entitlements-billing.test.ts test/gateway/api-key-limits-handler.test.ts test/gateway/user-financial-projection.test.ts
# 6 files, 171 tests passed
pnpm exec tsc --noEmit
# passed
```

红测证据：`/tmp/lifecycle-billing-red.log`；零费用但 token 污染补充红测：`/tmp/lifecycle-billing-final-red.log`；最终运行时绿测：`/tmp/lifecycle-billing-final-green.log`；其他回归：`/tmp/lifecycle-billing-regression.log`。

## 验证边界与剩余风险

- 本代理未读取生产凭据、未调用生产 API、未部署、未提交；生产部署与线上验证由主代理负责。不能据本地夹具声称实际 Composer 账号额度或密钥已验证。
- 停用测试在首次成功后直接修改本地 D1 控制状态，验证网关重新鉴权、不复用缓存；管理 API 控制变更与并发版本由其他代理负责。
- cancellation 用例在 workerd 内调用实际 `createApp().fetch` 并使用 `createExecutionContext`/`waitOnExecutionContext`，保留真实 D1/DO/Queue。`exports.default.fetch` 的 service-binding 响应代理不将测试 reader.cancel 传回源，不能用该代理证明真实 HTTP 断连传播；实际网络断连仍应独立上线验证。
- 这里没有注入 D1/DO 暂时故障、长时间进程终止、跨区域网络故障；预约 alarm、恢复队列的极端故障恢复不由以上矩阵证明。
- 非 JSON 拒绝针对已复现模式，不表示任意 provider JSON schema 已被完整校验。

防止同类回归：保持从同一 HTTP 请求、响应请求 ID 到 DO 预约/ledger、Key 额度及异步用量投影的整条断言；仅验证单个 handler 返回 200 无法覆盖这些问题。

## 追加：普通用户时区与跨午夜一致性

普通用户统计、Key 批量今日费用、日期过滤、日趋势和单 Key 每日用量原先忽略 timezone，统一以 UTC 午夜切割。红测固定现在为 `2026-09-04T12:00Z`，消费在 `2026-09-03T18:00Z`（上海 9 月 4 日凌晨 2 点），上海今日实际费用错误地显示 0 而不是 1.5。

修复 `user/usage.ts` 以查询 timezone 计算本地日历边界，复用 `gateway/info.ts` 的 `parseTimezone`、`parseDate`、`localDate`、`zonedDayStart`、`addCalendarDays`、`calendarDayBoundaries`。info.ts 仅增加 localDate 导出，没有改变已有管理台统计。默认未传 timezone 仍是 UTC。

日期范围及按日分桶逐日计算日历边界，避免 DST 23/25 小时日按固定 24 小时误分。返回 start_date/end_date 保留用户选择的本地日期，日趋势日期用本地日期。小时桶保留真实 UTC instant 的分钟，不再把 Kathmandu 等四分之一小时时区的 `23:15Z` 截成 `23:00Z`。无效时区及 2 月 30 日等无效日期返回 400。

新增/扩展 `test/user/lifecycle-dashboard-review.test.ts` 共 11 项真实 createApp + SQLite 测试：

- 上海跨 UTC 午夜的仪表盘今日费用、usage stats、列表、趋势、快照、Key 每日用量、Key 批量费用一致。
- 批量 Key 费用不暴露其他用户的 Key。
- 纽约夏令时切换 23 小时日的最后一分钟纳入，当地下一天午夜准确排除。
- Kathmandu 小时桶的真实分钟保留。
- 无效时区和无效日历日期拒绝。

前端 GET 已由拦截器加 timezone；POST `/usage/dashboard/api-keys-usage` 原先没有，已通知主代理补 query params timezone。后端不依赖额外 body 字段。

## 追加：流错误之后的最终 usage

复核还发现，若在 error 帧立即终结，随后独立 chunk 附带的真实 usage 会被丢弃。新增 workerd 用例以独立 chunks 返回 `content → error → usage(10/5) → DONE`，红测得到余额 999,600（估算扣400），期望余额999,973（扣27）。

修复为保留失败标记，等待 DONE 或 EOF 再终结；错误不能被 DONE 改回成功，同时不丢后续真实 usage。正常取消和超时仍走既有有界处理。该修复没有重新引入此前取消部署的 Composer token-limit 补丁。

最终验证：

```sh
pnpm exec vitest run test/user/lifecycle-dashboard-review.test.ts test/user/usage.test.ts test/gateway/info.test.ts test/gateway/handler.test.ts test/gateway/usage.test.ts
# 5 files, 166 tests passed
pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/lifecycle-billing.e2e.ts test/e2e/core-bindings.e2e.ts test/e2e/chat-to-responses.e2e.ts
# 3 files, 19 tests passed（新生命周期测试增至14项）
pnpm exec tsc --noEmit
# passed
```

红测日志：`/tmp/lifecycle-dashboard-red.log`、`/tmp/lifecycle-dashboard-hour-red.log`、`/tmp/lifecycle-billing-late-usage-red.log`。绿测日志：`/tmp/lifecycle-dashboard-final-green.log`、`/tmp/lifecycle-billing-final-green.log`。
