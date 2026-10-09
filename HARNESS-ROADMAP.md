# Pi 原生 Harness 完整接入路线图 v0.2

日期：2026-10-09。状态：**完整接入方向已获用户批准；具体公共／持久化合同仍按第 8 节标识。** SDK 当前为 0.4.0 Harness 本地交付版本，Pi 两项直接依赖精确 0.86.1，接入标准继续为 [v0.3](docs/AGENT-RUNTIME.md)。

当前本地源码已包含完整共享 Harness 接线；最终发布身份见 docs/RELEASE-v0.4.md 及冻结收据；0.3.2 冻结包和检查点兼容合同保持原样。非原生补充与重复机制的处置见 [SDK 扩展审查](docs/SDK-EXTENSION-AUDIT.md)。

本仓库维护跨产品共享机制；JuanerAI 是分析与决策 Agent，已有自己的终端与交互。本次不建设 pi-coding-agent 的终端、主题、交互命令或包管理系统，不借用其代码目录、认证、会话或 Skills。

本版替代 v0.1 的“先以最小会话闭环作为交付重点，Skills／压缩以后再补”的路线。旧版及本轮改动前材料完整保留在 [preimage](artifacts/native-integration-20261009-001/preimage/HARNESS-ROADMAP.md)，历史合同、失败和 PASS 不改写。旧版第 11 节只读转发 Prompt 不再代表当前推进授权。

## 1. 已批准的目标与完成定义

**完整接入 Pi 原生 Harness 能力，产品特殊需求有具体缺口证据后再扩展。**

用户确认的边界：

- 每项原生公开能力有接入位置、配置方式、产品消费者与实际验证结果；接口存在或一个演示运行成功不能结项。
- Skills 使用原生机制承载 JuanerAI 专业内容；自动压缩必须在持续任务中真实触发并被后续执行消费。
- 会话、分支、恢复优先使用原生机制；兼容替换现有实现，保留业务数据和历史证据。
- 授权、预算、审计在原生执行边界落实；业务权威归宿主，不为护栏再写会话引擎。
- 文件、进程、网络等执行能力完成接线，按任务授权开放。可用能力集合与某次任务的权限集合分别管理。
- JuanerAI 决定如何使用、如何控制、如何验收；自身终端、语义、Analysis IR、业务数据及决策流程继续归产品。

这不是要求产品逐个直接 import Pi 类型，也不是把所有权限默认打开。共享 SDK 提供完整、中立、可配置的运行能力，内部复用 Pi。

## 2. 当前实际基线

| 项目 | 当前证据与状态 |
|---|---|
| SDK／直接依赖 | package.json、package-lock.json：0.4.0；pi-ai／pi-agent-core 均为 0.86.1；未发布 |
| 当前运行入口 | src/index.ts → src/pi-adapter.ts：普通运行已装配 AgentHarness.create＋临时 MemorySessionRepo；checkpoint／saveCheckpoint／shouldYield 保留旧 Agent 兼容路径 |
| 现有可复用护栏 | 模型／工具／发布授权、任务累计 BudgetStore、AuditSink、主备、停止与迟到结果栅栏；保留 |
| 0.3.1 | 创建时固定用途集合，同一业务 Task 共用预算；保留旧无 purposes 消费者 |
| 0.3.2 | 中立 checkpoint、持久确认回调、business waiting、显式 resume；不等于原生 Session／Harness 已接通 |
| 当前证据 | artifacts/juanerai-checkpoint-20261009-001 的 applied.json、verify001.log／exit、package001.log／exit；历史执行记录，不是本轮独立评审 |
| 原生能力 | 已读精确安装版本的导出、声明及关键执行源码；见[能力台账](docs/NATIVE-HARNESS-COVERAGE.md)及[导出快照](artifacts/native-integration-20261009-001/native-exports.json) |
| 产品采用 | 用户提供 Mini 状态：SDK 已固定、历史预算／持久检查点及 17 项检查完成；生产 Adapter 和真实双模型补验未完成。不能称 JuanerAI 已完整采用 |
| 仓库 | 尚无 Git HEAD，已有文件均为未跟踪工作；本轮不提交、不清理、不覆盖既有源码 |

0.3.2 checkpoint 是有价值的兼容成果，不删掉后从零重做；也不能继续把消息重放补成第二个长期会话引擎。

## 3. 责任分层

```text
JuanerAI 自有终端 / Application / 业务 Port
  专业 Skills 内容、语义与 Analysis IR、任务授权策略、预算权威、业务结果验收
                         ↓ 产品 Adapter
pi-agent-runtime 中立门面
  完整能力装配、配置快照、实际效果准入、账本与审计接缝、兼容迁移
                         ↓ 内部 Pi 桥接
pi-agent-core AgentHarness + 原生 Session / Skills / compaction / tools
pi-ai Models / 模型协议 / 流式内容 / 用量
                         ↓ 宿主执行环境与明确凭据
```

