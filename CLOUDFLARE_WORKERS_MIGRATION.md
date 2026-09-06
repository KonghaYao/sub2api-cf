# 纯 Cloudflare Workers 迁移计划

## 1. 目标与边界

本项目最终运行形态为纯 Cloudflare Workers 生态：生产环境不再依赖 Go 进程、Cloudflare Containers、PostgreSQL、Redis、Caddy、systemd、Docker Compose 或本地持久目录。迁移期间旧 Go 服务仅作为 API 契约、业务规则和数据转换的参照；完成切流、对账和观察期后删除。

允许为了 Workers 的运行时边界简化功能，但不能用隐藏的常驻服务器、外部 Redis/PostgreSQL 或 Container 保留兼容债务。

### 当前架构事实

- 后端是 Go 单体，HTTP API、上游网关、计费、账号调度和后台任务耦合在同一运行时。
- PostgreSQL/Ent 保存关系数据和账务数据，现有迁移只用于理解最终 schema，不直接翻译为 D1 的全部历史迁移。
- Redis 同时承担缓存、限流、并发槽、锁、临时状态和队列等不同语义，迁移时必须按语义拆分，不能整体替换为 KV。
- Vue 3/Vite 前端可以保留，但静态资源改由 Workers Static Assets 托管，不再嵌入 Go 二进制。
- 当前部署还包含 Caddy、systemd、Compose、本地目录、主机备份和监控；这些能力不进入目标架构。
- Go 传输层包含 Workers `fetch` 无法等价提供的连接控制和本机能力，相关功能必须删除或降级。

### 迁移原则

1. **Cloudflare 原生优先**：只使用 Workers 可直接绑定的服务和标准 HTTP/SSE/WebSocket 能力。
2. **一个状态只有一个真相源**：财务与租约不双写；迁移期间按用户或流量批次切换写入所有权。
3. **强一致与查询分离**：Durable Objects 承担串行状态机，D1 承担控制数据和查询读模型。
4. **异步链路必须幂等**：Queue 至少一次投递，所有消费者以 `event_id` 去重。
5. **大对象不进 D1**：图片、导出、历史明细和审计原文写入 R2。
6. **热路径不依赖 KV 新鲜度**：KV 只做只读缓存；鉴权撤销、余额、限流和租约必须再次由 DO/D1 校验。
7. **先冻结契约，再垂直迁移**：每一阶段交付可运行的端到端切片，不做长期半成品基础层。
8. **删除胜于伪兼容**：不能在 Workers 中可靠实现的能力明确下线，不引入行为不稳定的模拟层。

## 2. 明确删除或降级的能力

以下能力不进入新实现：

- 删除 uTLS、JA3/JA4、浏览器 TLS 指纹伪装和自定义 TLS ClientHello。
- 删除 SOCKS5、HTTP CONNECT、账号级代理和任意 TCP 拨号。
- 删除自定义 H1/H2 连接池、连接复用策略和底层 socket 参数控制。
- 删除 Go 二进制插件、`go-plugin`/gRPC 子进程、Unix Socket 和运行时加载可执行文件。
- 删除仅 macOS/Apple Silicon/ChatGPT.app 可用的 live attestation。
- 删除 Caddy、systemd、Compose、本地日志/插件/备份目录、在线二进制升级和主机 CPU/内存/cgroup 监控。
- 删除任意 SMTP 直连；邮件改用 Cloudflare Email Service binding，或具备幂等键和超时边界的内部邮件 Worker；未配置时关闭邮件发送型功能。

对应降级方案：

- 上游接入只支持 Workers `fetch` 能访问的标准 HTTPS、SSE 和 WebSocket。
- 插件改为构建期 TypeScript 模块或声明式 JSON 请求/响应转换规则，不允许上传并执行代码。
- 验证码统一采用 Turnstile；不能迁移的供应商 SDK 暂时下线。
- 管理端实时指标可先降级为 3～5 秒轮询，后续确有需要再使用 DO WebSocket Hibernation。
- PostgreSQL 的 trigram、复杂全文检索和任意 SQL 报表降级为精确/前缀搜索、游标分页和预聚合报表。
- 备份改为 D1 导出、R2 版本化对象和配置即代码；监控改为 Workers Logs、Analytics Engine 与外部告警 webhook。

