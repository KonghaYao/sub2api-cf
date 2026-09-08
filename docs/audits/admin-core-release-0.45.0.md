# Worker 0.45.0：原始管理员核心流程整合

本阶段整合线上 0.44.0 用户、设置、风控、调度实现与原始管理员账号核心迁移。保留已部署 D1 迁移及代理数字 ID、密文 AAD 和引用关系，将新迁移追加为 0098–0115。

## 业务结果

- 原始账号创建、编辑、分组、调度开关、模型映射、OAuth 刷新、连接诊断、供应商用量、定时测试、Codex 导入及网关调用按原接口工作。OAuth 默认诊断优先选择 Codex/GPT-5 文本模型。
- 代理原始批量导入、重复身份跳过、重复显示名称、管理员密码回读和复制能力恢复；密文存储与匿名访问拒绝保留。并发导入及幂等重放的 created/skipped 结果稳定，引用中的代理不能删除。
- 计费探测共享一个配置与租约实现。能力观测不会误判身份变化；不改变倍率的计费观测保持编辑版本，真实倍率变化同步更新配置与编辑版本。
- 账号操作菜单恢复原始刷新入口；短视口允许滚动访问全部操作。

## 验证证据

Worker 全量回归 279 文件、2937 项通过；最后计费版本变更另有 18 项专项及类型检查通过。真实 workerd 最终全量 29 文件、76 项通过。前端最终全量回归 331 文件、2261 项全部通过；原界面与诊断专项 13 项通过。历史菜单滚动改进通过明确归一保留原始界面哈希保护。前端生产构建通过。真实浏览器原始账号核心全链路 1 项通过（15.5 秒），代理两项此前通过。

数据库升级专项覆盖从线上代理结构升级至 0115，保留密文、已有幂等回执、引用和外键约束。发布前确认线上仍为 0.44.0/version 2d368b2e-ef30-4a75-a510-d58074495a73。

## 仍未完成，不能视为全目标验收

管理员全页面巡检保留失败：插件 GET /admin/plugins，以及 Prompt Audit config/runtime/events 缺少 Worker 实现。必须按原始业务补齐，不能以空数组或默认成功掩盖。原始 Prompt Audit 参考位于 backend/internal/securityaudit。

HTTPS 代理传输仍明确失败，不能把可保存配置误报为可执行；原生插件执行、完整备份恢复、部分 Grok/Antigravity 授权与刷新仍需继续迁移。浏览器日志有一次 gateway cleanup TypeError，虽然端到端断言通过，仍需定位具体清理分支。AgentIdentity 的更广泛原生/媒体恢复测试仍待完成。

## 已部署与线上验证

代码提交 `dd7c6f960`，0.45.0 已部署，Worker version `28347bb6-cb33-49ca-a3f4-80ed12633821`。首次迁移后段遇到 Cloudflare 10000 认证错误，正式流程重试后恢复，迁移 0115 登记并成功发布。未使用绕过迁移检查的发布命令。

线上公开检查 4 项通过：健康版本 0.45.0、公开设置 200、管理员账号及代理匿名访问均 401。原临时管理员会话文件已被清理，线上管理 API 的认证后冒烟脚本在加载会话时停止，尚未创建测试账号或写入业务数据；不能把此项写成通过。需要有效管理会话继续线上验收。


## 0.45.1：上游重试清理修复

已复现清理 TypeError：错误诊断读取器接管并取消响应后，重试分支再次通过 Response.body.cancel 取消仍被锁定的流。诊断函数现在取消后释放读取器锁，重试调用方不重复取消。取消不等待上游完成，避免故障连接拖住重试。

网关专项 158 项、真实 workerd 76 项、类型检查通过；真实浏览器原始账号核心链路通过（15.8 秒），日志中不再出现 gateway cleanup failed。新增正常结束、超限、超时、读取错误四种诊断所有权释放测试。代码提交 `560e8e2c8`，已部署 0.45.1，Worker version `c6e16c43-3214-4def-a63a-5b6223311d0a`。

## 0.45.2：代理取消不等待故障上游