SDK 实施宿主策略；宿主决定资源、授权、额度、保留与业务完成。Session 保存协议上下文，业务状态和预算归产品，长期 Memory 独立。原生 Usage／事件／摘要均不能替代业务账本、正式证据或授权。

## 4. 完整能力范围

逐项接线、配置、预期产品消费者和验收见 [NATIVE-HARNESS-COVERAGE.md](docs/NATIVE-HARNESS-COVERAGE.md)。正式能力分为：

1. Agent／Harness 持续执行、Operation 准入及推进、取消与空闲检查。
2. Session 存储、查阅、命名、标签、Lane、分支、Fork、导航、恢复。
3. 原生 Skills、Prompt Templates、上下文装配、协议消息和多模态内容。
4. 自动／手动压缩、分支摘要、辅助模型调用。
5. steering／follow-up／nextRun、队列取消与消费。
6. 模型选择、thinking、工具集、串并行、retry、流配置与资源配置。
7. 工具注册及执行、原生 read／write／edit／bash、ExecutionEnv 与输出限制。
8. Hook、事件、观察快照、用量、Telemetry、错误与状态转换。
9. 原生存储一致性测试能力，以及特定 Provider 的 deferred／proxy 等条件能力。

所有正式公开能力都须有结论。实验入口、仅有接口的搜索能力、辅助类型和底层存储操作分别记录用途；不把重复导出／类型别名当独立产品功能，也不私自用实验引擎替代正式 Harness。

## 5. 实施顺序与交付包

分包是依赖顺序，**不是降低最终目标**。中间合成闭环不能称“完整接入完成”。

| 包 | 实施内容 | 完成条件 |
|---|---|---|
| H0 基线及合同 | 导出面、现有 Adapter、原生行为、能力台账、中立门面与重大决策 | 接线与缺口可定位；未决合同显式列出；不宣称产品采用 |
| H1 原生执行主干 | AgentHarness.create、Models 桥接、原生 Session／Lane／Operation；复用授权、预算、审计、主备、停止；保留旧入口 | 所有模型与工具物理调用经权威账本；真实工具结果被后续模型消费；旧消费者回归 |
| H2 持续任务完整能力 | 与 H1 连续实施 Skills、模板、自动／手动压缩、分支摘要、队列、Fork／导航、磁盘续接与重启恢复 | 同一个持续任务实际加载专业内容、触发压缩、切分支及恢复；不能分别只做孤立 Demo |
| H3 完整执行环境 | 原生工具工厂与受限 ExecutionEnv；文件、进程、网络边界、真实停止、资源上限 | 允许动作真实完成；越界零效果；取消后进程树退出。开放生成代码时与该能力同期交付 |
| H4 JuanerAI 生产采用 | 产品 Adapter／composition root、专业 Skills 内容、业务等待／续接、Analysis IR 与终端消费 | 真实产品入口使用新主干；旧行为兼容；业务质量和获批 Provider 验收通过 |

最早产品开发接入点是 H1 的稳定候选；可并行做产品 Adapter，但须明确剩余 H2/H3，不能宣布完整采用。完整接入结项需要 H1～H4 的适用正式能力均有验收，启用范围由产品配置体现。

长期记忆、多 Agent、中央网关和企业平台仍由真实缺口触发；它们不因本次完整 Harness 目标而自动成为新平台建设任务。

## 6. 中立公共门面与内部桥接草案

以下是待具体合同确认的设计，不是已存在的 SDK API：

| 公共能力组 | 中立表达及所有者 | 内部复用 |
|---|---|---|
| 会话管理 | SDK 返回不透明会话／分支引用；宿主指定存储根及访问策略；创建、列出、打开、关闭、Fork、标签及历史查询 | JsonlSessionRepo／StorageBackedSession、SessionRepo、AgentHarness.lane |
| 执行与控制 | 每次绑定稳定 taskId、purpose、limits；提交／检查／显式恢复／取消、steer／followUp／nextRun；结果沿用业务成功、等待、失败的区别 | accept／drive／inspectExecution／resume／abort、原生队列 |
| 资源与上下文 | 中立 Skill／模板资源描述、来源版本、运行配置；专业内容由产品提供 | loadSkills／loadSourcedSkills、模板加载、resources、systemPrompt、entryProjectors |
| 压缩与导航 | 可配阈值和近期保留量、手动操作及摘要约束；执行时必须绑定 Task | compact／navigateTree、原生 compaction／branch summary |
| 工具与环境 | 沿用领域工具和执行策略；中立受限文件／进程环境装配选项 | AgentHarnessTool、原生工具工厂、ExecutionEnv |
| 观测 | 安全运行事件与获准内容订阅分开；中立状态／引用，不透传 Pi 对象 | watch／watchSession／events／Telemetry／reducer |