## 3. 目标技术栈与运行结构

| 领域 | 目标实现 |
| --- | --- |
| 语言与运行时 | TypeScript、Cloudflare Workers |
| HTTP API | Hono；统一中间件、错误模型和 OpenAPI 契约 |
| 前端 | Vue 3/Vite、Workers Static Assets |
| 流式网关 | 原生 `fetch`、`ReadableStream`、`TransformStream`、SSE |
| WebSocket | `WebSocketPair`；需要连接状态时使用 DO Hibernation |
| 强一致状态 | SQLite-backed Durable Objects |
| 关系数据 | D1；Drizzle 管理新 baseline，热路径使用参数化 SQL |
| 配置与边缘缓存 | KV、Cache API |
| 对象与历史数据 | R2 |
| 异步事件 | Cloudflare Queues |
| 长流程 | Workflows |
| 定时任务 | Cron Triggers、DO Alarms |
| 聚合指标 | Analytics Engine；财务报表仍来自可核对的 ledger/投影 |
| 安全 | WAF、Turnstile、Web Crypto、Workers Secrets |
| 构建部署 | pnpm、Vitest、Wrangler、Workers Builds/CI |

建议新代码集中在 `worker/`，共享的 HTTP DTO、错误码和 schema 位于 `worker/src/contracts/`，避免继续从 Go 生成运行时代码。

## 4. 存储真相源

### 4.1 `UserStateDO`：财务、预占与幂等

以 `user_id` 命名实例，保存余额、冻结/预占、额度窗口、并发/RPM 状态、不可变账务 ledger 和幂等键。核心命令固定为：

- `authorize`：验证 API Key 版本、额度和并发，创建带 TTL 的预占。
- `settle`：按 `request_id` 幂等结算实际费用，释放剩余预占。
- `release`：失败或取消时幂等释放预占。
- `reap`：由 DO Alarm 回收超时预占并生成审计事件。

同一命令的状态变更和 ledger 记录必须在一次 DO storage transaction 内完成。D1 中的余额和账单列表只是异步读模型，不能反向覆盖 DO。金额统一用最小计价单位整数表示，禁止浮点累计。

### 4.2 `PoolStateDO`：调度、租约与健康状态

以 `group:platform:shard` 命名实例，保存候选账号快照、并发租约、sticky session、退避截止时间、短期健康状态和 token 刷新互斥。租约必须有 TTL，并由 Alarm 清理。热点池按稳定哈希扩展 shard；请求选定 shard 后不可在重试中随机漂移。

### 4.3 D1：控制数据与读模型

D1 保存用户资料、API Key 元数据、账号密文、分组、渠道、价格、订阅方案、OAuth 身份、支付订单、管理审计元数据、余额/ledger 查询投影及小时/每日汇总。

- 新建一个可重放的 SQLite baseline，不搬运全部 PostgreSQL 历史 migration。
- 高频列表使用 `(created_at, id)` 游标分页，避免大 `OFFSET`。
- 高频过滤字段从 JSON 拆成普通列并建立最小复合索引。
- 时间统一为 UTC epoch milliseconds；ID 使用可安全在 JavaScript 传递的字符串。
- 账号凭据使用 Workers Secret 中的主密钥经 Web Crypto 封装后再写 D1，禁止明文落库或进入日志。

### 4.4 R2：历史明细与大对象

R2 保存图片/批量任务产物、导出文件、加密审计原文、按日期分区并压缩的 usage 明细、长期操作日志和迁移快照。D1 只保存 object key、digest、大小、类型、保留期限和查询所需的少量索引。

### 4.5 KV：只读配置缓存