用户将 LLM 转发兼容性、稳定性与可靠性设为最高优先级，Prompt Audit 暂停。代理 HTTP 清理不再串行等待 socket.close 和 reader.cancel；立即发起清理并释放读取锁，避免不完成的上游关闭承诺阻塞下游取消。增加永不完成关闭/取消的故障注入测试。代理专项 21 项、真实 workerd 29 文件/76 项、类型检查通过。提交 `14f3dc62c` 已部署，Worker version `ff1babf3-6116-4cfc-b9d0-78d6609c3ef3`，线上 /health 已确认 0.45.2。

## 0.45.3：Responses 转 Chat 工具参数完成事件

修复已收到工具 added 事件但参数只在 done/terminal 中返回时，Chat 流遗漏完整参数的问题。arguments.done、custom input.done、output_item.done、终态输出补齐尚未发送的后缀，并按 call_id 保持并行工具身份与索引。省略 output_index 的兼容事件可按 call_id 恢复，不能安全关联时留给完整 item 事件；不重复发出参数。已输出前缀与完成参数不一致时显式失败，避免客户端执行损坏参数。

协议与网关最终专项 169 项、真实 workerd 76 项通过，类型检查通过。覆盖中文参数、后缀补齐、重复完成事件、自定义工具、索引缺失、交错并行工具及压缩终态输出。提交 `f0dd8ac54` 已部署 0.45.3，Worker version `131aeb31-549b-4472-bf26-29c73941dd6f`。

## 0.45.4：保留上游拒绝响应

Responses 转 Chat 及原生非流式 SSE 汇聚此前忽略 refusal 内容。现在保留 message.refusal、delta.refusal，处理 refusal delta/done、content_part.done、output_item.done 和终态完整输出；按内容片段补齐缺失后缀而不重复已发送内容。合法拒绝被视为实际输出，不被误判为空结果；保持正常 finish_reason 和实际用量。

协议与网关 175 项、原生全量 76 项通过；新增原生拒绝链路连同失败/取消专项 4 项通过，确认 delta-only 拒绝返回完整、实际费用只扣一次、预留释放。类型检查通过。提交 `55469f79a` 已部署 0.45.4，Worker version `da72d8ba-6825-463b-aa14-80101b68272f`。

## 0.45.5：文本及推理完成事件补齐

按 output/content/summary 片段追踪文本和推理前缀，处理 text.done、content_part.done、reasoning_summary_part.done、output_item.done 和终态快照。只补发缺失后缀，避免曾收到部分 delta 后丢弃完整终态文本；共享流式和非流式汇聚逻辑。

协议与网关专项 180 项通过。共享工作区另有未完成分组修改引用不存在的 deleted_at_ms，故在基于 0.45.4 的独立检出验证本轮转发修改；真实 workerd 29 文件、78 项全部通过，包含文本与推理补齐后的实际结算与预留释放。部署使用同一隔离检出，保留其他工作区修改。提交 `a2cf8a479` 从独立检出成功部署 0.45.5，Worker version `db211b25-338c-437c-9e3e-f2857db3dfbc`。

## 0.45.6：保留原生 Responses 输出项

原始 Go 实现按 output_index 收集完整 done 输出项。Worker 的非流式 SSE 兜底汇聚现同样保留上游消息 ID、状态、引用 annotations、推理 encrypted_content、自定义工具 input/type 及其他原生工具输出，按输出索引恢复顺序，并用已有分片补齐缺失内容。避免把多个消息压成单个对象或把自定义工具误改为 function_call。

独立检出协议/网关专项 182 项及真实 workerd 29 文件/79 项通过，类型检查通过。新增原生端到端场景验证乱序 done 输出恢复完整结构、用量只结算一次且预留释放。提交 `b641ea834` 已部署 0.45.6，Worker version `036b1be4-a7e1-42a2-b8e5-a154c9d59d15`。


## 0.45.7：Composer 路由与慢上游兼容

生产脱敏观测显示，Composer 最近一次 502 来自 HTTP 200 正文中的 `INFERENCE_STREAM_ERROR_TYPE_OUTPUT_TOKEN_LIMIT`，请求 `max_tokens=16`；同时存在成功请求，不能据此判断上游整体不可用。保留调用者限额，明确输出超限返回可操作的 400，撤销余额/Key 预留，不记为成功扣费。

