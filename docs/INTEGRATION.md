# 宿主接点与采用检查

按 [接入标准 v0.3](AGENT-RUNTIME.md) 的 P1～P6 选择模式与验证范围。SDK `0.3.0` 新增可配置并行、thinking 及 `runText`，增量与兼容条件见 [v0.3 合同](RELEASE-v0.3.md)；授权、预算、审计及停止护栏保留。

## 五个必要输入

1. **Model + transport**：显式 provider/id/protocol/endpoint/contextWindow。内置 `createPiTransport` 支持 OpenAI completions 和 Anthropic messages，显式 apiKey、SSE、关闭自动重试和缓存。凭据不进入配置模型、记录或返回值；不读认证文件。已做离线协议验证和部分有界真实合成联调，证据与限制见接入标准引用；不推定任意供应商/模型已验证。
2. **Authorization**：宿主每次收到 model/tool/publish 请求。验证 taskId/runId、数据外发、具体资源与参数、用户确认或预授权、撤销和有效期；预授权范围内自动放行，不要求每次弹窗，越界或缺授权才请求决策。默认没有 allow-all 实现；示例的 true 仅用于合成测试。鉴权回调不得自行执行副作用或把待确认写操作偷做掉。
3. **BudgetStore**：同一任务只能有一个活动 lease；claim 比较配置签名，reserve/settle/release 原子。使用公开 `RuntimeFault` 表达 TASK_BUSY、CONFIGURATION_CHANGED、BUDGET_EXHAUSTED；非协议异常成为 STATE_FAILED。额度不因请求、Runtime 实例或授权回调而重置。一个产品的多个实例必须共享权威存储。
4. **AuditSink**：append 是持久化确认，不是排队后立即返回。失败阻止后续模型/工具效果或成果发布；audit 挂起受独立截止时间限制。UI observer 是旁路，异常不能授予权限。正式报告、原始数据和审计身份映射/引用由宿主安全存储，本包不保存敏感原文。
5. **Tools + output validator**：工具名、描述、JSON object schema、read/write/external、resourceUnits、execute，可加 executionMode。工具仍需字段/业务规则校验、资源授权、幂等、事务、补偿和外部隔离；JSON schema 不是 sandbox。结构化 Worker 的 validator 检查结构与含义，不能只做 TypeScript cast。文本任务可用 runText，可选文本 validator；工具 Agent 按任务标准评估，不强行包装 JSON。

业务状态不传入 Pi session。任务 ID 不可按每次请求随意重新生成。runId 由 SDK 每次生成，所有运行事件与结果回链该 taskId/runId；contextVersions 是输入版本引用，必须指向宿主可读取的真实资源，标签/hash 本身不证明资源被正确消费。

## BudgetStore 契约细节

接口见 `src/types.ts`，参考实现见 `src/budget.ts`。configuration 是模型、limits、工具声明及显式 toolExecution/thinkingLevel 的 SHA-256；同任务改变这些必须拒绝，而不能静默放宽。省略新字段时保持旧签名结构；显式填写默认值也构成配置身份变化。prompt、system、contextVersions 可按新运行更新并记录；这不构成业务计划批准。

旧有限模式 reserveModel 返回本次剩余额度，并先扣模型次数、1 resourceUnit、全部 token 预留。已知合法用量再结算剩余；未知/失败/取消保留额度。工具先按声明扣工具次数及 units，不因失败退款。wallTimeMs 是累计运行占用上限（含授权/审计/等待）；不是每次独立重置的额度。

snapshot 必须同步返回安全的副本且不执行 IO；claim/reserve/settle/release 可异步，必须保持原子性和 owner 隔离。release 成功表示占用/累计时间已可靠结算；失败不能返回成功成果。持久化适配器还需有崩溃后的未知状态策略，不能过期后盲目释放可能仍运行的外部效果。SDK 不提供生产持久账本实现；合成跨进程宿主夹具已验证协议，产品仍须实现自己的原子持久 Adapter。

`usageKnown` 为 false 时使用量不可用。为 true 时 outputTokens 仍可能含保守预留；resourceUnits 是资源单位，不是元或美元。HTTP transport 对缺失/零 output usage 保守计入本次 token 上限，不假定调用免费。实际账单封顶需要宿主供应商配额及计费策略，未在本轮实现。

## 取消、恢复与证据

AbortSignal 可协作取消；独立 timer 可让 API 及时返回停止，但未完成 JS/HTTP/外部写操作可能仍存在。`waitForIdle` 不保证有限时间，也只看本实例；生产宿主应给等待/状态核查自己的边界。未结算任务 TASK_BUSY，不开放强制释放或自动重放。

定时器以 Node 事件循环仍可运行为前提；同步死循环/CPU 阻塞不能靠 AbortSignal 或 setTimeout 打断，需宿主进程/Worker/容器隔离。首版 prompt+system、单个工具 schema、模型回复和工具结果设 1 MiB 安全上限；这是包内资源保护，不替代 token/context-window 或宿主业务大小限制。

