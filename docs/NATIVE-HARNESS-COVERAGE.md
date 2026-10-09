# Pi Harness 接线与验收台账：SDK 0.4.0

日期：2026-10-09。范围为精确 `pi-agent-core + pi-ai 0.86.1` 的正式 Harness 机制，标准维持 v0.3。共享层状态与真实产品采用分列；发布身份以 RELEASE-v0.4.md 和发布收据为准。

原生公开入口与声明定位保存在 `artifacts/native-integration-20261009-001/native-exports.json`：根、node、harness/context、harness/env/nodejs、harness/runtime/reducer、harness/session、harness/session/testing、experimental/pico3。462 个根导出包含类型、重复重导出及支持原语，不等于 462 项产品功能。底层 Session values/commit、Models、Context 留在唯一 Pi Adapter，不透传产品。

下表的 SDK 证据都是实际运行消费或拒绝探针。JuanerAI 列表示接入职责，**全部尚未采用此版本**；不把合成消费者冒充生产入口。

| ID／原生能力 | 中立接入位置与配置 | SDK 执行证据 | JuanerAI 消费位置／状态 |
|---|---|---|---|
| N01 Agent/AgentHarness create/close、循环 | createRuntime 普通入口用临时 Harness；createSessionRuntime 持久 Harness；旧 checkpoint 兼容 Agent | HN01/HN02，NS01；真实工具结果参与后续模型 | 生产分析 Adapter，待采用 |
| N02 accept/drive/result/resume/abort/idle | run(operation)、inspect、result、control(abort)、waitForIdle；bindOperation + reconcile | NS02/06/11/15/17/18，HC02，HE04；已知恢复推进、未知拒绝、物理空闲前保留 lease | 任务继续/停止/恢复，待采用 |
| N03 JSONL/StorageBackedSession/MemorySessionRepo、CRUD/fork/close | storage 显式专属根、policyVersion、authorize/acquireWriter；create/list/history/delete/fork | NS01/03/04/05/16；两个真实进程、损坏/尾行、竞争；native conformance | 产品会话仓库 Adapter，待采用 |
| N04 分支/历史/导航/标签/命名 | history/inspect/fork/update；run(navigate)、branch/targetEntryId | HE03/07，NS18；真实上下文分离、摘要消费、硬退出后导航恢复 | 分析路线探索，自有终端历史，待采用 |
| N05 Skills 加载/格式化/调用 | loadHarnessResources 显式可信源；harness.skills；run(skill) | HE01、NS07；磁盘专业夹具进入真实请求，内容变更改变身份，拒绝越权加载 | 专业方法内容由产品拥有，待迁入原生机制 |
| N06 模板加载/参数展开 | loadHarnessResources + harness.templates；run(template) | HE01、NS07；实际参数消费及不存在资源负例 | 分析/决策模板，待采用 |
| N07 手动/自动 compaction | harness.compaction 显式阈值；run(compact)；原生切点/摘要 | NS08/09/10/18；持续任务达到阈值、后续模型消费摘要、辅助预算拒绝 | 长分析任务，业务质量待验 |
| N08 分支摘要 | run(navigate, summarize:true)；原生 summary 保留 | HE07/NS18；后续上下文真正消费摘要，恢复返回摘要 | 分支继续，待采用 |
| N09 steer/followUp/nextRun/cancelQueued | control + steeringMode/followUpMode；原生持久队列；SDK 在 native value 内保存 task/purpose 所有权 | HC01–04；真实消费/撤回/拒绝跨任务用途再开；重启后空闲撤回无模型调用；模型准入仍逐次检查 | 用户执行中补充/下一轮/撤回，待采用 |
| N10 模型/thinking/activeTools/资源/retry/配置 | 中立 ModelConfig、tools、harness；不可变 purposes 内选择；原生 setters 内部装配 | NS12/13、thinking/purpose/fallback 回归；每个物理尝试计量，quota 不重试 | 产品模型配置与任务策略，待采用 |
| N11 hooks/events/watch/reducer | extensions（context/request/tool/end/projector）；onHarnessEvent；control(snapshot, includeContent?) | HE02/HC01/02；Hook 异常继续不绕权，observer 不作门，快照受授权 | 自有终端进度与专业上下文扩展，待采用 |
| N12 消息/custom entry/投影/多模态 | update(message/custom)、extensions.projectEntry；ModelMessage/images/reasoning | HE02/05、R07 图像真实 Pi HTTP 编码、thinking 跨轮签名回归 | 业务上下文与图像材料，待采用 |
| N13 工具/schema/并行/memo/progress/replay | Tool.execute 第三参；replay/update/getMemo/setMemo；原生 invocation | HN02/HE06/07/NS14/15/17；批次、真实进程恢复、已知回执、防重复效果、保存失败 | Analysis IR/业务工具，专门产品验收待做 |
| N14 原生 read/write/edit/bash 工厂 | createExecutionTools(env,names)；按任务提供、效果仍过授权/预算/审计 | EX01/02；文件真实读写改及 Bash 输出被模型消费 | 授权材料与计算产物，待采用 |
| N15 ExecutionEnv/FS/Shell | 中立 ExecutionEnvironment；createLocalExecutionEnvironment；内部映射原生接口，不回退无限 Node 环境 | EX01–03；越界/symlink/hardlink/FIFO/网络/fork拒绝、真实停止与输出封顶 | 宿主隔离基础设施，待采用；本地后端是受限单进程，详见发布合同 |
| N16 Context/取消/Telemetry/errors/usage | 内部 Context；中立 observation/Reason/Usage；可靠 AuditSink 与权威 BudgetStore | 故障/取消/迟到回归、NS10/11/14、HE06；审计失败关闭准入 | 状态/取证/成本，待采用 |
| N17 SessionSearchService | 原生只有接口，没有搜索引擎；history 提供获准会话内容，产品检索需求出现时对接已有后端 | **无内置能力可接**，不宣称搜索已实现；不为接口造平台 | 当前未确认检索消费者，待决定 |
| N18 streamProxy | createProxyTransport；显式 proxyEndpoint/authToken；隔离 Worker 中使用原生 streamProxy | PX01；本地实际 SSE、拒绝重定向、Worker 停止后才释放物理占用 | 可选代理部署，未启用；不建中央网关 |
| N19 Session commit/values/fork policy/conformance | 内部原生 Session；SDK 单写入者、宿主账本对账；native 测试合同 | native-conformance.test.ts、NS04/06/16、HE06；原始 race 失败保留，以 SDK 独占合同验证 | 支持原语；不向产品透传值地址 |
| E01 experimental/pico3 | 实验入口单列，不替代正式 Harness | **未采用、未启用** | 无确认需求 |