对照 `backend/internal/config/config.go` 恢复推理响应头等待默认值：OpenAI/Codex 不设固定超时，Grok 120 秒，其余 600 秒；健康检查维持短超时。等待响应头期间续租账号并发、Key 并发和长期余额预留；跨重试和响应体读取交接连续续租序号，正文时限从响应头到达后开始。

修复 Chat-only/Responses-only OpenAI 模型目录阻断另一公共协议的问题。账号能力、强制协议策略、分组授权、渠道价格和配额依旧校验，实际传输交给既有双向协议转换。未配置到用户分组目录的 Grok/DeepSeek 模型不凭空开放。

慢流原生复测另揭示：转换器遇到仅用量或不完整 SSE 分片时返回零个下游块，读取循环提前返回使下游挂起。现持续读取直到产生下游内容或终态，并保留背压和取消路径。

包含已提交的分组软删除修复；部署前应用追加迁移 0116。网关与分组 56 文件/778 项通过；最终网关专项 157 项复测通过，真实 workerd 30 文件/82 项全部通过，包含 65 秒首包、25 秒后续流、至少 4 次连续续租、流正常终止及 27 micros 仅结算一次。类型检查通过。提交 `6e36d44f3` 已推送 origin/main 并部署 0.45.7；Worker version `361c3e00-a424-4802-b81f-5e2c736fd8da`。生产迁移 0116 已应用，`/health` 返回 status=ok、version=0.45.7。当前未持有生产测试 Key，本轮生产账号实际推理调用仍待复测，不能将本地 fixture 的成功视为真实上游成功率保证。


## 0.45.8：非流式工具参数完成事件

非流式 Responses SSE 汇聚原先忽略 function_call_arguments.done 和 custom_tool_call_input.done，导致只有完成事件包含完整参数时，返回截断或空工具输入。现以完成事件中的完整参数更新工具，支持 output_index 与缺省索引时的 call_id 关联，保留函数/自定义工具类型及原始 item ID。检测冲突的 call_id/item_id，拒绝错配工具；重复完成事件不会拼接重复参数。

协议/网关专项 187 项、原生 Responses 汇聚及 Chat 桥接 10 项通过，类型检查通过。原生场景同时恢复函数的完整中文参数及自定义工具输入，确认 17 micros 只扣一次、预留归零。提交 `faf245633` 已推送 origin/main 并部署 0.45.8，Worker version `da241845-c21d-491b-a9bf-650efb54ad14`；线上 `/health` 确认 status=ok、version=0.45.8。


## 0.45.9：工具参数容错及双向工具往返

同步原版 `backend/internal/service/openai_gateway_response_handling.go` 的重复 JSON 参数修复：仅在 arguments 恰为两个相同且各自合法的 JSON 对象/数组时恢复为一个；不处理普通文本、自定义工具 input 或不同内容的拼接。覆盖 Responses JSON、原生 SSE、非流式汇聚和 Responses→Chat 转换，包括仅有 SSE event 名称的完成事件，保留调用者输入对象不被修改。

新增原生双向两轮测试：使用单协议目录通过另一公共协议发起两个同名工具调用，第二轮逆序提交两个中文工具结果，上游严格验证原调用 ID、名称、参数与结果关联。Responses 上游还模拟重复 JSON 参数。两轮均完成，分别结算 17 micros，总计 34 micros，预留归零。

最终协议/网关/用量 320 项通过；全量原生 31 文件/85 项通过，补充事件名后相关原生 9 项复测通过，类型检查通过。提交 `cd509f8c2` 已推送 origin/main 并部署 0.45.9，Worker version `e1daabeb-8fa6-44a7-8fee-0c43bf76c4c9`；线上 `/health` 确认 status=ok、version=0.45.9。


## 0.45.10：错误体计费与调度分类

新增回归先复现两个缺陷：Composer 输出 token 超限返回 400 但仍写入账号故障样本；原生 Responses 的 HTTP 200 普通 error 包装体返回成功并进入成功结算。现输出超限不写成功/失败调度样本，配额和真正的服务端故障仍保留故障样本。Chat 与 Responses 普通错误体均按 400/429/502 返回，撤销余额和 Key 预留，不成功扣费、不泄露上游私有错误内容。

