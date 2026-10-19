# B：物理模型尝试关联合同 v1

状态：2026-10-18 用户已批准有界离线实施，本地实现候选 0.5.3-harness.5；
最终实际 tgz、验证和独立审查结论以本批交付收据为准。未正式发布，不自动采用。
实施基线为固定 0.5.3-harness.4（169362 bytes，SHA256
c377f5cffc77688e3cf2831fd10c6dc413327d8261c12cf3e6e54a1ec24c48de），
140 项源码 aggregate 227a2478d2b56b21287605fef08a5fc6d4660bf17fb9e7b3a48b09bc9c473453。
原 B 报告的 PROPOSAL_ONLY 结论保留；新增需求的 RED 不改判旧公开合同违约。

## 已批准决定与实施边界

依据本轮用户完整授权，按 structure-grill 核对以下窄增量；用户明确授权维护方细化
类型名/实现，不再请求常规启动或字段名审批。没有新业务表、持久引擎或迁移。

| 主题 | 本轮已批准语义与具体接法 |
| --- | --- |
| 所有权/粒度 | SDK 产生每次物理尝试的可信关联；宿主持有业务 work、草稿、原子额度、期限和业务结算 |
| 逻辑身份 | 来自 Pi 公开 operationState 的 operation/trigger/summary-task 与真实嵌套请求位置；不从内容、hash、总 attempt 或模型自报推断 |
| 物理身份 | 每次尝试生成唯一 ID，在授权、准入、终止、迟到事实间保持同一 ID；ID 不授予权限 |
| 分类/父关系 | 初始正常步骤与恢复分列；同模型/备用/native retry/overflow/恢复摘要关联其原请求和触发失败的物理尝试 |
| 权威接点 | 仍是每次物理效果前的 model authorize；beforeRequest 不是权威门 |
| 保存/读回 | 复用必需的宿主持久 AuditSink 和现有 ModelOutcome；RunResult 给本次安全事实快照；原生 Session 自己持久保存逻辑触发与恢复状态。不新建 SDK 业务数据库/第二状态机 |
| 预留结算 | 仅可信终止 not-sent 且关联准确时释放该次未消费预留；已发送/未知不退款，迟到只结算原尝试 |
| 兼容 | 显式 modelAttempts:'v1'，同时选择 modelObservations:'v1'；新策略进入新 Task 配置身份。省略不改变旧形状/hash/记录；旧记录缺字段保持 UNKNOWN |
| 次数 | 新公开关联不增加 R4；恢复摘要和重发若需两个额外物理请求，一次额度不足时拒绝后一个。正常后续块/正常摘要继续 |
| 非目标 | 不实现产品共享额度/业务完成，不改资源数值、样例、质量、模型、依赖、Provider strict、产品工程或旧 Task |

公开增量为 ModelAttempt（逻辑/物理 ID、source、initial/recovery、恢复父关系）、
ModelAttemptFact（同一尝试的安全终止/迟到 ModelOutcome），附加到 model Authorization、
model AuditEvent 和 RunResult。共享门持久/原子/幂等必须由消费者实现；普通错误和审计
不含原 prompt、参数、动态 schema、native message 或业务数据库内容。

本合同针对原生 Harness 路径。v1 与旧 checkpoint/yield 或 deferred 组合明确返回
CAPABILITY_UNAVAILABLE，不猜造原生身份。旧未选择本合同的这些能力保留；本轮未取得
产品完整装配，是否涉及这些组合须由采用方核对，不能凭历史身份摘要推定。
异常/缺失原生状态或缺失恢复父关系关闭受影响准入，不伪装成正常步骤。

## 公开类型、读写入口与顺序

`RuntimeOptions.modelAttempts:'v1'` 要求同时开启 `modelObservations:'v1'`，只在新任务或
已另行批准且保全原消耗的迁移中选择。字段省略不变更旧配置 hash、返回形状或审计。

| 类型/字段 | 保证与空缺含义 |
| --- | --- |
| ModelAttempt.version | 固定 '1'；不借 AuditEvent.version='1.0' 推定新字段已消费 |
| logicalRequestId | 64位十六进制的原生身份投影；assistant来自operation+trigger，摘要来自operation+summary-task+持久嵌套位置。只hash这些标识，不hash内容 |
| physicalAttemptId | 每次尝试一个UUID；同一次授权/预算/终止/迟到引用不换ID；不同实际尝试不共用ID |
| source | assistant / compaction / branch_summary；正常辅助摘要也是 initial，不误扣故障恢复 |
| kind/recovery | initial没有recovery；recovery必须有原logicalRequestId、触发失败的physicalAttemptId及reason |
| recovery.reason | same-model / fallback / native-retry / overflow / overflow-summary；来源为实际原生状态或共享层实际有界切换 |
| ModelAttemptFact | version、attempt、outcome、terminal、late、可选安全reason；outcome复用R1，不含原文/schema/native事件 |
| AuditEvent | model.admitted / model.finished 增加modelAttempt及modelAttemptFact；宿主必须持久、按physical ID幂等处理，onEvent仍仅观察 |
| Authorization | kind=model时新增只读modelAttempt；不向ModelRequest/Provider额外发送这些本地标识 |
| RunResult.modelAttempts | 本run每个physical ID最近一份已写审计的事实快照；不是跨run持久账本，晚到不会改写已经返回的快照 |