## 模型桥接与条件能力

| ID | 接线与验证 | 边界 |
|---|---|---|
| M01 Models/Provider/model/auth | 内部 createModels，宿主显式模型和 transport；R07 两协议真实 Pi 编解码离线消费 | 内置 OpenAI completions/Anthropic messages；不继承 coding-agent 认证/目录，不自动刷新/登录 |
| M02 stream/complete/simple、usage/工具/签名 | 原生 Models 共用 guarded transport；主调用、压缩、分支摘要、retry 全部计入 Task；NS08–13 | 公共 transport 是中立完成消息，不透传 Pi 对象；不提供任意供应商私有 headers/参数绕过身份 |
| M03 deferred start/poll/cancel | 声明 ModelConfig.deferred + harness.deferred + 明确支持的 transport；HE04 磁盘再开、轮询/取消计量 | 条件能力已接；内置两个 transport 未提供异步 Provider 支持时明确不可用；未知初始预留不退款 |
| M04 能力差异/图像/reasoning | ModelConfig.input/reasoning，InputImage/有序 reasoning blocks；HE05、R07、thinking 回归 | 未声明图像能力拒绝；音视频等未在当前中立合同支持的输入拒绝，不伪称任意协议/模态全覆盖 |

## 原生缺口与最小补充

- Hook 异常报告后继续：权威门在实际模型/工具执行边界，不能只靠 Hook throw。
- JSONL 与产品预算/审计无共同事务：bindOperation 先可靠确认，未知效果 reconcile 拒绝；工具回执关联 native invocation，不自造 Session 引擎。
- 原生队列没有业务 Task 所有权：SDK 只增加 `sdk.queue-authority.v1` native value；先写所有权再入队，残留 inbox 不匹配或无所有权就拒绝推进。
- Harness 0.86.1 调度只看批次模式，不看逐工具 sequential：仅对实际批次补串行门；重启从原生待执行批次恢复该判断。
- 原生 JSONL create/fork 同目标 race：首轮 conformance 失败保留；宿主专属根独占包围每次读写，测试在同一约束下通过，没有改原生断言。
- NodeExecutionEnv 没有任务隔离：模型文件工具使用独立受限环境；本地进程禁止 fork，复杂多进程需合格宿主后端。
- 原生 streamProxy 没有 per-call fetch 且默认跟随重定向：在专用 Worker 内使用原生函数并禁止重定向，不改应用全局 fetch。

## 证据与采用

当前完整合成命令：`PI_RUN_OS_SANDBOX_TESTS=1 PI_RUN_LOCAL_PROXY_TESTS=1 npm run verify`。证据在 `artifacts/full-harness-20261009-001/`，包括首次失败、修复回归、独立评审和最终包消费者。默认 npm test 会跳过需明确宿主执行的 OS/loopback 两项；最终完整验收不能用默认跳过代替。

SDK 机制通过不表示 JuanerAI Analysis IR、真实专业质量、生产账本或双模型验收通过。Provider、真实数据、Mini 采用/启用均未运行。CLI、主题、命令系统、包管理与长期 Memory 均不属于此次 Harness 交付。