正式 Responses 失败文档保留原始状态和内容，按 failed 记录上游实际用量；cyber_policy 维持零用量、零费用，与既有桥接行为一致。合法 incomplete 部分结果继续按成功语义处理，未改写为普通错误。

最终网关/用量 165 项、原生 Responses/计费生命周期/调度 27 项通过，类型检查通过。原生验证包括 400/429/502 的无扣费与预留/并发释放、故障样本分类、正式 failed 文档的实际费用及 cyber_policy 零费用和 failed 投影。提交 `d97f8405d` 已推送 origin/main 并部署 0.45.10，Worker version `60181ea4-a20e-40f5-a4b5-7f3595fe43ec`；线上 `/health` 确认 status=ok、version=0.45.10。


## 0.45.11：优先恢复 Chat 正常 EOF 兼容及管理端测试

按用户最新要求优先 Chat Completions。同步原版 `openai_raw_stream_truncation.go` 的终止信号：除 DONE 外，收到 finish_reason 或 usage 对象后正常 EOF 也可成功结束。继续读取到 EOF，保留 finish 之后的用量与错误；真正没有终止信号的断流仍失败，错误优先于完成标记。

管理端账号 Chat 测试在 EOF 时解析最后未以空行分隔的 SSE 帧，对齐原版逐行读取行为；测试已完成时不再等待可能永不结束的上游取消 promise，及时关闭前端事件流。保留原始前端 TestEvent 协议。

先复现诊断尾帧失败及取消挂起共 3 项，再修复。网关/用量/诊断 197 项通过，其他诊断适配专项合计 47 项通过。原生 Chat 场景验证 finish、usage、错误和真实截断，并通过真实管理员会话调用账号测试接口。最终全量原生 32 文件/94 项通过，类型检查通过。提交 `c66eddb7b` 已推送并部署 0.45.11，Worker version `9f793bf0-9840-47fa-9b22-f6a59639db37`；本地代理 health 复核遇到 TLS 超时，未将其计作线上推理成功。


## 0.45.12：Chat 客户端 SSE 与缓存命中统计

用户反馈 Chat 客户端看不到流、客户端和后台缓存命中均不正确。本轮确认并修复：

- `stream:true` 遇到 JSON-only Chat 上游，原先直接返回 JSON；现在输出标准 `chat.completion.chunk` 的角色、内容/推理/工具、finish、usage 和 DONE 帧。保留模型名、调用 ID、完整参数和用量，错误体沿用原有失败分类，转换失败撤销预留；不声称能恢复 JSON-only 上游未提供的逐 token 时间间隔。
- 原生 SSE 最后一帧缺少空行时补齐分隔；原版认可的 finish/usage + 正常 EOF 补发 DONE，错误及真正截断不伪装成功。
- 对齐 Go `openAICacheReadTokensFromUsage` 与创建缓存字段优先级：兼容 `cache_read_input_tokens`、`cache_read_tokens`、`cached_tokens` 等平铺字段，显式嵌套零优先。同步/流式及 Chat↔Responses 转换补齐标准 details 字段，客户端与内部结算采用同一实际缓存量。
- Worker 投影 input_tokens 已包含缓存读取量。管理端、用户端、Key 信息、账号用量统一在原版前端契约中返回未缓存输入，汇总总量不重复加缓存；保留存储与计费语义，无历史账单重写。历史缺失的缓存量不会被凭空恢复。

新增真实 SSE 客户端解析 + D1 + 余额账本 + 管理仪表盘原生测试：输入 100，缓存 80，输出 2；客户端 cached_tokens=80，后台未缓存输入=20、总量=102，账本仅扣 88 micros 一次，预留归零。网关、用户统计、管理统计、观测等 76 文件/1001 项通过，类型检查通过。最终全量原生 33 文件/95 项通过；收尾补充 DONE 尾帧不重复发送回归，网关/用量 182 项复测通过，类型检查通过。提交 `55114edc6` 已推送 origin/main 并部署 0.45.12，Worker version `4db124ca-2ae2-465e-987f-80078e399e5c`；线上 `/health` 重试后确认 status=ok、version=0.45.12。尚未使用生产 Key 完成真实 Composer 上游推理复测，不将原生 fixture 验证表述为生产上游成功。
