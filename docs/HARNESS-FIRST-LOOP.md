# Harness first loop — PI-HARNESS-FIRST-LOOP-20261017

Interface r4（落实 r3 物理尝试保证）· 本地实现候选 `0.5.3-harness.3` · 未正式发布/未代签产品采用。
用户批准联合实施方案 v0.2；只推进本专属本地树及固定离线候选。
基线 `75bade32b812879bd68131a3527b79e06ea5d87a`，专属分支
`codex/harness-first-loop-20261017`。最终源码/WIP aggregate、固定 tgz bytes/hash/SRI、
验证和独立审查以同批交付归档为准。本文件不将中间 Interface r1 追认成已交付包。

## D0 核销及保留现场

启动包 1161552 bytes，SHA256
`da17f96837db86b8b6af45fb93065081e9df15b0758e96dd063bb4723674c18c`；23 项 payload、24 项 checksum 一致。
旧 `0.5.2-parameters.1`：150595 bytes，SHA256
`7436a572bf03fc0eb6de84363a8a2233f7f5ca3fa197320c2251ee83ca88bc66`。
六文件源码身份已校验；接收 src/index.ts、src/pi-adapter.ts 的 helper 增量及原测试/合同，
旧 package/lock 只有根版本差异，改用本任务新候选版本；非根依赖不变。
`prepareToolArguments(parameters,args)` 已直接返回同版 Pi validateToolArguments 结果，
原五项 GREEN 本轮复用，未重写 converter、未追认新的 RED。

原 helper 合同保存在 NATIVE-PARAMETER-PREPARATION.md；它不是完整 Tool.prepareArguments
桥接或批屏障。本轮完成下述接点。interpret_meaning 的局部 native 准备已获批准；其他
业务工具严格政策不因此放宽。原 fixed019 BLOCKED B-ENV、green-final 4 PASS/1 FAIL、
后续 live8 失败及正式0.5.1/旧0.5.2全部原包保留；不提升为本轮验收。
第一次离线锁定安装 ENOTCACHED 后，按原锁安装101包；Pi core/ai 0.86.1、openai 6.40.0
不变。SDK标准 v0.3、当前开发模型/权限配置、R1～R4已收口范围均保持。

## 公共 Interface r3

| 状态 | 入口 | 本轮语义 |
| --- | --- | --- |
| 已有，接收原字节实现 | prepareToolArguments | 纯参数准备，返回 Pi 校验/归一化值；安全 INVALID_TOOL，无原生 message/cause |
| 已有 | createSessionRuntime.run、PurposeConfig、Tool | 固定 Task/purpose 能力上界、执行器、业务授权/预算/审计；保持产品阶段权威 |
| 本轮实现 | RuntimeOptions.toolAdmission | 仅 createSessionRuntime.run 支持；plain Runtime、checkpoint路径明确 CAPABILITY_UNAVAILABLE；省略维持旧行为 |
| 本轮实现 | ToolView、ToolAdmissionPolicy | 受信、带版本的阶段合同；固定上界与阶段schema取交集，模型声明和原生执行同源 |
| 本轮实现 | Tool.argumentPolicy、Tool.prepareArguments | 严格/native用途政策与具体工具兼容 prepare 分开；原始副本保留，具体 prepare 一次 |
| 本轮实现 | ToolAdmissionFact、RunResult.toolAdmissions、AuditEvent.toolAdmission | 有界安全结构准入/拒绝/同批延后/终止事实；新 opt-in 审计 kind 为 tool.prepared |
| 本轮实现 | SessionRuntime.inspectFacts | 被动读回，无 writer获取、模型/工具、native repair、Session写入或所有权改变 |
| 已有，接回原生 | createExecutionTools(read/write/edit/bash)、ToolExecutionContext | edit原生兼容prepare、progress和invocation memo保真；无新增工具/执行引擎/权限 |
| 已有，复用 | contextAdmission、modelObservations、Tool.modelOutput、modelRecovery | R1～R4准入、usage/UNKNOWN、效果回执及 once-extra；不重建 |
| 不在本轮 | Provider strict、业务dispatcher/语义核验、产品保存/恢复批准 | 无 MiniMax strict 支持承诺；不把业务工具或核账移入SDK |

精确类型见 src/types.ts；公共导出不含 Pi 类型。prepare helper及原生接线在
src/pi-adapter.ts，护栏在 src/index.ts，安全载体在 src/errors.ts。

