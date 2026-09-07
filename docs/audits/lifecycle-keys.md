# API Key 生命周期审计（2026-09-07）

基线：生产版本对应提交 `9e96351df`，隔离目录 `/tmp/sub2api-lifecycle-audit`。本域未操作生产数据、未读取生产密钥、未部署。主代理负责生产和完整浏览器链验证。

## 确認并修复的问题

| 用户场景 | 修复前根因与复现 | 修复 |
| --- | --- | --- |
| 选择“已过期”或“额度耗尽”筛选 | 前端公开四种状态，但 Worker `parseApiKeyListQuery` 只接受 active/inactive；实际路由 `GET /api/v1/keys?status=expired` 返回 400 | 接受全部四种状态，以禁用→到期→额度耗尽→可用优先级查询；分页数量和结果一致 |
| 选择“可用”筛选 | 原 SQL 仅检查 `enabled=1`，将已过期与额度耗尽 Key 也当成可用 | 查询条件与详情展示状态一致，排除到期与耗尽 |
| 创建 Key 时选择精确到期时间 | `KeysView` 对时间差 `Math.ceil(.../一天)`，例如上午创建、选当天傍晚到期，实际延长到次日上午 | Worker 创建适配增加精确时间选项；使用用户选择的毫秒时间戳，旧 Go 天数契约不变 |
| 已过期 Key 只改名称 | 编辑页仍提交旧的过期时间，Worker 按“新到期时间必须未来”拒绝；datetime-local 还会抹掉秒/毫秒 | 未修改到期输入时省略该字段；保留数据库原时间，允许改名称等，不会恢复 Key 可用性 |

## 同一 Key 的连续真实路由验证

新增 `worker/test/user/api-key-lifecycle-sqlite.test.ts`：真实 `createApp`、完整 SQLite migrations 和实际 `authenticateGatewayRequest`，不 mock Key handlers 或 gateway 鉴权。

1. Alice 创建一个 Key，拿到唯一一次 plaintext。
2. 用同 idempotency key 重放创建：数据库仍只有一个 Key，响应不再带 secret。
3. 用刚收到的 secret 鉴权成功；列表、详情不会泄露 plaintext。
4. 每一步检查四种状态筛选的 HTTP 状态、total、实际 ID，确保同一 Key 只属于当前展示状态。
5. Bob 对此 Key 的详情、更新、删除全部 404。
6. Alice 同时改分组与 IP 白名单：原 secret 下一次鉴权就看到新分组；不在白名单的 IP 403。
7. 旧 control version 更新 412。
8. 模拟已结算用量到限额，列表进入额度耗尽；通过真实重置接口恢复可用。
9. 设置未来到期，推进时钟到精确到期毫秒：显示过期，gateway 鉴权 401。
10. 到期后只更新名称成功，原到期秒/毫秒完整保留，gateway 仍拒绝。
11. 清除到期并停用：显示停用，gateway 401。
12. 重新启用：原 secret 鉴权成功。
13. 删除两次都成功，列表移除、原 secret 401，尝试再启用 409。

**真实红信号：** 首次运行上述测试失败：`filter expired while active: expected 400 to be 200`。修复后完整链通过。

创建到期时间的组件+API适配测试也先红：组件未传精确时间；适配请求缺 `expires_at_ms`。已过期改名测试先红：提交了 `2020-01-01T00:00:00.000Z`，修复后不再提交未变更的时间。

## 边界覆盖与限制

- 现有 SQLite Key 回归额外覆盖自定义 token、digest 冲突、归属、私有/订阅分组、并发 CAS、usage 重置 epoch、IP 校验和删除 tombstone。此次未修改这些原逻辑。
- 浏览器端创建返回 secret 后会合入原表行，原复制按钮可复制；普通刷新后不再提供 plaintext。原“成功弹窗”已在更早版本恢复原 UI 时移除，旧 E2E 等待弹窗属于过时断言，已告知主代理调整到实际表行流程。
- 本测试的额度消耗通过 SQLite 写入模拟已结算结果；不把这一项当成完整推理计费验证。实际推理、Durable Object 保留/结算、撤销与在途请求竞态由 billing 子代理和主代理验证。
- 本测试为本地真实路由/SQLite；不据此声称生产用户、真实上游与 Cloudflare 所有绑定均正常。

## 验证命令

```sh
pnpm --dir worker exec vitest run test/user/api-key-lifecycle-sqlite.test.ts test/user/api-keys.test.ts test/control/admin-api-keys.test.ts test/control/admin-api-keys-sqlite.test.ts test/control/api-key-last-used-ip-sqlite.test.ts
pnpm --dir frontend exec vitest run src/views/user/__tests__/KeysView.spec.ts src/api/__tests__/keys.worker-contract.spec.ts
pnpm --dir frontend run typecheck
```

预防：页面提供的状态选项必须通过真实 Worker 路由执行，并在同一 Key 状态演进后对照查询列表与 gateway 鉴权；只测单一创建 happy path 或 mock 前端 HTTP 无法发现这些跨阶段问题。