KV 保存 API Key hash 到内部 ID 的加速映射、版本化模型价格、公共设置、功能开关和 dashboard snapshot。每个值携带 `version`；更新先提交真相源，再写 KV。KV 不保存余额、一次性消费状态、限流、并发槽、租约或财务幂等记录。

### 4.6 Queues、Workflows 与 Analytics Engine

- Queue 消息统一包含 `event_id`、`event_type`、`occurred_at_ms`、`schema_version`、`aggregate_type` 和 `aggregate_id`。
- 每个消费者维护 inbox/去重记录；处理完成前不得确认消息。
- Workflows 只承载支付补偿、批量导出、数据归档等多步长流程，不进入普通网关请求热路径。
- Analytics Engine 只保存流量、延迟、错误率和 token 趋势等非财务指标；任何金额必须能从 ledger 重算。

## 5. 分阶段施工

所有阶段都遵守目录所有权：同一阶段之外不得顺手修改其他目录；进入下一阶段前先通过本阶段门槛。

### 阶段 0：冻结事实与契约

**文件边界**：`CLOUDFLARE_WORKERS_MIGRATION.md`、新增 `worker/docs/`；旧 `backend/`、`frontend/` 只读。

**工作**：盘点路由、鉴权、上游协议、最终 PostgreSQL schema、Redis key/TTL、定时任务和前端依赖；记录明确删除项；保存代表性请求、SSE 事件流、错误响应和计费样例作为 golden fixtures。

**验收门槛**：所有前端调用均能映射到“迁移、降级或删除”；核心供应商各有成功、限流、超时、流式中断样例；余额计算样例可重复验证。

**回滚**：纯文档和测试夹具，无生产变更。

### 阶段 1：Workers 工程基座

**文件边界**：新增 `worker/package.json`、`worker/tsconfig.json`、`worker/wrangler.jsonc`、`worker/src/index.ts`、`worker/src/env.ts`、`worker/src/contracts/`、`worker/test/`；不改业务代码。

**工作**：建立 Hono 路由、环境 bindings、统一错误/请求 ID/CORS/安全头、单元测试、local/staging/prod 配置和空的 Static Assets fallback。禁止业务代码读取 `process.env` 或 Node 专用 API。

**验收门槛**：类型检查、测试和 `wrangler deploy --dry-run` 通过；健康检查、404、错误响应和静态资源路由可验证；不同环境没有共享数据库或 secret。

**回滚**：删除/禁用新 Worker 路由即可，旧系统不受影响。

### 阶段 2：存储基础与状态机

**文件边界**：`worker/migrations/`、`worker/src/storage/`、`worker/src/durable-objects/`、`worker/src/queues/` 及其测试。

**工作**：建立 D1 baseline；实现 `UserStateDO`、`PoolStateDO`、会话/一次性状态 DO；实现 R2 对象命名与校验、KV 版本缓存、Queue envelope 和 inbox 去重。优先完成 reserve/settle/release、租约过期和 alarm 恢复测试。

**验收门槛**：并发与故障注入下不超扣、不重复结算、不泄漏租约；重复/乱序 Queue 消息结果一致；D1 可从空库完整迁移；R2 对象可校验 digest 并按策略清理。

**回滚**：bindings 保持 staging 隔离；未取得写入所有权前只接受测试数据，可整体清空 staging namespace。

### 阶段 3：AI 网关垂直切片

**文件边界**：`worker/src/gateway/`、`worker/src/providers/`、`worker/src/routes/gateway/`、对应 fixtures/tests；旧 Go 只作对照。

**工作**：先迁移业务量最大的标准 HTTPS/SSE 供应商；实现请求规范化、流式透传、客户端取消、超时、错误映射、usage 提取、DO 预占/结算和账号租约。明确拒绝代理、uTLS 和二进制插件配置。

**验收门槛**：golden contract 一致；SSE 首包、事件边界、取消和断流不会缓存完整响应；任何结束路径都结算或释放；负载测试满足既定延迟、CPU 和内存预算。

