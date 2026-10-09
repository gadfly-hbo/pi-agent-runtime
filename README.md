# Pi Agent 接入基础包

跨产品统一接法与运行机制，业务能力按产品扩展。SDK 当前为 `0.4.0` Harness 本地交付版本，直接依赖 `pi-ai + pi-agent-core` **精确 0.86.1**，标准维持 v0.3。不可变包身份以 [0.4.0合同](docs/RELEASE-v0.4.md) 和冻结包收据为准。

原生持久会话、分支/恢复、Skills/模板、自动压缩、队列控制、工具与受限执行环境、观测扩展及条件模型能力均已接入共享层；[逐项台账](docs/NATIVE-HARNESS-COVERAGE.md) 列明配置、消费者和验证。JuanerAI 保留自己的终端与业务策略，等待固定包后采用；不包含 coding-agent 的终端、主题、命令系统或包管理。

## 当前交付与边界

持续任务使用 `createSessionRuntime`；[JSONL宿主合同](docs/NATIVE-SESSION-CANDIDATE.md) 明确专属根、独占写入、持久账本和恢复对账。普通 Worker/Text/Agent 保留，0.3.2 checkpoint 走兼容路径；新旧引擎不能同时拥有同一业务会话。历史冻结包不变。

已实现结构化 Worker、无工具文本调用、Pi 工具循环、可选并行工具与 thinking，以及逐次授权、任务累计配额、独立超时取消、审计门及合成回放。全部 Pi 类型/调用留在内部 Adapter；产品只用本包的中立类型。

`0.2.0` 增加可配置主备模型、同任务预算下的有界切换，以及可独立导入的简化 React 模型设置 UI。使用方法、兼容条件和验证限制见 [v0.2 接入说明](docs/RELEASE-v0.2.md)。UI 只依赖可选 React peer，不把浏览器、凭据存储或数据库强加给核心 SDK 消费者。

**基础包验证不等于真实产品接入成功。** 历史版本已完成独立候选评审及 MiniMax/Xiaomi 的有界合成 Provider 联调；MiniMax Worker 补测 3/3 通过，但此前失败原因仍为 UNKNOWN。见 [独立评审与联调记录](artifacts/review-v0.2/final-review-and-live.md) 和 [Worker 补测](artifacts/minimax-worker-2026-10-07/REPORT.md)（本机证据，不包含在历史 `.tgz` 中）。未迁移产品、建立远程仓库或上线。内存账本不能跨进程或崩溃恢复；工具函数不是沙箱，取消不能撤销已经发生的写操作。

先读唯一维护的 [跨产品接入标准 v0.3](docs/AGENT-RUNTIME.md)，再读 [宿主接点与采用步骤](docs/INTEGRATION.md)。模块边界见 [架构说明](docs/ARCHITECTURE.md)，证据与限制见 [验证记录](docs/VERIFICATION.md)。

接入标准 v0.3 的原则是“统一运行护栏，按任务选择自主程度”：模型可自主规划与选工具，模式和输出格式按任务选择，范围内预授权操作可自动执行。SDK `0.3.0` 实际开放并行、thinking 和 `runText`；默认仍串行、不请求 thinking，以兼容旧消费者，不是能力禁令。增量合同和验证范围见 [v0.3 说明](docs/RELEASE-v0.3.md)。历史评审与 Provider 联调不能代替新能力的真实模型验证。

## GitHub 与发行包