SDK 在取消或 audit 不可用时不能承诺 terminal event 已可靠持久化。宿主需要保存实际 RunResult，并把未完成/未知副作用显示为未确认；run.finished 是 SDK 发布门记录，不是业务事务提交凭证。完整恢复、任务级停止后续推进与正式成果提交仍由产品 Application 持有。

测试入口记录的是完整合成请求/回复，不是脱敏生产 recorder。回放只能验证模型边界；要回放工具流程，必须提供无副作用的夹具工具并检查它们真正被调用/消费，不能拿生产工具重放。

## 接入顺序与验收层级

1. 产品先评估现有 Port/Adapter/合同与 Node 工具链；保留已有行为，不顺带迁移存储或重构业务。
2. 依赖固定 SDK 精确版本，用自己的 lockfile 固定传递依赖。先在独立试验入口装配合成 transport、真实 Pi 循环和无副作用工具。
3. 按受影响行为检查正/负向、外发/授权、累计预算、取消/未知效果、审计故障、输出/证据、适用的回放和任务质量。不把完全相同的 Agent 路径作为统一要求；持久化宿主存储额外验原子性与崩溃未知状态处理。
4. 单独获批真实 Provider、输入数据、预算后，对每个拟启用模型验证相应用途：单次变换验单轮/输出，多轮对话验上下文，工具任务验实际工具结果消费与任务可靠性。未验证相应能力的模型不能进入该自动任务主备链。
5. 获批该产品迁移/启用后再集成，回归产品验收。旧 Adapter/精确 SDK 版本应保留可回滚路径。

当前已交付独立基础包及部分历史有界真实合成联调证据；尚无真实产品采用，未迁移 JuanerAI/插件宿主或远程发布。此次实际增加能力与离线验证，但不追加 Provider 调用、不授权产品启用。普通内部实现不新增跨 Controller 审批。

## 并行与 thinking 接入

runAgent 的 toolExecution:parallel 使用 Pi 原生并发，含 executionMode:sequential 工具时整批串行。宿主 Authorization 与 BudgetStore 必须支持并发准入，reserveTool 保持原子；SDK 对单 run 的 AuditSink.append 串行排队，不将并发写要求转嫁给旧 sink。多个任务/实例共享存储的并发仍由宿主承担。一个工具失败后关闭新准入和结果发布，但已经启动的工具可能有部分效果；不能把并行批次当事务或自动补偿。

模型配置可含 reasoning 布尔值，compileSettings 保留这个已验证能力；并不根据模型名称推断。thinkingLevel 按任务选择，缺省/off 不请求启用；所有候选须支持，Provider 等级映射以 Pi 实现为准。当前只开放已有两种协议的标准映射，不提供所有供应商 compat 扩展。Anthropic budget thinking 需至少 2048 输出空间，剩余额度不足时不会为了思考扩大请求上限。Provider 用量包含 reasoning 输出，但账户实际成本仍需宿主治理。

ModelReply.content 新增中立 reasoning 分支，ModelMessage.blocks 在需要签名续接时携带有序完整块；旧无 reasoning 消息保持旧形态。自定义 transport、授权器或合成回放需适配这个分支，不输出到普通日志。Pi 跨模型转换会去掉屏蔽块/原签名，并可能把未屏蔽思考转为文本；每次候选的模型授权必须包括该上下文外发。测试 recorder 记录完整合成块，不是可直接用于生产的 recorder。最终输出只取 text，reasoning-only 不算成功。

## 0.4.0 原生 Harness 接口

用户批准的 JSONL 首版及新宿主接点见 [NATIVE-SESSION-CANDIDATE.md](NATIVE-SESSION-CANDIDATE.md)。必须复用产品持久预算/审计/业务 SQLite；提供明确目录、策略、独占写入、Operation 关联确认及恢复对账。新 SessionRuntime 内 Worker、Text、Agent 用途共用一份配置和任务预算；不要将旧任务直接跨配置迁入。当前完整机制、环境限制与固定包采用见 RELEASE-v0.4.md；Mini 只采用最终发布收据对应的包。

持续任务装配：

```ts
const resources = await loadHarnessResources({cwd, sources: approvedSources, authorize: authorizeSource});
const runtime = createSessionRuntime({
  model, transport, budgets: persistentBudgetStore, authorize: taskAuthority, audit: durableAudit,
  storage: {cwd, directory: dedicatedSessionsRoot, policyVersion, authorize: storageAuthority, acquireWriter},
  bindOperation: persistTaskOperationBinding, reconcile: reconcileLedgerAndReceipts,
  harness: {skills: resources.skills, templates: resources.templates,
    compaction: {enabled: true, reserveTokens: 4096, keepRecentTokens: 8192}},
});
const session = await runtime.create();
const result = await runtime.run({sessionId: session.id, taskId, prompt, limits, tools: authorizedTools});
```

