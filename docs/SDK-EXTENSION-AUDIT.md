# 共享 SDK 非原生能力与 Pi Harness 冲突审查

本文件主体保留首次审查时点；下述“仍需接线”不是0.4.0当前状态。当前完整接线与验证见 RELEASE-v0.4.md / NATIVE-HARNESS-COVERAGE.md。

日期：2026-10-09。用户要求：把共享 SDK 中非 Pi 原生、由 JuanerAI 接入需要补入的能力单独核对；冲突的调整，补充的保留。本轮使用 agent-architecture-audit 的源码／机制核对方法，范围为共享层与产品 Adapter，不评审无关 UI 或业务算法。

## 结论与本轮实际调整

最主要的重叠是 **0.3.2 检查点中重新构造消息、模拟旧模型输出、补回已完成工具结果并推进剩余调用**。这在旧 Agent 接口下实现了续接，但不应继续发展为与原生 Session／Operation 并行维护的恢复引擎。

用途集合、任务授权、预算、审计、业务等待及外部回执不是可直接删掉的重复代码。原生配置、Usage、事件、终止状态不能替代这些业务／资源权威。

本轮已调整普通运行入口：`createRuntime → drive → AgentHarness.create`，内部使用原生 `Models + MemorySessionRepo`。现有 `checkpoint / saveCheckpoint / shouldYield` 请求明确保留旧兼容路径，避免在没有迁移合同的情况下破坏旧检查点。没有创建第二个工具循环；授权／预算／审计继续在 src/index.ts 的实际模型及工具效果边界执行。

这是运行主干的第一步，**不是完整持续 Harness 接入或 JuanerAI 生产采用完成**。当前普通请求仍为每次新建临时 Session；自动压缩／retry 明确保持旧单次合同的关闭状态。持续 Session、原生恢复、Skills、压缩及执行环境仍需继续接线。

## 来源与证据身份

- 0.3.1 新增用途合同：[RELEASE-v0.3.1.md](RELEASE-v0.3.1.md)，对应 [change-manifest.json](../artifacts/juanerai-purpose-20261009-001/change-manifest.json)。
- 0.3.2 新增检查点合同：[RELEASE-v0.3.2.md](RELEASE-v0.3.2.md)，对应 [manifest.json](../artifacts/juanerai-checkpoint-20261009-001/manifest.json)。历史文件不重写。
- 本轮改动前源码：[baseline.json](../artifacts/native-harness-implementation-20261009-001/baseline.json) 与同目录 preimage；SDK 版本字段仍为 0.3.2，源码有本轮未发布增量，不能当作原 0.3.2 冻结包交付。
- 当前 Pi 源码精确 0.86.1；本轮检查与测试使用实际安装树。
- Mini 只读核对：`/Users/bendandebaba/.codex/worktrees/n01-n02-browser-membership/JuanerAI`，分支 `work/mac-mini/n01-n02-browser-membership`，HEAD `037e3f8fd8e694000428d65384a545879f1d6f9a`，生产 Adapter／service-main／依赖有既有未提交改动。本轮未写该工作树、未联系其他会话。

## 分项处置