```ts
const tools: Tool[] = [
  {name:'interpret_meaning', description:'产品业务executor',
   parameters:fullMeaningSchema, argumentPolicy:'native', policyVersion:'meaning-v1',
   effect:'write', resourceUnits:1, execute:meaningExecutor},
  {name:'read_analysis_evidence', description:'产品证据读取',
   parameters:fullEvidenceSchema, argumentPolicy:'strict', policyVersion:'evidence-v1',
   effect:'read', resourceUnits:1, execute:evidenceExecutor},
];
const runtime = createSessionRuntime({ ...existingHostOptions,
  toolAdmission:{ policyVersion:'product-contract-v1', correctionLimit:1,
    view: async ({taskId,purpose,signal}) => ({
      version:trustedPhaseRevision, tools:trustedPhaseDefinitions,
    }) },
});
// 仅新Task显式装配；旧Task不可借相同ID开启新合同。
const result = await runtime.run({sessionId,taskId,purpose,prompt,tools,limits});
const facts = await runtime.inspectFacts({sessionId,taskId,purpose,signal});
```

示例变量由产品提供；不是可运行的业务schema。所有本批真实业务工具必须交完整schema，
包括 read_analysis_evidence.required_plans 的 version/sheet_id/group_by、嵌套/联合和额外字段
规则；不能只接 interpret_meaning 或保留宽schema通用分发作为执行权威。

## 参数、阶段与批准入顺序

2026-10-18 物理尝试 view 修复（用户已批准，本地实现）：保持 r3 保证，不改成逻辑请求
固定视图合同。共享内部 fallback/once-extra 在每次预留/发送前重新取得受信 view，与
该原生步骤的固定快照比较；变化即安全拒绝，保留现有 terminal/no-replay 语义，不自动
重派生、不额外请求、不扩大额度。原请求的已知用量、UNKNOWN、旧 Task/配置身份保持。
验证接点为公共 createSessionRuntime.run、ModelTransport、BudgetStore 和 inspectFacts；
先保留修改前因果 RED，再核对稳定/变化视图、主备/同模型额外尝试、授权/取消、参数批
屏障与持久终止，最终同一 tgz 隔离消费者及独立只读审查。原 .2 包、r3 及联合回执保持冻结；
本批仅修复共享发送接缝，不代签 Mini 新包采用或重跑联合产品验收。内部接点在每次
物理模型授权后、预留前重新获取并比较 view；预留/审计 I/O 后、实际 transport 前再比较。
若后一检查拒绝，已准入但未发送的尝试按已知零用量结算并释放相应 token 预留；启用
modelObservations 时投影为 not-sent，省略观察仍保留原结果形状。
不把它记成 Provider UNKNOWN 或触发重试；此前真实请求的已知/UNKNOWN 消费不被退款。
检查不是跨进程原子快照，宿主每次真实效果的授权和阶段权威仍按原合同保留。

1. 固定 Tool/purpose 上界；view仅引用其中名称，字段只允许name/description/parameters，
   不接受 executor/effect/权限替换。实际schema是固定Tool.parameters与阶段parameters的allOf交集（相等时直接复用），同一派生结果用于模型与执行；不让阶段视图放宽固定接受域。version/policyVersion是无换行、非空、≤256字符标识；
   view ≤1MiB，schema为object。函数变化由宿主更新policyVersion，不依赖函数源码hash。
2. 每次物理请求前取受信view，模型声明由它派生，再复用R1最终DTO准入/授权/计量；
   回复时与完成prepare/hooks后再核对view。陈旧视图、未知名称、重复ID、截断工具回复拒绝。
3. 在副本上一次具体 Tool.prepareArguments，再用同版Pi validator；strict默认要求准备前后
   深等价，拒绝类型转换。native只对已批准用途采用Pi返回值，不猜资料ID、不修业务含义。
   原生edit兼容prepare可改对象，原始入参不变；不将该prepare再传给原生执行层重复调用。
4. beforeTool可替换参数，但在批屏障内提前运行，并受相同schema/policy重校验；因此这个
   hook必须是无业务效果的准入接点。它不能承担外部写入或事务提交。hook异常/阻止安全终止。
5. 完整批结构验证成功才进入第一个业务executor。失败项rejected、其余deferred，整批无业务
   executor效果、无tool预算扣记；模型请求与必要安全记录仍计量。不是业务事务回滚。
6. 每个真实效果仍执行既有授权、预算、审计及取消/期限门；授权不能以结构ready代替。
   产品要在该接点检查当前业务阶段/期限。执行器推进阶段后，后续请求重新取view。

安全反馈只含 status/code/executed:false/terminal；普通错误、审计和反馈不含原入参全文、
动态schema或Pi message。catch错误帧也清除被拒参数。ready只证明结构，不是已执行/已保存。
ToolOutcome.status仍是completed/unknown。模型工具结果、业务保存和用户成果分别判断。

## 纠错、停止和被动读回

correctionLimit取0或1，固定在Runtime构造；按task/purpose/tool累计，与R4每正常模型步骤的
物理once-extra分开。deferred不占该工具纠错数，单批同工具多个错误只计一次；耗尽关闭
后续executor和新请求，不靠transport伪造Provider故障。纠错次数/terminal保存在现有Session
`sdk.tool-admission.v1`版本化可选value，事实只保留最近128条，计数/停止不随裁剪丢弃。