**回滚**：按路由/用户 cohort 将流量切回旧 Go；未切换写入所有权的用户不允许写新财务状态。

### 阶段 4：控制面 API

**文件边界**：`worker/src/routes/auth/`、`user/`、`admin/`、`billing/`、`settings/`、`worker/src/services/` 及测试。

**工作**：迁移登录、用户/API Key、分组/账号、价格、订阅、订单、设置和管理接口；邮件只接 Cloudflare Email Service 或内部 Worker binding；验证码使用 Turnstile；大文件改为 R2 签名/受控直传。

**验收门槛**：前端使用的接口完成契约测试；权限矩阵、撤销延迟、OAuth state 一次性消费、支付 webhook 签名与重放、凭据加密全部通过安全测试。

**回滚**：控制面按功能开关切回；写接口切换前后均执行单写者检查，禁止新旧系统同时修改同一实体。

### 阶段 5：后台任务与可观测性

**文件边界**：`worker/src/scheduled/`、`worker/src/workflows/`、`worker/src/analytics/`、`worker/src/queues/consumers/`、Wrangler triggers 配置。

**工作**：把 goroutine/Redis queue/cron 改为 Queue consumers、Cron、DO Alarms 和 Workflows；实现 usage 投影、R2 归档、支付补偿、缓存失效、数据保留、告警 webhook 和敏感字段脱敏。

**验收门槛**：重复触发、延迟投递、部分失败和重试不产生副作用；死信可人工重放；财务汇总与 ledger 重算一致；日志不包含 token、密码、完整 prompt 或账号密文。

**回滚**：暂停对应 trigger/consumer；保留未确认消息，修复后重放，不删除 ledger 和原始归档。

### 阶段 6：前端与静态资源

**文件边界**：`frontend/`、Worker Static Assets 配置、必要的 `worker/src/routes/`；不再修改旧 Go 模板/嵌入逻辑。

**工作**：将前端 API 基址、认证刷新、上传、流式请求和错误提示接到 Worker；隐藏已删除能力的入口；由 Static Assets 提供 SPA fallback 和缓存策略。

**验收门槛**：登录、创建 Key、配置账号、发起流式请求、查看账单和管理操作的端到端测试通过；删除项不再出现在 UI；版本化资源可长缓存，HTML 不被错误长期缓存。

**回滚**：回退静态资源版本和 API route；数据写入所有权仍由 cohort 开关独立控制。

### 阶段 7：数据迁移与灰度切流

**文件边界**：新增 `worker/tools/migration/`、`worker/docs/runbooks/`；旧 `backend/` 和 `deploy/` 仍只读，不在本阶段删除。

**工作**：从旧库导出一致快照，转换并导入 D1/R2/DO；建立迁移 ownership 表。按内部账号、1%、5%、25%、50%、100% 用户 cohort 切换。每个用户任一时刻只能由旧 Go 或 Worker 写账务；切换时短暂冻结该 cohort，导入最终增量后再开放。

**验收门槛**：行数、主键、余额、订单、账号配置、ledger 和抽样 API 输出核对通过；至少经历一个完整结算周期；错误率、P95、结算差异和 DO alarm 积压均低于预设阈值。

**回滚**：冻结问题 cohort；导出 Worker 侧最终 DO snapshot/ledger 增量并回放到旧 PostgreSQL；对账通过后将 ownership 和路由切回。不得直接把路由指回陈旧旧库。

### 阶段 8：退役旧栈

**文件边界**：删除 `backend/`、旧部署脚本和不再使用的根配置；更新 `README*`、CI、开发文档和许可证清单。具体删除清单必须在执行前单独评审。

**工作**：100% 流量稳定通过观察期后，将旧 PostgreSQL/Redis 设为只读并生成最终归档；验证恢复演练；删除 Go、Ent、旧 migrations、Caddy/systemd/Compose、主机备份与监控文档；清理旧域名、secret 和 CI job。