物理顺序：原生准备/投影 → 窗口准入 → model authorize（含可信关联）→ view复核 →
原Task预算预留 → model.admitted（UNKNOWN/pending事实）→ view复核/信号门 → 原transport →
用量结算 → model.finished → 原工具/发布门。关联不放宽任一旧门。

授权、窗口或预留/发送前拒绝也可产生model.finished，不能要求之前一定有model.admitted。
terminal只表示该次尝试的SDK事实已收口；physicalStatus=unknown仍不能推定物理停止。
RunResult里空数组、缺少finished、取消返回或零占位均不能证明未发送。崩溃时宿主持久
授权预留保持UNKNOWN，不自动补终止事实。原生Session的open操作/恢复历史也不清零。

释放共享恢复预留须同时检查：关联匹配、terminal=true、late=false、physicalStatus=not-sent、
usageFinal=true且输入/输出均known 0；只释放该physical ID对应项。已发送明确失败也消耗
共享恢复额度。矛盾的not-sent/非零或部分用量保留已报计数、将物理事实记UNKNOWN且不退款；
unknown物理结果不能成功发布。
晚到事实标late=true，只供原尝试核账，不退款、不重放、不授予继续资格。

原R4之外不新增恢复次数。v1将“恢复摘要＋原请求重发”等每一个额外物理请求分别过门，
沿既有R4 allowance核对最多一次；第一次摘要耗用后，第二个恢复请求在授权/预算/发送前拒绝。
未选择v1的旧overflow工作流行为不变。因not-sent释放宿主额度不恢复这个已停止链的R4次数。
重开时无法确认旧逻辑恢复关系则STATE_FAILED；不换ID伪装成正常请求。

initial只描述原生新逻辑步骤，不代表新的业务工作、额度或重放许可。宿主仍须以可信业务
命令/Task/work绑定批准下一块或页，防止把同一失败业务动作另开prompt当新工作。
撤权和业务绝对期限由宿主授权与传入AbortSignal共同执行；SDK不读业务数据库/时钟，
不承诺跨控制IO和网络效果的分布式原子授权。

## 最小宿主接线示例

以下 `host` 方法是产品自己的持久原子能力，不是新增SDK API。不得仅用内存Map或Session
分支副本替代。`authorizeModel`内部绑定业务work、检查原绝对deadline/撤权/UNKNOWN，
按physical ID幂等预留；`appendAndSettle`将审计及对应释放/消费/UNKNOWN作为宿主原子事务。

```ts
import {createSessionRuntime} from 'pi-agent-runtime';
const runtime = createSessionRuntime({
  ...trustedExistingOptions,
  modelObservations: 'v1', modelAttempts: 'v1',
  authorize: async (action, signal) => action.kind === 'model'
    ? host.authorizeModel({taskId:action.taskId, runId:action.runId,
        attempt:action.modelAttempt!, signal})
    : host.authorizeExisting(action, signal),
  audit: {append: (event, signal) => host.appendAndSettle(event, signal)},
});
// 每次仍用原Task、已声明purpose、同一绝对业务截止派生的signal。
// modelRecovery:{extraAttempts:1} 与业务共享一次门同时成立；不替换原预算。
```

完整可执行的隔离消费者在 `tests/fixtures/model-attempt-process.mjs`，其宿主夹具在
`tests/fixtures/model-attempt-host.mjs`。它们用实际SDK入口、持久JSONL Session、原子文件事务，
证明正常步骤、共享一次恢复、再次拒绝、跨进程/Fork、重复/冲突、崩溃和300秒绝对期限。
这是可审示例，不是产品数据库实现或产品任务补丁；采用方仍需独立接线和验证。

## 实施前与最终验证预期

先在未改 .4 的公开持久 Session/Harness 路径记录授权/终止缺少关联的 RED；同一断言
修后 GREEN。分别验证主备、同模型、native retry、overflow/辅助摘要、正常摘要/后续步，
not-sent、取消/迟到/UNKNOWN、撤权/期限、并发/幂等、保存/进程重开/Fork及旧合同/A/R1～R4。
隔离消费者使用真实打包入口及宿主持久原子门；原 300 秒业务截止不随目的/块/重开重置。
固定新版本、同一实际 tgz 消费者、独立只读审查后集中回交；实际结果与SKIP分列于本批记录。

产品原始材料、历史调用、token/费用 UNKNOWN、旧包/失败/RED/暂停线保持。
本轮只 SDK 本地离线工程；不联系其他 session、不 SSH 产品、不自动采用、Git 交付、
发布、服务/生产、真实 Provider、凭据/业务数据或旧任务恢复。到固定离线交付即停止。