Fork使用原生parentSessionId血缘和原有全局writer lease，把同Task/purpose计数指向共同
权威Session；包括分叉早于Task首次出现的情况。缺祖先/缺权威/坏记录拒绝，不能当零；
删除权威后子会话不可自动恢复。已有消费的Task若在所选lineage没有消费绑定，STATE_FAILED
关闭准入，不能另建独立Session清零。已有绑定的同Task可继续已声明purpose转换；仅使用
原有账本消费事实和Session可选记录，不建全局索引。初次模型授权拒绝留下的空记录不算
消费绑定；仅在该原生drive关联到账本消费后标记，不能预建多个空会话再绕过Task终止。
需要祖先read/update的宿主存储授权，不能通过Fork提权。
旧Session缺载体是UNKNOWN，不迁移，不抹历史预算/UNKNOWN。未结算操作的自动恢复仍拒绝；
已有reconcile、bindOperation和宿主效果核账保持权威，新事实不会恢复或重放操作。

inspectFacts返回availability available/busy/unavailable/corrupt；available时提供session/
branch/tip、settled pending:null、可确认的terminal、queue与admission可得性。活动/未结算
operation保守返回busy，不伪装idle；无匹配queue owner或旧数据返回unknown，不伪空队列。
terminal只在有该Task绑定证据时返回，缺绑定不归属猜测。拒绝任意存储字段投射，只公开
白名单标签/枚举/hash；业务内容与最终效果核账不在此接口。

读取使用受限只读文件代理，native torn-tail修复在写入前被拒；查询前后比较已读文件内容。
文件>16MiB、子路径symlink/路径越界无法安全读取时unavailable，尾部损坏corrupt、快照变化
busy；无OS级跨进程原子快照承诺。读授权失败/异常返回unavailable/AUTHORITY_REQUIRED。
宿主可用signal取消，读取不申请writer、不注册第二Session引擎、不做修复。

## 固定限制与兼容

直接采用方案§4.6：Runtime输出32768，主32768/备16384；modelTimeoutMs600000、
toolTimeoutMs300000、controlTimeoutMs30000、现有命令软120000，cumulative:'unlimited'。
这些是宿主装配，不是Provider极限，不新建动态配置/profile/连接/首token/空闲时钟/transport。
已有输出取最小上限、单次物理请求总钟、工具硬墙和control IO机制复用；流进度不续600秒。
命令软墙归已有受限host；本轮仅补进程timeout可信载体到既有ToolOutcome.failureCategory。
不授予Shell/网络、付费试验或增加重试。原有特定业务300秒总截止由产品效果前授权门保留，
不扩到全产品，也不被SDK unlimited抹除。

省略toolAdmission的旧公共调用/hash、Task和R1～R4保持；旧helper函数仍兼容。新policy/
argumentPolicy会进入新Task配置身份；不能把旧Task直接开启或回退到另一合同。新增审计
kind只用于opt-in路径，Mini审计sink需要接受tool.prepared及安全伴随事实；旧sink形状不变。
旧0.5.1、0.5.2包和所有FAIL/BLOCKED/UNKNOWN都保留；包版本字符串不是bytes身份。

## Mini 最小接线与采用/回滚

先固定完整Tool/executor/已批准用途政策与同源阶段view；仅对新Task开启toolAdmission。
新路径去掉transport中另一份schema权威、arguments_json通用业务分发与全局coerce；
保留产品阶段、真实资料身份/金额单位/业务语义校验、每效果授权及保存/恢复核账。
modelObservations/contextAdmission、输出投影/回执和modelRecovery复用R1～R4。

实际新包交付后，由用户手动转交；Mini核验tgz bytes/SHA256/SRI，再在专属产品树隔离安装，
绑定本批源码/装配/持久Session/合成任务证据。不能用源码检查或另打包替代固定包。
interpret_meaning在完整enum下允许1→'1'；read_analysis_evidence默认strict，缺group_by、
额外字段、错类型必须安全拒绝后明确纠正。错误业务含义由产品护栏拒绝，不能靠coerce掩盖。

回滚仅按原精确旧包恢复对应产品装配；保留新任务Session/账本/回执/UNKNOWN，不把新合同
Task用旧SDK继续，也不自动重放、清账或迁移。SDK本地通过不代签Mini已收到/已安装。

## 证据与停点