上述变量是生产宿主责任，不可照抄测试的 allow-all/内存账本。原生压缩参数由实际模型上下文窗口和任务质量验收决定，不把示例数字用于所有模型。持续任务的 Skill 内容、工具结果、压缩摘要必须在下一次模型输入中真实消费。

活跃运行可 control(steer/followUp/nextRun/cancelQueued/abort/snapshot)。运行结束或重启后，原队列 Task/purpose 还可 control(snapshot/cancelQueued)，不会为了撤回而先启动模型；需显式传回 purpose，缺失/改绑拒绝。可靠审计失败不取消队列。普通历史读取用 history/inspect。

createExecutionTools 复用原生四种工具；宿主显式提供受限环境和工具名单。本地后端可选 macOS 单进程 sandbox（禁止fork/网络）；丰富计算后端由产品提供，不能把文件/进程函数当成自动具备数据权限。


## SDK0.4.1：JuanerAI 累计不封顶接法

先固定 0.4.1 包及 hash；本节说明接法，不表示 JuanerAI 已安装/采用。`createSessionRuntime`、Worker/Text/Agent、预声明用途集合共用同一策略入口：

```ts
// 以下值来自 JuanerAI 已生效的单次保护配置；此示例不规定数值或生产默认值。
const limits = {
  cumulative: 'unlimited' as const,
  maxOutputTokens: approvedPerRequestOutputTokens,
  modelTimeoutMs: approvedModelRequestTimeoutMs,
  toolTimeoutMs: approvedToolCallTimeoutMs,
  controlTimeoutMs: approvedControlIoTimeoutMs,
};
const result = await sessionRuntime.run({
  taskId: stableLedgerTaskId,
  sessionId: nativeSessionId,
  prompt: approvedPrompt,
  tools: authorizedProductTools,
  limits,
  modelRecovery: {extraAttempts: 1},
});
// composition root 的 harness.retry 必须关闭（省略时默认关闭）。
// 所有单次参数必须存在；缺失 INVALID_REQUEST，不套用示例或历史预算。
```

宿主 `BudgetStore.claimUncapped(taskId, runId, configuration, limits)` 原子比较配置并取得独占 lease，返回 `UncappedBudgetLease`。只实现旧 claim 的 store 返回 CAPABILITY_UNAVAILABLE，不自动退回内存。新 lease 的原子语义：

- `reserveModelUpTo(n)`：模型次数 +1、resourceUnits +1、outputTokens +n、reservedOutputTokens +n；n 为本次有限输出上限，不取累计剩余额度。
- `settleModelUsage(n, {inputTokens,outputTokens})`：保留并结算已知真实量，累计输入 +input，累计输出 -n+output，未结算预留 -n。即使 output>n，也须记录真实量；SDK 随后拒绝超单次输出成功。不能把这种已知消费伪装 UNKNOWN。
- `reserveTool(units)`：工具次数 +1、资源单位 +units，失败也不退款。`release(ms)` 增加累计活动时间、可靠释放 owner；时间包含控制等待与物理取消后的等待，不因下一 run 清零。
- `snapshot()` 同步返回安全副本，必须含安全整数 inputTokens/reservedOutputTokens。未知请求继续保留完整预留；deferred 的 start/poll/cancel 分别计次，未确认初始消费不凭后续回复退款。usageKnown=false 的零占位绝不表示没有历史。

新字段和 modelRecovery 进入配置 hash；旧有限、未提供新字段时原 hash 形状和 claim 接口保持。旧 Task 直接换 limits 返回 CONFIGURATION_CHANGED。宿主迁移需显式批准，确认无活动 lease、核查外部回执和 UNKNOWN，事务保留旧新配置身份、全部累计用量及审计关联；没有安全迁移实现时保留旧任务策略。不能借新 Task ID/Fork 抹掉旧消费。回滚使用旧有限任务/旧精确包；0.4.0 不能消费新无限策略，不把新版任务账本改回零。

每个逻辑模型请求最多额外一次：优先下一个备用；无备用时允许可恢复故障/已结束的超时请求重试当前模型；quota 且无备用不重试。原生 retry 同时启用返回 INVALID_REQUEST。取消、权限/账本/审计故障、无效输出不触发额外请求。模型单次超时先取消；当前事件循环中的 Promise 清理已完成才可重试，仍未结束则整次 run 停止并保留 lease，稍后才完成也不自动重发。

控制超时覆盖运行内授权、审计、账本、checkpoint、恢复核账/绑定、扩展 async hook、JSONL 文件操作与行读取、运行中队列控制。每次 IO 各自计时，不给 lane.drive 设置累计截止。无活动 run 的 create/list/history/fork 等管理入口没有任务 limits，仍由宿主控制访问、取消和运维等待；同步 CPU 阻塞须宿主隔离。通知 observer 不作执行门。文件/进程环境的 timeoutMs/maxFileBytes/maxOutputBytes 与任务累计策略无关。