**验收门槛**：全新环境仅凭仓库、Wrangler 配置和受控 secrets 即可部署；生产无旧服务连接；R2/D1 恢复演练通过；依赖和 secret 扫描不存在旧栈残留。

**回滚**：退役前保留有期限、加密且访问受控的最终快照。删除旧运行时是最后一步；执行后只通过数据恢复与重新部署回退，不承诺瞬时切回。

## 6. 阶段通用质量门槛

- `lint`、类型检查、单元测试、集成测试和 Worker dry-run 必须全绿。
- API contract fixtures 必须覆盖成功、鉴权失败、429、上游 5xx、超时、取消和流式中断。
- 所有财务命令有幂等、并发、重复投递、alarm 恢复和整数边界测试。
- 每个 D1 查询有明确索引或数据量上限；禁止在请求热路径全表扫描历史 usage。
- 请求体和响应流不得无界缓冲；图片和大文件走 R2 直传/流式处理。
- 每个 binding 有开发、预发布、生产隔离；secret 只经绑定注入，不写入仓库。
- 每次灰度前记录可量化的 SLO、停止条件、数据核对脚本和负责人。

## 7. 首轮施工清单

首轮只完成低风险、可并行的基础工作：

1. 创建 `worker/` 工程和 Wrangler 多环境骨架。
2. 抽取 API DTO、错误码与 golden fixtures。
3. 创建 D1 baseline 和最小 repository 层。
4. 实现 `UserStateDO` 的 reserve/settle/release 原型及并发测试。
5. 实现 `PoolStateDO` 的 acquire/release/expire 原型及 alarm 测试。
6. 选择一个标准 HTTPS/SSE 上游完成端到端垂直切片。
7. 接入 Vue Static Assets，但暂不改变生产路由。

首轮结束的定义不是“目录已经创建”，而是：本地可启动 Worker，一条真实形状的流式请求能经过鉴权、预占、账号租约、上游透传、结算和查询投影，并在重复/失败测试中保持账务一致。

## 8. 本次施工进度（2026-09-03）

本次完成的是首轮施工和阶段 3 的标准 OpenAI-compatible 核心切片，不代表旧系统全量接口已经迁移：

- 已完成 Workers/Hono/Wrangler 工程基座、健康与就绪探针、API 404 边界和 Static Assets fallback。
- 已创建并绑定 production D1、KV、R2、Queue 与 Durable Objects；development/staging 仍保留占位配置。
- 已完成 D1 最小 baseline，并验证可从空库迁移。
- 已完成 `UserStateDO` 原型：整数账务、不可变 ledger、幂等余额变更、预占/续租/结算/释放和 Alarm 回收。
- 已完成 `PoolStateDO`：账号容量、幂等租约/续租、失败冷却、tombstone 和 Alarm 回收。
- 账号池按分组、模型与端点隔离，取用密钥前再次校验账号能力，避免并发请求串用不兼容账号。
- 已完成 Vue 的 Cloudflare Static Assets 独立构建输出，旧 Go embed 构建仍可使用。
- 已完成 HMAC API Key 鉴权、AES-GCM 上游凭据、分组模型目录、整数价格、余额预占和账号租约。
- 已完成 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 的标准 HTTPS/JSON/SSE 透传；流式事件增量解析，不缓存完整响应。
- 已完成 User DO 财务 outbox 与 Queue/D1 幂等 usage 投影，所有正常、错误和取消路径均结算或释放。
- 已完成结算恢复表、Queue 重试、生产 DLQ 和每分钟 Cron 补偿，瞬时 DO 故障不会静默漏账。
- 已明确拒绝客户端代理、自定义上游、SOCKS、uTLS、JA3 和任意 transport 配置。

下一批优先完成控制面 CRUD、真实 Workers 测试池的 D1/DO/Queue 故障注入、更多 provider 协议转换与前端切换。旧 Go、PostgreSQL 与 Redis 在完整灰度切流前不会删除。