模型桥接必须解决当前 ModelTransport（一次请求返回 ModelReply）与原生 Models（目录、stream／complete、deferred）的差异。主执行走 streamSimple，压缩／分支摘要会走 completeSimple，deferred 有独立请求路径；全部落实实际请求准入、逐次计量、异常分类、取消、用量结算，不能只包主对话方法。保留显式凭据，不因装配 Models 而自动刷新目录、登录或发现本机认证。

关键原生行为和处理：

- 原生 retry 默认 enabled／maxRetries=3，compaction 默认 enabled，Harness 工具默认 parallel；旧 SDK 默认串行。配置必须显式装配，并纳入不可变任务配置，不能升级后暗增调用或权限。
- H1 过渡时未覆盖辅助通道可显式关闭；H2 验收必须真实开启自动压缩。retry 也需成为受预算约束的可用能力，不能永久关掉后宣称完整接入。
- before_request／transform_context Hook 异常会报告后继续。安全拒绝放在实际 Models／工具执行边界，Hook 只作扩展或早期检查。
- 原生 safe 工具恢复路径可能直接调用执行器，不经过 before_tool；工具执行器仍需逐次检查权限和账本，不能仅凭 replay:safe 自动重放。
- 配置 getter／setter 能力通过门面接通；同一 Task 仍只能选择已声明用途内的配置，不能热改模型、工具或限额。新任务可按宿主批准的新配置装配。
- 原生 Session 与产品账本没有跨库原子事务。以 Operation／invocation 稳定身份对账；效果前可靠准入／预留，效果后可靠回执／结算。崩溃窗口保留未知状态；不能清 marker、重置 lease 或换 taskId 继续花费。

## 7. 验收：证明实际消费

每项记录版本、输入、观察、负例、结果、限制和消费者；NOT_RUN 保持 NOT_RUN。

- **执行与 Skills**：更换已批准 Skill 内容会改变实际任务行为；目录／hash 存在不算消费。停用、未知来源、版本漂移和恶意越权指令拒绝或被权限边界拦截。
- **持续压缩**：实际达到阈值并产生原生摘要；后续模型消费摘要，任务约束、数据／语义版本、未决事项和可读证据仍有效。主调用、压缩、导航摘要和失败重试共用配额。
- **会话与分支**：连续多轮、Fork 和导航改变后续真实上下文；隔离其他分支，保留历史，且不复制权限、不刷新预算。
- **磁盘／进程**：第一进程执行工具并落盘，退出后第二进程打开，检查账本／授权后继续且消费前次结果。覆盖并发写入、完整坏行、撕裂尾行和升级写入；JSONL 修尾不等于断电耐久承诺。
- **故障注入**：在预算预留后、效果后回执前、Session 提交后结算前、取消／审计失败时中断。恢复不重复未知副作用、不误报成功、不退还未知消耗。
- **安全和成本负例**：撤销授权、耗尽预算、配置错配、Hook 失败、恢复工具、队列消费、主备及辅助通道均验证；拒绝后零新增效果。
- **执行环境**：路径穿越、绝对路径／符号链接、网络越权、挂起、输出／资源耗尽和子进程残留；受限环境不可用时不能退到 unrestricted NodeExecutionEnv。
- **消费者与质量**：独立旧 Worker／文本消费者、新持续会话消费者、打包类型消费；再从 JuanerAI 真实产品入口验证专业任务质量。Provider 验证按获批模型／用途单独执行。
- **JuanerAI 专项**：Analysis IR 真实改变工具及参数；版本错配在效果前拒绝；结果回链真实消费的计划／语义／数据和证据；业务等待、重分析及决策批准遵守产品合同。

## 8. 决策台账：已批准方向与尚未冻结的合同

用户已批准完整原生能力、原生优先、产品策略、按任务授权、兼容保留及缺口先举证。这些不再重复请求批准。下表只对尚未确定的具体公共／持久／安全边界保留决定，不设置新的 Controller 审批环节。