公开源码仓库：[gadfly-hbo/pi-agent-runtime](https://github.com/gadfly-hbo/pi-agent-runtime)。固定0.4.0包通过GitHub Release分发，校验值和筛选后的证据见 [公开发布收据](artifacts/public/v0.4.0/RELEASE-RECEIPT.json)。历史本机证据保留、不随Git公开；同步规则见 [GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md)。

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

运行此真实模型示例之前，必须单独批准 Provider、凭据、发送内容、预算及数据边界。可直接运行的完整离线示例在 [examples/offline.ts](examples/offline.ts)。交付入口是固定 SHA-256 的本地 `.tgz`；没有配置远程仓库或 npm 发布渠道。完整0.4.0验证不沿用历史 Provider预算或通过状态。

## 转发给产品开发 Agent 的接入 Prompt

新产品接入或老产品迁移都用下面这一段。填写前三项后，整段转发到目标产品的开发 session。它不替代目标项目的审批规则，也不授权修改共享基础包。当前文档与源码在本机目录；跨设备转发时同时提供可访问的材料和冻结包。历史 `.tgz` 不会因本次 README 更新自动改变。

```text
请为以下产品接入统一的 Pi Agent 基础包；已有 Agent 能力则按同一标准做最小迁移，不另造 Runtime。

产品仓库／工作树：[填写绝对路径]
本次接入范围与用户验收目标：[填写具体功能，不写“迁移所有产品”]
接入类型：[新产品接入／老产品迁移]

共享基础包本机路径：/Users/huangbo/Dev/Projects/pi-agent-runtime。
先完整读取 README.md、唯一维护的跨产品标准 docs/AGENT-RUNTIME.md（v0.3）、docs/INTEGRATION.md、docs/ARCHITECTURE.md、docs/RELEASE-v0.2.md、docs/RELEASE-v0.3.md、docs/RELEASE-v0.3.1.md、docs/RELEASE-v0.3.2.md，并核对 package.json、公共类型、实际导出及当前验证证据。当前观察到 SDK 0.3.2 候选，须在接收端重新核对；标准仍为 v0.3，历史 tgz 不因文档修改自动改变。后续原生 Harness 完整接入范围见 HARNESS-ROADMAP.md，不把规划当现有 API。跨设备须提供当前标准及对应版本 SDK 材料，不能仅凭历史冻结包推定文档已更新。历史记录不能覆盖当前合同，也不能把基础包 PASS 当作目标产品验收。路径不可访问时明确列出缺失材料，要求提供明确身份的对应材料，不从旧聊天补猜或回退到已废止文档。

1. 先只读核对目标项目规则、批准的产品/UI范围、当前基线、既有改动与兼容要求。定位实际 Agent 入口、模型配置、工具、凭据、任务状态、存储和测试。说明哪些可复用、哪些宿主接点必须补齐、允许修改的文件及验收命令；必要 Gate 未满足时只做接入评估，停在相应批准点。

2. 通过一个产品 Adapter/composition root 使用 pi-agent-runtime 的中立接口，保持业务 Core/Application/Port 独立。Pi 原生调用和类型只留在共享包内部 Pi Adapter；产品不直接 import Pi，不借用 pi-coding-agent 的包目录、认证、模型装配或会话。复用版本化包，不复制源码分叉。当前 SDK 候选 0.3.2，内部 pi-ai + pi-agent-core 均精确 0.86.1；核对冻结包的版本与 SHA-256，用产品自己的 lockfile 固定完整依赖树。0.86.x 不是精确锁定，升级另走候选验证与受影响消费者回归，保留旧包回滚。

3. 按接入标准 v0.3 的 P1～P6 选择任务模式，不默认所有任务都 Worker，也不预先写死 Agent 路径。runWorker 是无工具、单次模型阶段、JSON 解析加产品 validator；runText 是无工具文本入口，可选文本 validator；故障切换可能产生多次物理请求。runAgent 复用 Pi 的有界工具循环并返回文本；toolExecution 可选 parallel，单工具 executionMode:sequential 覆盖整批。thinkingLevel 可配置，所有主备模型必须声明已验证的 reasoning 能力；不静默降级、不扩大输出预算。旧调用默认串行且不请求 thinking。产品按任务验收，不把解释/创作/对话强制 JSON。业务语义、Analysis IR、证据、报告和状态继续归产品，模型结束不能代替业务完成或批准。

4. 模型由用户配置，不写死 MiniMax/Xiaomi。需要设置界面时，优先直接复用 pi-agent-runtime/ui 的 ModelSettingsPanel 和 pi-agent-runtime/ui.css；遵守目标产品 UI 合同，React/宿主不兼容先说明，不自行换技术栈。界面按 Provider 卡片、Base URL、API 格式、API Key、模型列表和添加/编辑弹窗呈现，一个主模型、至少一个有序备用。配置通过 pi-agent-runtime/settings 的校验与 compileSettings 被真实执行消费。仅接 SDK 已支持且已验证的协议/能力；当前支持 Anthropic Messages、OpenAI Chat Completions，Responses/智能推断不假装支持。

5. 在宿主落实五个接点：显式模型与 transport（含安全凭据解析）、任务级 Authorization、权威原子 BudgetStore、持久化 AuditSink，以及领域工具和适用的输出 validator。用户确认的任务/资源/动作/外发/预算/有效期范围内可自动执行预授权操作；每次仍检查授权，越界或未授权才请求决策，不给每次工具调用统一加弹窗。配置与密钥分开处理；密钥不上 Renderer、普通配置 JSON、localStorage、提示词或日志。同一业务任务使用稳定 taskId，跨请求/实例累计预算；有 cap/主备时实现 reserveModelUpTo。额度按任务需求配置；安全记录与正式内容证据按用途/风险分别处理，不全量保存敏感原文。当前审计失败仍停止，内存示例不能冒充持久化/恢复；写/外部动作落实幂等和未知效果处理，只读接入不增加写权限。

6. 主备严格复用 SDK 合同：仅可分类的 Provider quota/rate-limit/unavailable/network 故障有界切换，每次重新授权并共享同一任务账本；已完成工具结果继续被消费，不重复执行工具。任务预算耗尽、取消、授权/审计失败、结构校验失败等立即停止，不能借备用绕过。供应商账户额度与任务预算不同；不新增余额轮询、隐藏重试或“任何错误都切换”。配置保存不热换执行中任务，同 taskId 的配置/限制变更按合同拒绝。

7. 先合成、后获批真实验证、再获批启用：在目标产品真实入口做正/负向测试、适用的合成回放、消费者回归和任务质量评估，不只凭夹具全绿，也不要求自主 Agent 每次走相同合法路径。证明配置改变实际模型路由、非法配置在效果前拒绝、主备按顺序且预算累计、工具结果不重复执行、取消/未知效果不误报成功、授权/审计故障关闭后续效果、结构化输出严格校验、结果回链任务/运行/上下文版本。使用并行时验证每个工具独立准入、宿主预算原子性和部分失败；使用 thinking 时验证参数、签名续接、token 计量及跨 Provider 上下文外发许可。SDK 审计不保存内部思考；自定义 transport/合成 recorder 会接触完整续接块，禁止用于自动记录真实敏感内容。真实模型按拟启用用途验证，不强制无工具单次任务做完整工具联调。有 UI 时验证保存→执行消费和凭据保护；持久化另验原子性与崩溃未知状态。老产品保留合同、历史及回滚，分清运行成功、任务通过和正式启用。

8. 本次只授权填写范围内、且满足项目既有 Gate 的接入开发。依赖安装、真实 Provider 调用、真实业务数据、持久化迁移、部署、Git 发布和正式启用遵守目标项目的明确授权；未获授权就不执行。真实联调需另定 Provider/模型/凭据来源、合成输入、物理请求数/token/时间上限，未验证模型不进自动主备链。不要沿用共享包此前测试预算或从本机自动搜集凭据。

遇到业务范围、安全/数据外发、公开契约、不可逆迁移或新增成本决定时停下来，给最小选项让我决策。普通已授权实现细节自行闭环，不新增跨 Controller 审批。共享包缺能力时列出准确合同缺口，不私自修改共享仓库或在产品内绕过标准。

交付：接入位置与改动清单、精确依赖及包身份、配置实际消费与正/负向验证证据、宿主已落实/未落实项、迁移兼容与回滚方式、未验证项和下一授权点。未实现、未验证、未启用、未发布分别报告；不能只凭接口、截图或 hash 宣告产品接入完成。
```

## SDK0.3.1 compatibility candidate

Immutable per-task purpose plans support tool analysis and no-tool report phases under one budget. See docs/RELEASE-v0.3.1.md. Original0.3.0 releases and evidence are unchanged. Product adoption, live-provider verification and independent acceptance remain separate.

## SDK 0.3.2 检查点候选

新增中立 checkpoint、持久确认、业务等待和显式续接，合同见 [RELEASE-v0.3.2.md](docs/RELEASE-v0.3.2.md)。本机应用／读回证据在 [applied.json](artifacts/juanerai-checkpoint-20261009-001/applied.json)；该记录与历史合同中的当时状态分别保留。原生 Harness、Skills、自动压缩和完整原生恢复仍待接入，不能因包已固定而宣称 JuanerAI 生产入口已采用。
