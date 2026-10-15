# Pi Agent 接入基础包

跨产品统一接法与运行机制，业务能力按产品扩展。当前正式版目标为 **0.5.1**，由已接受的 `0.5.1-r1r4.3` 固定候选晋升；运行实现不变，独立正式包的发布及验证身份见 [0.5.1说明](docs/RELEASE-v0.5.1.md) 与 GitHub Release 附件。标准仍为 **v0.3**，Pi core/ai 精确 **0.86.1**，openai 精确 **6.40.0**。

原生持续会话、压缩、工具循环与 read 继续复用 Pi。R1–R4 的最终请求准入、安全错误/用量/物理状态、工具输出效果/回执及 read 失败载体见 [公共接入说明](docs/RELEASE-v0.5.1.md)。[能力台账](docs/NATIVE-HARNESS-COVERAGE.md) 分列历史机制证据与当前采用状态；没有新增 R5/R6、通用业务存储或第二运行引擎。

JuanerAI 已采用原固定候选 `0.5.1-r1r4.3`（146131 bytes，SHA256 `e02175ff42eaa83b994e6f49a1e041b4b3f0b9c807b0b8c192a7dfd836f70cce`），[PR #83](https://github.com/gadfly-hbo/JuanerAI/pull/83) 已合并至 `07f6ec36bd1efc275e89322384adef94440cdd03`。接受范围仅 R1–R4＋D1–D8 A 离线合成、显式 opt-in；原 Validator BLOCKED F-ROLE-01、技术 PASS、用户精确候选具名豁免分别保留。它不等于正式 0.5.1 换包采用、生产或全部产品能力验收；豁免不沿用于 SDK 发布评审。其他产品不自动升级。

## 当前交付与边界

持续任务使用 `createSessionRuntime`；[JSONL宿主合同](docs/NATIVE-SESSION-CANDIDATE.md) 明确专属根、独占写入、持久账本和恢复对账。普通 Worker/Text/Agent 保留，0.3.2 checkpoint 走兼容路径；新旧引擎不能同时拥有同一业务会话。历史冻结包不变。

已实现结构化 Worker、无工具文本调用、Pi 工具循环、可选并行工具与 thinking，以及逐次授权、任务累计配额、独立超时取消、审计门及合成回放。全部 Pi 类型/调用留在内部 Adapter；产品只用本包的中立类型。

`0.2.0` 增加可配置主备模型、同任务预算下的有界切换，以及可独立导入的简化 React 模型设置 UI。使用方法、兼容条件和验证限制见 [v0.2 接入说明](docs/RELEASE-v0.2.md)。UI 只依赖可选 React peer，不把浏览器、凭据存储或数据库强加给核心 SDK 消费者。

**基础包验证不等于真实产品接入成功。** 历史版本已完成独立候选评审及 MiniMax/Xiaomi 的有界合成 Provider 联调；MiniMax Worker 补测 3/3 通过，但此前失败原因仍为 UNKNOWN。见 [独立评审与联调记录](artifacts/review-v0.2/final-review-and-live.md) 和 [Worker 补测](artifacts/minimax-worker-2026-10-07/REPORT.md)（本机证据，不包含在历史 `.tgz` 中）。这些验证不证明产品迁移或上线。内存账本不能跨进程或崩溃恢复；工具函数不是沙箱，取消不能撤销已经发生的写操作。

先读唯一维护的 [跨产品接入标准 v0.3](docs/AGENT-RUNTIME.md)，再读 [宿主接点与采用步骤](docs/INTEGRATION.md)。模块边界见 [架构说明](docs/ARCHITECTURE.md)，证据与限制见 [验证记录](docs/VERIFICATION.md)。

接入标准 v0.3 的原则是“统一运行护栏，按任务选择自主程度”：模型可自主规划与选工具，模式和输出格式按任务选择，范围内预授权操作可自动执行。SDK `0.3.0` 实际开放并行、thinking 和 `runText`；默认仍串行、不请求 thinking，以兼容旧消费者，不是能力禁令。增量合同和验证范围见 [v0.3 说明](docs/RELEASE-v0.3.md)。历史评审与 Provider 联调不能代替新能力的真实模型验证。

## GitHub 与发行包

公开源码仓库：[gadfly-hbo/pi-agent-runtime](https://github.com/gadfly-hbo/pi-agent-runtime)。0.5.1 通过 GitHub Release 分发，校验值与筛选证据见 [发布材料](artifacts/public/v0.5.1/RELEASE-NOTES.md)。不发布 npm；所有历史固定包及收据保留。历史本机证据保留、不随Git公开；同步规则见 [GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md)。

## 本地检查

已验证工具链：Node 24.21.0、npm 11.19.0。先固定工具链，再运行：

```sh
npm ci --ignore-scripts
npm run verify
npm run example
npm run verify:package
```

依赖安装需宿主授权。这里没有调用真实模型的测试命令；`example` 与测试仅用合成数据。显式完整验证还运行临时文件/本地OS沙箱与loopback HTTP，命令见0.4.0合同。

## 产品消费形态

```ts
import {createRuntime, createPiTransport} from 'pi-agent-runtime';

// 在产品 composition root 装配；以下变量均由宿主提供，不在 SDK 内发现。
const runtime = createRuntime({
  model: approvedModel,
  transport: createPiTransport({model: approvedModel, apiKey: explicitCredential}),
  budgets: hostAtomicBudgetStore,
  authorize: hostTaskAuthorization,
  audit: hostDurableAuditSink,
  onEvent: hostUiObserver,
});
const result = await runtime.runWorker({
  taskId: stableTaskId, prompt: approvedPrompt,
  system: approvedContext, contextVersions: {semantic: semanticVersion},
  limits: {modelCalls: 2, toolCalls: 0, outputTokens: 2048, resourceUnits: 2, wallTimeMs: 30000},
  validate: validateProductOutput,
});
 // result.status === 'succeeded' 只表示此运行合格；不自动提交报告或批准业务决策。
```

模式与可选能力：

```ts
await runtime.runText({taskId: textTaskId, prompt, limits}); // 不要求 JSON；可加文本 validator
await runtime.runAgent({
  taskId: agentTaskId, prompt, limits, tools,
  toolExecution: 'parallel', thinkingLevel: 'low',
});
// tools 中任一工具声明 executionMode:'sequential' 时，该批次保持串行（Harness适配补足原生逐工具覆盖差异）。
// thinking 须所有候选 ModelConfig.reasoning:true，并由宿主确认该模型的实际支持能力。
```

thinking 的协议续接块不进入普通审计或最终答案；跨模型时 Pi 可能把未屏蔽思考转换为文本上下文，宿主每次模型授权必须覆盖这部分外发。并行不是事务，已启动的效果不能因同批失败而撤销。当前设置 UI 保留宿主声明的 reasoning 能力，但不提供任务级并行/thinking 开关；这些由产品任务策略选择，不增加配置页面复杂度。

运行此真实模型示例之前，必须单独批准 Provider、凭据、发送内容、预算及数据边界。可直接运行的完整离线示例在 [examples/offline.ts](examples/offline.ts)。交付入口是固定 SHA-256 的本地 `.tgz`；现已通过 GitHub Release 分发；未发布到 npm 注册表。完整0.4.0验证不沿用历史 Provider预算或通过状态。

## 转发给产品开发 Agent 的接入 Prompt

使用 [0.5.1 接续 Prompt](docs/PRODUCT-ADOPTION-v0.5.1.md)。它提供接收顺序及停止点，不授予产品升级、生产启用或真实 Provider 调用。跨设备交付必须同时提供固定包与完整校验材料；可变源码不是消费入口。

## 历史版本记录（按当时时点阅读）

## SDK0.3.1 compatibility candidate

Immutable per-task purpose plans support tool analysis and no-tool report phases under one budget. See docs/RELEASE-v0.3.1.md. Original0.3.0 releases and evidence are unchanged. Product adoption, live-provider verification and independent acceptance remain separate.

## SDK 0.3.2 检查点候选

新增中立 checkpoint、持久确认、业务等待和显式续接，合同见 [RELEASE-v0.3.2.md](docs/RELEASE-v0.3.2.md)。本机应用／读回证据在 [applied.json](artifacts/juanerai-checkpoint-20261009-001/applied.json)；该记录与历史合同中的当时状态分别保留。原生 Harness、Skills、自动压缩和完整原生恢复仍待接入，不能因包已固定而宣称 JuanerAI 生产入口已采用。