tests/tool-admission.test.ts：实际持久Harness整批/阶段/参数/hook、取消/授权、纠错重开/
Fork、被动busy/坏尾/授权异常/畸形值无泄露；新缺陷有修改前因果RED，旧GREEN只复用。
tests/first-loop-limits.test.ts：虚拟时钟的真实Pi SSE、>4096输出、>60秒、600秒不续期、
主备输出cap、工具硬300秒/命令软120秒/control30秒、310秒场景保留宿主300秒效果门。
tests/first-loop-program.test.ts：多次完整write/edit/read后交最终完整程序，≤65536bytes；
合成核验及显式OS sandbox实际计算分列，截断无draft效果、factory progress/memo保真。
R1～R4现有fixtures、旧Task/hash及固定同tgz隔离安装消费者集中验证；完整结果见交付证据。

独立只读审查按当前AGENTS和用户当前模型/权限配置执行，不继承fixed019/F-ROLE-01例外；
行为只读与OS权限分开报告，环境实质不符则BLOCKED。没有托管CI，不报告CI PASS。
A11 Browser视觉/HTTP产品接入、A16完整业务工具到保存/重开由Mini负责；本SDK不代签。
真实Provider、正式产品验收、发布/生产、Git提交/推送、消费者升级均未授权/未运行。
两个产品暂停任务保持暂停。独立审查对先前0.5.3-harness.1发现固定schema上界、跨独立Session计数、损坏lane误空及祖先读授权误分类；原包与NEEDS_REPAIR保留。上述修正有修改前因果RED和新回归，0.5.3-harness.2另出固定身份，不覆盖.1。
本方固定候选及完整证据归档交用户转交后，停在待联合反馈。

## S1/S2 精简本地候选（2026-10-19）

本节承接用户批准的精简 v0.2 与本轮工程 Prompt；只授权 SDK 最小修正、
离线验证和新固定本地候选，不授予消费者采用、Provider、Git 交付或发行。
原 `.5` 包、冻结源、历史失败/UNKNOWN 和原工程树 WIP 保留。

- S1：新 Task 的 `createSessionRuntime.run` 可显式配置
  `toolFeedback:{policyVersion,tools:[工具名]}`。首批只允许列出的只读工具；
  旧普通/checkpoint/deferred 组合拒绝该政策，省略时旧行为/配置 hash 不变。
  可信宿主可在 `ToolOutputFailure(outcome,'TOOL_FAILED',feedback)` 中声明
  `feedback:{effect:'none',code}`；code 只允许 not_found/not_directory/
  is_directory/invalid/not_supported。该声明证明操作已终结且无待确认业务
  效果，必须绑定 completed/failed 的 outcome、工具/units/invocation，且无
  receipt，outcome.reason 如存在须同为 TOOL_FAILED；冲突的结构化停止原因
  拒绝授予反馈。它不是从 read 标签、errno 或 failureCategory 推断出的证明；
  SDK 不自动把原生工厂的任意错误升级成该声明。反馈只公开固定代码与
  executed:false，原生 isError 保留；不把原异常文本/cause 写入模型或审计。
  既有审计字段不扩展；选择新政策才增加既有 ToolOutcome 观察。撤权、审计/
  账本/ACK 故障、取消/期限/迟到、UNKNOWN、已有效果的交付故障仍硬停。
  不自动重调工具；下一正常逻辑请求仍经授权/计量，R4 once-extra 不变。
- S2：普通 off、持久 off 的具体 prepare 在副本上一次，使用 Pi validator
  返回值交原生。持久 on 已有 prepare/strict-native/view/批屏障直接复用。
  普通 on 继续拒绝；off 保留原生归一化与 hook 时序；原生必要再校验、替参
  再校验、执行一致性与效果前授权保留。Anthropic schemaPayload 桥不改。
- S3：旧 checkpoint 建议弃用，新持续任务优先原生 Session；这是用法建议，
  不增加旧入口拒绝、不规定删除版本/期限。旧公开接口、driveCheckpoint、
  ACK/业务等待/UNKNOWN 及兼容测试均保留；fromCheckpoint 仍服务 R1 和扩展。

公共验证接缝为 createRuntime.runAgent、createSessionRuntime.run、受信 Tool、
ModelTransport、AuditSink、BudgetStore 和现有 inspection/history；先保留
S2 兼容输入在真实 Pi 调用链的因果 RED，S1 用既有 ToolOutputFailure 的新
参数与运行政策规格验证行为，不以缺导出/编译失败冒充 RED。完整结果依
README 集中 verify/example、同一 tgz 的隔离消费者和未参与编写者只读复核。

该增量本地候选身份为 `0.5.3-simplification.2`，不是正式发行版本承诺。
受信宿主须自行确保无效果证明真实；SDK 仅校验受信载体/调用绑定，不从
任意文件错误推断。证明保存在构造器私有载体中，追加普通同名属性无效。
无策略 beforeTool 的原生替参校验错误保持原有 immediate-error 反馈，可由
后续正常模型步骤消费；它拒绝业务 executor，不因此改成全局故障。该行为
已对冻结 `.5` 和本候选作同接口对照；与普通 execute 抛错的硬停分开。