| 项目／来源 | 与原生能力的关系 | 处理结论 | 证据与后续验证 |
|---|---|---|---|
| 固定用途集合 purposes（0.3.1） | 补充。原生模型／工具配置 setter 不定义“同一个业务 Task 允许哪些用途，以及共用什么预算” | 保留；原生配置只能选择当前 Task 已声明的用途，不因换 Lane／Fork 改权或提额 | src/types.ts PurposeConfig；src/index.ts purposePlan／claim；tests/purpose.test.ts |
| BudgetStore／BudgetLease（既有 SDK） | 补充。Pi Usage 是运行观察，缺少宿主原子额度预留、跨 Run 配额权威 | 保留；所有主／备用／retry／压缩／摘要／deferred 物理请求都接同一账本 | src/budget.ts、src/index.ts 模型／工具预留；原生 recordUsage 不能作为余额 |
| historicalUsage／SQLite 持久预算（Mini） | 补充，而且不在共享 src 中；产品保存历史消耗及 UNKNOWN 是合法宿主责任 | 保留在产品；不得搬入 Pi Session 或换 Task 绕过。原生恢复前仍需核账 | Mini adapters/agent-pi/persistent-runtime-state.ts historicalUsage／claim；产品 17 项检查是用户报告，本轮未重跑 |
| Authorization 模型／工具／发布门（既有 SDK） | 补充。原生 Hook 提供扩展点，不提供任务权限权威；部分 Hook 捕获异常后继续 | 保留实际效果边界检查，不仅注册 Hook；队列／恢复也需覆盖 | src/index.ts authorize／effect；core harness/hooks.js beforeRequest／transformContext |
| AuditSink 与安全事件（既有 SDK／Mini 持久化） | 补充。Pi Session／Telemetry 包含协议／运行内容，不等于可靠业务审计 | 保留；安全 metadata 与获准内容订阅分开；不得写两份相互竞争的完成权威 | src/index.ts append；Mini persistent-runtime-state.ts audit；现有审计故障／隐私回归 |
| 独立超时、迟到拒绝、lease 释放（既有 SDK） | 补充。原生取消协作式，不能强杀任意 JS 或自动撤销外部动作 | 保留；与原生 Context.abortSignal 对接，区分 API 返回与物理空闲 | src/index.ts controller／physical／waitForIdle；tests/runtime.test.ts、conformance.test.ts |
| 主备路由（既有 SDK）与原生 retry | 有交叉，直接叠加会放大尝试数，但路由业务语义不同 | 保留显式有序主备；原生 retry 开放前必须定义组合次序并覆盖每次物理计量。当前普通入口显式关闭 native retry，未宣称该项完成 | src/index.ts candidateIndex；core harness/config.js 默认 retry=3；fallback 回归 |
| ModelTransport／中立消息（既有 SDK）与原生 Models | 适配补充，但当前公共内容仅 text／tool／reasoning，不能代表原生完整多模态与 deferred 能力 | 保留中立边界；内部用 Models 桥接，后续扩展公开内容契约，不能静默丢内容或伪装协议全覆盖 | src/pi-adapter.ts createModels／stream；src/types.ts ModelContent／ModelConfig |
| ConversationCheckpoint 的消息保存与恢复（0.3.2） | **高风险重叠**。自定义 pending／replay／restoredResults 已承担一部分 Session／Operation 恢复责任；若与 native Session 同时写同一任务，会有双状态源 | 保留旧版本兼容读取和执行；新持续会话以 native Session 为协议权威，迁移后停止旧消息引擎写入；不能直接删除历史表或清未知状态 | 改动前 pi-adapter.ts:109–145 及后续 replay；当前 driveCheckpoint；native Session／Operation／tool invocation |
| tool-admitted 标记与 saveCheckpoint 确认（0.3.2） | 混合。可靠确认／未知效果防重放须保留；整段对话快照不是新的主线恢复状态 | 未来拆成宿主效果准入／回执对账与 native Session 提交；不维持两份全量会话，不承诺跨库原子提交 | docs/RELEASE-v0.3.2.md；tests/checkpoint.test.ts；原生 recoverToolInvocation 绕过 before_tool 的 safe 路径 |
| shouldYield／waiting（0.3.2） | 补充。澄清等待是产品状态；native operation completed／aborted 不是业务完成或业务取消 | 保留业务等待语义；迁移时在原生工具边界停靠并返回中立等待，不能用 abort 冒充等待 | src/types.ts RunResult；tests/checkpoint.test.ts business waiting／部分工具批次续接 |
| checkpoint 串行限制（0.3.2） | 当前兼容合同。原生支持并发及独立 invocation，不能把此限制永久套到所有持续任务 | 旧检查点限制保留；native 新合同单独验证并发、部分完成和未知效果再开放 | src/validation.ts validateCheckpoint；tests/checkpoint.test.ts parallel negative case |
| Mini 手工补跑 pending tools、new Agent、continue | 与目标原生 Operation 推进重叠；目前仍在产品生产路径，不是在共享 SDK 内 | 在产品 Adapter 采用 native 门面时替换；保留业务工具语义和回执，不在产品再写一层消息恢复 | Mini adapters/agent-pi/open-analysis.ts；apps/browser/service-main.ts:51 仍调用旧工厂 |
| JuanerAI 专业 Skills／Prompt 内容 | 专业内容是产品资产，不是基础包重复机制；原生加载和调用机制应替换当前简化承载 | 内容保留／迁到原生 Skills，产品界面保留；不把内容本身移入共享包 | 先前核对的产品 open-analysis-methods；本轮未修改产品内容，不以其存在宣称原生 Skills 已接通 |

## 本轮发现并已修的原生兼容差异

### 高：单工具 sequential 在 Harness 中没有按旧 Agent 合同约束整批

首轮实际接线后的 `PT01: a sequential tool overrides parallel batch` 失败：最大同时效果数实际 2，原合同要求 1。精确源码 `harness/runtime/drive/tools.js` 的选择只读取 `run.settings.toolExecution`，未使用工具的 `executionMode`。

处理：模型输出整批校验后，仅当实际请求的工具包含 sequential 声明时，在工具效果边界串行准入。未被选中的 sequential 工具不拖慢其他批次；下一普通批次恢复并行。原生 Harness 仍负责工具调度、状态、结果及循环；这不是另造会话引擎。新增 HN02 验证三批的真实并发峰值为 2／1／2。

### 中：原生终止分类会把 Provider 截断映射为 MODEL_FAILED

首轮 `R01: worker rejects invalid JSON and provider truncation` 失败：返回 MODEL_FAILED，旧合同要求 INVALID_OUTPUT。截断不是可以切备用的供应商故障。

处理：在已计量的模型回复转换边界将 length 明确拒绝为 INVALID_OUTPUT，保留原断言，阻止后续工具和成果发布。

## 验证与未完成项

- 改动前基线：108/108 通过，日志 baseline-tests.log。
- 首轮 native 接线：106/108，通过／失败全文保留在 native-tests-001.log；未删除失败。
- 修复两项兼容差异后：108/108 通过，日志 native-tests-002.log。
- 新增 HN01：通过公共 createRuntime 真实调用原生 AgentHarness.create、执行工具、消费结果并累计两次模型／一次工具；不是静态 import 检查。
- 新增 HN02：串行覆盖仅影响实际选用工具的那一批。
- 最终类型／回归／构建／UI 检查以同目录 verify-003.log 实际结果为准，不能把它解释为完整 Harness 验收。

持久 Session、分支／恢复、Skills／压缩、执行环境、公开内容契约、独立评审、JuanerAI 生产切换和真实模型：尚未完成。本次没有将新源码打成旧 0.3.2 包，也没有修改历史证据或生产数据。

## 0.4.0 后续处置

持续会话、压缩、Skills、队列、观测、执行环境、公开内容/条件能力已接通。旧checkpoint仅兼容保留，新任务以原生Session为协议权威；业务预算/审计/用途/回执保留。新增补充仅针对已举证原生缺口：队列业务所有权、重启批次串行覆盖、专属根独占、受限环境、proxy拒绝重定向。共享层不引入JuanerAI业务状态或复制分析IR。产品生产旧代码的替换由Mini采用包后实施，本轮未写产品。