| 项号／主题 | 推荐、原因与备选成本 | 用户决定／状态 |
|---|---|---|
| D1 能力所有者 | SDK 提供完整机制；JuanerAI 提供分析决策策略及终端；Pi 类型封装在 Adapter | 已确认；中立API已实现于src/types.ts，产品不导入Pi |
| D2 持久后端／读写 | 首个后端复用 JSONL＋StorageBackedSession，显式产品专属根、每 Session 单写入者；创建／打开／列出／Fork／删除由门面授权。备选官方 SQLite 后端要增加依赖、兼容和迁移验证 | 2026-10-09 用户已批准 JSONL 首版；产品显式专属目录、访问/保留及单写入者，见 docs/NATIVE-SESSION-CANDIDATE.md |
| D3 粒度／身份／基数 | Session 保存协议，Task 是授权预算单位，Run／Operation／invocation 保持映射；建议 Session 可承载多个依次绑定的 Task，一个 Task 可有多次 Run；分支不产生新授权。备选一 Session 一 Task 简化映射但限制持续业务 | 已落实多次Run/依次Task、宿主Operation绑定和专属根独占；残留队列固定Task/purpose |
| D4 保留／读取／删除 | 宿主必须显式提供内容许可、访问和保留策略；SDK 不自行选用户全局目录或自动过期。关闭不删除，删除 Session 不清业务审计。备选只存引用会增加协议重建约束 | 用户已批准宿主显式访问/保留策略；SDK 不隐式清理，真实产品策略待接线 |
| D5 恢复／未知效果 | 打开仅检查；推进前核对当前授权、持久预算及回执；未知副作用阻断重放。建议复用现有权威账本补必要对账字段。备选仅浏览不能满足完整恢复目标 | SDK回调/写入顺序/未知拒绝已落实；产品回执字段由既有账本接线 |
| D6 辅助请求／动态配置 | 主调用、retry、主备、摘要、deferred 物理请求共用权威 Task；用途集合创建时固定；不隐藏刷新和重试。备选独立辅助账本增加一致性成本，不推荐 | 已落实固定配置、每次deferred计量；先路由再原生retry，未知预留不退 |
| D7 Skills／执行环境 | 原生 Skills 承载专业内容，宿主指定来源版本；原生工具对接受限环境，由任务授予文件／进程／网络权限。备选任意本地来源或宿主无限执行成本／风险更高 | SDK原生可信源加载及受限单进程环境已实现；产品内容、丰富环境及具体权限待采用配置 |
| D8 兼容迁移／回滚 | 旧 Worker／文本／0.3.1 用途和 0.3.2 checkpoint 保留；新任务可选 Harness；旧任务先对账，迁移另批。回滚固定旧包，保留新旧历史与已发生消耗；不向旧引擎强塞新 Session 格式 | SDK兼容/回滚合同已落实；旧任务实际迁移待产品核账，不承诺跨Pi版本格式 |

具体公共类型、持久字段、默认／可空语义、所有者 epoch／去重键在实施相应结构前形成完整增补；不能把方向批准解释成任意生产迁移批准。普通内部适配、测试及已确认合同内实现自行闭环。

## 9. 当前推进边界与下一包

用户要求一次完成完整Harness，Mini暂停接入等待共享包。0.4.0共享机制已实现：见 RELEASE-v0.4.md、能力台账及完整验证证据。源码完整验证与独立复审已通过，按固定收据发布不可变本地tgz并交付采用说明；产品生产接线/真实双模型/质量Gate由Mini采用后完成。

允许路径：本仓库 src／tests／examples／docs／tools 和新的候选证据；具体持久结构依第 8 节决定。保留历史 artifacts、发布合同和当前 0.3.2 checkpoint 证据。用户已确认：Mini 暂停相关接入开发，待共享 SDK 全部完成并发布后，由 Mini 接入。JSONL 首版方案已批准；当前仓库继续实施，不写 Mini 工作树或联系其他 session。共享 SDK 发布已获此范围授权，须完整候选验证后执行；依赖安装、Provider 调用、真实数据访问、生产迁移/启用、部署或服务操作仍需对应授权。

独立只读评审在实现候选固定后安排，不能把作者自测称作独立评审；已按用户授权安排独立只读Validator；首次NEEDS_FIX与修复复审分别保留，不联系Mini或其他产品会话。

## 10. 本轮证据与状态口径

[baseline.json](artifacts/native-integration-20261009-001/baseline.json) 固定改动前源码／配置身份。[inspect-exports.mjs](artifacts/native-integration-20261009-001/inspect-exports.mjs) 只读取已安装声明，输出所有导出路径、符号、类型／值类别、声明位置与源码 hash；不导入 Pi 运行时、不发现凭据、不建会话、不调用 Provider。

建议、待决定、已实现、已验证、未知、未启用、未发布分别记录。完整导出快照只证明已核对原生表面，不能证明接线、执行或产品采用。

## 11. 已批准 JSONL 首版的本地实施增量

见 [原生会话合同与证据](docs/NATIVE-SESSION-CANDIDATE.md)。已接通原生磁盘 Session、Task/Operation/Invocation 中立关联、恢复核查、Fork/历史、Skills/模板、手动/自动压缩和有界 retry；Worker/Text 与原生 Session 使用同一 immutable-purpose 任务账本。新增合成进程测试不表示生产采用；完整接线台账已更新到0.4.0。受限环境、队列/恢复补充及发布证据见 RELEASE-v0.4.md。
