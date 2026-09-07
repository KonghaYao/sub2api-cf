# 用户生命周期审计

基线：`9e96351df`；工作区：`/tmp/sub2api-lifecycle-audit`。
本报告只记录此工作区的本地结果，未操作生产用户、密码或令牌，未独立部署。

## 发现并修复

| 场景 | 实际复现 | 根因 | 修复与回归 |
| --- | --- | --- | --- |
| 管理员停用用户，随后恢复 | `PUT /api/v1/admin/users/:id` disabled → active 后，旧 token 调用 `/auth/me` 返回 200，应要求重新登录 | 停用仅投影 status，旧 session 未撤销，auth_version 未推进 | 同一 D1 事务内推进 auth_version，并撤销 user_sessions/admin_sessions；按用户状态与 state_version 限定撤销，避免旧投影影响新状态。恢复后旧 access/refresh 均 401，新密码登录仍 200 |
| 管理员重置密码 | 重置后旧 admin recovery token 调用 `/admin/users` 仍 200 | password reset 只撤销 user_sessions，admin_sessions 不参与 auth_version 校验 | 密码修改同一 D1 事务内撤销该用户的 admin_sessions；HTTP 回归重置后返回 401 |
| UUID 用户切换期间旧请求刷新 | 用户 A 的刷新未完成，其他标签登录用户 B，旧刷新把 B 的 token 当作 A 的刷新结果 | tokenRefresh 将 UUID 转为 Number，两者都为 null，身份隔离判定失效 | 保留 UUID 字符串并兼容 Go 数值 ID；未知身份不接纳 peer token。新增 UUID 异步 localStorage 回归，从错误接纳 other-access 改为拒绝 |

进一步沿第 3 项追到完整 Axios/Pinia 调用链，补齐另外两个真实竞态：

- 原 DELETE 请求已由用户 A 发出，切到 B 后 A 的 401 才返回：修复前自动改用 B 的 token 重试并得到 `deleted: true`。现在请求在首次发送时记录身份，刷新前和再次发送前均校验；身份变化返回 `AUTH_SESSION_CHANGED`，不刷新、不发送第二次 DELETE。
- Pinia 的资料刷新接到上述身份变化 401 后原本会清空用户 B 的新登录。现在此特定错误保持新会话。回归红测从 `token = null` 改为保留 `next-user-token`。

## 全流程接口检查

新增 `worker/test/auth/lifecycle-sqlite.test.ts` 使用真实 createApp 路由、中间件、全部 D1 迁移、真实 SQLite SQL 和密码派生；仅外部 KV、限流 DO、用户状态 DO 为内存边界替身，不 mock SQL 或 handler。5 条流程断言：

| 生命周期 | 接口与断言 | 结果 |
| --- | --- | --- |
| 注册与重复身份 | POST `/auth/register`，首次 201、重复邮箱 409；生成 session 可 GET `/auth/me` | 通过 |
| 密码登录 | POST `/auth/login`，错误密码 401、正确密码 200 | 通过 |
| token 轮换 | POST `/auth/refresh` 后旧 access 401、新 access 200 | 通过 |
| 旧 refresh 重用 | 再次使用旧 refresh 返回 401，当前 family 的新 access 也失效 | 通过 |
| 退出 | POST `/auth/logout` 后原 access 401 | 通过 |
| 停用与恢复 | PUT `/admin/users/:id` 后旧会话不能因恢复而重新有效 | 修复后通过 |
| 管理员密码重置 | PUT `/admin/users/:id` 后旧 recovery 管理会话被撤销 | 修复后通过 |
| 自助修改密码 | PUT `/user/password`，当前浏览器保留、其他 session/access/refresh 失效；旧密码 401、新密码 200 | 通过 |
| 普通用户权限 | 普通用户 token GET `/admin/users` 返回 403 | 通过 |
| 删除用户 | DELETE `/admin/users/:id`，详情 404，旧 access、refresh、密码登录均 401 | 通过 |

既有回归额外覆盖：邮箱密码绑定、邮箱验证码、OAuth identity 绑定、Passkey/WebAuthn、TOTP、用户会话列表与指定/其他/全部会话撤销、用户创建/邮箱别名去重/准入设置/删除保留财务历史、个人资料与头像。

## 验证命令与边界

- 红测：`pnpm --dir worker exec vitest run test/auth/lifecycle-sqlite.test.ts` 最初 3 流程中 2 失败：两处真实 HTTP 返回 200 而要求 401。
- 红测：`pnpm --dir frontend exec vitest run src/api/__tests__/tokenRefresh.spec.ts` UUID 跨用户刷新错误 resolve `other-access`。
- 全用户域：`pnpm --dir worker exec vitest run test/auth test/user/profile.test.ts test/user/email-password-binding.test.ts test/control/admin-users-identity-sqlite.test.ts test/control/admin-users-delete-sqlite.test.ts test/control/admin-users-list-sqlite.test.ts test/control/users.test.ts`，最终 17 文件 165 项通过。
- 最新贯穿流程：`pnpm --dir worker exec vitest run test/auth/lifecycle-sqlite.test.ts`，5 项通过。
- 前端：`pnpm --dir frontend exec vitest run src/api/__tests__/client.spec.ts src/api/__tests__/tokenRefresh.spec.ts src/api/__tests__/auth.sessions.worker-contract.spec.ts src/stores/__tests__/auth.spec.ts`，4 文件合计 58 项通过（新增互审回归后 client/tokenRefresh/auth 三文件 56 项，auth.sessions 两项）；6 个修改的前端源文件/测试 ESLint 通过。
- Worker `tsc --noEmit` 通过。

这些结果不代表线上邮件供应商、OAuth 真实授权跳转或浏览器硬件 Passkey 已被实际操作。生产探针及部署由主代理统一执行。本地现有 auth 单测部分使用模块替身；新增贯穿式用例使用真实 SQLite，避免仅凭伪 SQL 测试宣称生命周期已通。

## 独立互审追加

- Keys 代理独立复现 `/auth/me` 旧 HTTP 200 在切换身份后覆盖新 `auth_user`；已在 `refreshUser` 写入 store/localStorage 前检查请求时身份、当前身份和返回用户 ID，避免污染后续请求的身份绑定。新增回归通过，同身份资料刷新仍正常。
- 同步 `admin-users.test.ts` 的旧 SQL 替身，保留状态更新、并发和幂等覆盖；该文件 16 项通过。
- 对 Keys 代理的修改只读复查：状态筛选优先级与 DTO 一致；创建保留精确过期时间，编辑未修改 expiry 时不重发过去值；gateway 逐次读 D1 检查新 group/权限。真实 SQLite 的 key lifecycle 1 项及 entitlement 3 项独立运行通过。
- 普通用户仪表盘时区发现另一个确定缺陷，已交主代理/billing：冻结 `now=2026-09-04T12Z`，消费在 `2026-09-03T18Z`（China 9/4 02:00），GET `/usage/dashboard/stats?timezone=Asia/Shanghai` 的今天费用实际 0，应 1.5。独立红测 `worker/test/user/lifecycle-dashboard-review.test.ts` 已留下，本分工未改 usage.ts。
