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


## 0.45.13：管理端诊断与实际 Chat 转发结果一致

承接 0.45.12 JSON-only Chat 上游支持，修复管理端账号测试仍只按 SSE 读取导致的假失败。明确声明 JSON 的 OpenAI Chat/Responses 响应在既有大小限制和超时内读取，验证完成结构后发出原版 `test_start/content/test_complete` 事件；保留 SSE、代理、认证及原始前端能力。

同步拒绝 `response.completed` 内的错误体，防止 SSE 上游 HTTP 200 被诊断为成功。自动探测同样拒绝错误对象和 failed/cancelled/incomplete 状态，避免部分文本覆盖故障事实或误解除告警。

诊断新增回归先复现 3 项失败（两种 JSON 正常响应与 SSE 完成包夹带错误）；自动 Chat 探测先复现 HTTP 200 错误体/failed 状态两项误判。修复后 5 文件/83 项通过，类型检查通过；Cloudflare 原生 3 文件/7 项通过，包含真实管理员会话的账号测试、Chat EOF 和 provider 请求构建。提交 `76751881d` 已推送 origin/main 并部署 0.45.13，Worker version `4fc72c49-bbe7-4397-bd16-110e7e03a955`；线上 `/health` 确认 status=ok、version=0.45.13。生产 Composer 实际推理仍需可用的生产测试 Key 验证。


## 0.45.14：大请求 Chat 空回复保护与安全切换账号

对照原版 `openai_silent_refusal.go`、`openai_gateway_chat_completions_raw.go`，为 OpenAI/Grok raw Chat SSE 加入 64 KiB 请求阈值保护：只有 stop 结束且没有内容、工具/函数调用字段、推理字段、usage 对象、错误证据时判为 `openai_silent_refusal`。小请求及带这些证据的正常回复保持原行为；等待 DONE 或 EOF，避免丢掉 finish 后的 usage。

在客户端收到首批内容前识别，复用现有账号失败冷却/重试；无可用备用账号时返回 502 并取消计费预留。只保留有界前缀，使用同一个 reader 交还剩余正文，不使用 tee；有效内容到达即交还，不等待整包。等待期间按原序列续租并发、Key admission 及长时计费预留，保留 15 分钟正文上限与客户端取消处理。客户端主动取消不再触发账号重试或故障冷却。

网关 56 文件/827 项通过；收尾取消/超时/空回复专项 183 项通过，类型检查通过。全量原生 33 文件/97 项中，新增严格故障样本断言发现测试优先级顺序反置，其余 96 项通过；按实际“数值小优先”修正夹具后，计费生命周期 16 项复测通过，证明首个账号失败后才使用备用账号。无备用账号 502 且余额/Key 不扣费、预留归零；有备用账号恢复并仅扣费一次。另以大于 64 KiB 请求实测 65 秒响应头等待 + 25 秒正文等待，Composer 原生 3 项通过，租约续期不少于 4 次，无过期/序列错误。并行分组目录提交 `d26338dac` 已合入，相关前端 18 项通过。最终提交 `0d95b70a9` 已推送 origin/main 并部署 0.45.14，Worker version `1f00e0af-c38d-465e-9df3-fe69d1d80cf5`；线上 `/health` 确认 status=ok、version=0.45.14。


## 0.45.15：Chat→Responses 慢推理首帧与流空闲超时

对照原版 `config.go` 的 `gateway.stream_data_interval_timeout=180` 默认值，修正 Responses 预读固定等待 15 秒的规则。现在按上游数据间隔计算 180 秒空闲超时，收到心跳或其他数据即重置；预读另有 15 分钟上限。等待首个可见内容期间每 20 秒顺序续租，序列交给后续流处理继续使用；流正文的默认空闲限制同步为 180 秒，取消后的短时排空限制不变。

检查器自身的超时明确进入 504/账号重试，不再把同一超时流交给正文阶段重新等待。上游自行发送的同名错误事件仍使用原有语义与结算，不与本地计时器混淆。预读超时遵守管理端 stream-timeout 的处置配置，本次请求排除已超时账号；关闭处置时不擅自冷却账号。异常与取消均释放 reader，取消不等待上游可能挂起的 Promise。

先复现慢推理 15 秒假失败和心跳未延长空闲期限两项回归。修复后网关 56 文件/831 项通过，类型检查通过；双账号原生测试等待真实 65 秒后仍由原账号完成，无备用账号调用/故障样本，至少 3 次顺序续租，余额仅扣 27 micros 一次、预留归零。专项原生 17 项通过，最终完整原生 34 文件/98 项全部通过。提交 `00390f311` 已推送 origin/main 并部署 0.45.15，Worker version `7623215d-855f-4063-8a7b-c7679111fd3a`；线上 `/health` 确认 status=ok、version=0.45.15。


## 0.45.16：Responses 空完成与 Chat 桥接的原版边界

同步原版 `openai_gateway_responses_empty_completed_test.go`（issue #5009）、`openaiStreamAddedEventStartsClientOutput` 和 `openai_silent_refusal.go`。原生 OpenAI/Codex Responses 在没有此前有效输出/正用量/失败事件、完成事件自身也没有 output/usage/error 时，于发送客户端内容前判为 `openai_silent_refusal` 并换号；无备用账号返回 502、取消预留、不扣费。保留未知原生工具、有效加密推理、工具参数、拒绝内容与完成事件的 usage（包括显式 null）的原行为。此前 metadata 的 error:null 不当作真实失败，避免掩盖后续空完成。

Chat 桥接与原生 Responses 分开判定：Chat 按客户端原始请求大小启用 64 KiB 阈值，采用原版 Chat 对工具/推理字段及 usage 对象的语义；小 Chat 请求保持原行为。入口接口与上游接口不再混用。原生 Responses 中空工具/消息/推理占位事件不提前提交请求；Chat 中原版允许的工具/推理占位证据仍保留。明确失败状态或 error 的 completed 事件按失败处理，不伪装空完成或成功。

先复现 7 项检测缺口，网关 56 文件/856 项通过；最终边界与处理链 212 项通过，类型检查通过。原生覆盖 Chat 大/小请求、两种公开接口、流式/非流式、有无备用账号，验证失败账号样本、无空前缀泄漏、一次扣费与租约归零。完整原生 35 文件/107 项通过，补充真实 metadata null 字段后 9 项原生复测通过。提交 `d00df31c0` 已推送 origin/main 并部署 0.45.16，Worker version `73fa8f48-c3a1-42b8-a285-11f859ab9162`；线上 `/health` 确认 status=ok、version=0.45.16。


## 0.45.17：缓存写入 token 全链路与 D1 账号统计

对照原版 `usage_service.go` 和 `usage_log_repo_stats.go`，确认缓存创建与缓存读取应分别返回，total_cache_tokens 为两者之和。现有上游解析已读取 cache_write_tokens，但 UsageSettledPayload 丢失该字段，多处后台返回固定零。新增迁移 0117，在 usage_projection 和 account_usage_15m_rollup 保存缓存写入；队列保留旧事件兼容及不可变 wire digest，重复投递不重复累计，改变缓存证据视为冲突。账号历史汇总恢复同步保留该字段。

管理端用量列表/汇总/模型/仪表盘、用户用量与仪表盘、Key 用量、账号模型统计均返回原版分桶：普通输入=总输入-缓存读取-缓存写入，总量仍为总输入+输出。仅保存实际报告的写入量，历史缺失证据保留零，不重写历史金额；缓存创建 5m/1h TTL 细分和独立费用字段仍待后续完整定价对齐，本阶段不宣称完成这些能力。

扩展原生 Chat JSON→SSE 回归，先复现客户端写入=10、后台写入=0且普通输入错误为20。修复后输入100/读缓存80/写缓存10/输出2在客户端、真实管理员分页用量/统计/模型/账号统计、Key用量中一致，普通输入10、总量102，账本仅扣88micros一次、预留归零。用户端各用量接口新增SQLite回归。

原生账号统计测试额外发现现有六项 UNION ALL 超过 D1 compound SELECT 上限，原先普通SQLite测试未捕获。将 summary/overflow 放入独立子查询，保留单次有界查询、全部统计维度和溢出保护；实际D1绑定验证恢复200。

相关网关、迁移、统计等102文件/1000项通过，D1查询调整后账号统计12项复测通过，类型检查通过。全量原生35文件/107项通过。发布检查发现迁移缺少项目要求的 schema_migrations 记录，在远端执行前拦截；补齐后迁移79项、迁移脚本13项及真实目录发现校验通过。代码提交 `c778f3547`、迁移修正 `950234a68` 已推送 origin/main。生产0117迁移成功应用，部署0.45.17，Worker version `e2257aa7-dce8-4de1-ab24-af62251df119`；线上health确认status=ok、version=0.45.17。生产 Composer 实际推理与真实缓存命中仍待生产请求验证。


## 0.45.18：Chat 缓存身份与无 session 的账号关联

继续区分缓存统计与真实上游复用。对照原版 `openai_gateway_chat_completions.go`、`openai_compat_prompt_cache_key.go`、`openai_content_session_seed.go` 和 `openai_gateway_scheduling.go`：

- Chat→Responses 显式 prompt_cache_key 原先被转换器丢弃，先复现失败再修复。原版稳定会话头优先于 body key；转发到 Responses 时补上稳定 session_id，忽略轮次变化的 request ID。
- GPT-5/Codex Chat 桥接缺省键由已映射模型、system、首条 user、工具/函数及 reasoning/tool_choice 得到，后续 user/assistant 追加不改变键。API Key 自动缓存键按租户隔离，显式 body key 保留、上游 session 仍隔离。OAuth保留原版compat_cc种子形式、session按Key隔离。Worker Key是字符串ID，租户隔离使用显式版本命名空间SHA-256，而非Go整数ID的xxhash字节编码；稳定性与隔离契约一致，不声称跨部署实现的生成值相同。
- OpenAI/Codex/Grok文本请求无显式session时，按原版 model/tools/functions/instructions/前置system或developer/首条user形成内容关联。Chat晚加入的system消息不改变调度身份；Responses input有独立原版规则。关联键在送入Pool之前以含user/key/group/model/endpoint命名空间的现有加密摘要隐藏原始内容。原生Chat请求体不新增自动缓存键，Embeddings等保持既有显式关联边界。

新增原生测试验证桥接上游实际收到的键/会话：跨轮次稳定、跨Key隔离、显式键/头优先级、原生Chat不注入；计费一次、预留归零。专项177项通过，完整网关57文件/867项通过，类型检查通过。完整原生36文件/109项通过。提交 `a2b37aff3` 已推送 origin/main 并部署0.45.18，Worker version `d0788e02-7391-4e0f-816c-72e434f945b6`；线上health确认status=ok、version=0.45.18。本轮不将fixture中的稳定键表述为生产上游实际缓存命中率，也不宣称已完成所有OAuth账号身份能力。


## 0.45.19：Responses 格式请求发往 Chat URL 的兼容

对照原版 `ForwardAsChatCompletions` 的 Cursor 分支：仅当顶层 messages 不存在而 input 存在时，将请求视作 Responses 格式。Worker 原先强制进入 Chat messages 转换，拒绝这类客户端；新增 chatRequestToResponses 短路，在Responses上游分支和OpenAI OAuth桥接中保留input（字符串/数组）、原生工具/工具结果和其他原生字段，重写模型并按原版仅清除prompt_cache_retention、safety_identifier、metadata、stream_options。显式messages:null保持原Chat校验，不静默忽略错误字段。service_tier沿用原版normalization。

此格式不自动生成GPT缓存键，但保留显式prompt_cache_key/会话头及租户隔离session_id。修正按Responses形状设置默认max_output_tokens，避免原Chat默认max_tokens被误带至Codex。OAuth专项先复现同步/流式两项带max_tokens=4096的失败，再修复；既有Codex规范化负责删除不支持的输出限制字段。

原生同步/流式测试通过Chat URL发送完整input、自定义工具定义、custom_tool_call及其output，验证实际上游字段不丢失，下游仍为Chat completion/chunks，流式DONE完整，账本一次扣费、预留归零。OAuth加密凭证执行链的同步/流式回归也覆盖输入规范化、原生字段清理、session及单次结算。完整网关57文件/871项通过，类型检查通过；全量原生37文件/111项通过。提交 `909193aa2` 已推送origin/main并部署0.45.19，Worker version `be1b33c1-943b-4dd9-82a5-05b19b694765`；线上health确认status=ok、version=0.45.19。生产Composer实际推理仍未通过生产Key验证。


## 0.45.20：保护渠道监控模板的模型及检测输入

对照原版 channel_monitor_checker.go 的 bodyMergeKeyDenyList，修复 Worker 的 merge 模板可以覆盖模型名及检测输入、把错误模型的探测结果归到配置模型的问题。OpenAI Chat 保护 model/messages/stream，Responses 保护 model/instructions/input/stream，Anthropic 保护 model/messages，Gemini 保护 contents，其他 Chat 提供方沿用 Chat 规则。其余参数继续浅合并，replace 模式保持独立能力。

新增 Chat/Responses HTTP 接口回归先复现实际发出 wrong-model，再通过修复；扩展 Anthropic/Gemini 覆盖。渠道监控、v2监控、账号探测、分组模型目录四文件46项通过；包含主分支既有分组模型候选修复。提交 `1df173bed` 已推送 origin/main 并部署 0.45.20；Worker version `326dbe35-b556-4337-a3ad-21cf4cc9098d`，线上 health 确认 status=ok、version=0.45.20。此次不宣称完成监控全量对齐：随机算术验证、45秒超时及多模型租约预算、慢响应降级、ping仍需继续修复；也不把监控测试作为生产 Composer 推理证据。
