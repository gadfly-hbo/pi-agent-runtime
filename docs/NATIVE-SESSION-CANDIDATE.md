# 原生持久会话增量：实施与宿主合同

2026-10-09。状态：0.4.0 已实现并完成合成验证；最终冻结发布以 RELEASE-v0.4.md 及收据为准，未被 JuanerAI 采用。此文不修改冻结的 0.3.2 包或历史合同；完整 SDK 使用新版本0.4.0。

用户批准：复用 Pi JSONL；产品显式提供专属目录、访问与保留策略及单写入者保证；业务 SQLite、预算和审计保留；新任务使用原生会话，旧检查点兼容保留、核账后再迁移。随后确认 Mini 暂停相关接入开发，等待共享 SDK 全部完成并发布后再接入。

## 决策落实

| 决策 | 已批准方案与实现 | 状态 |
|---|---|---|
| 所有者 | SDK 接线；Pi 持有协议会话；产品持有业务、权限、预算、回执和保留策略 | 一致 |
| 存储 | JsonlSessionRepo + StorageBackedSession，格式由精确 Pi 0.86.1 拥有，无自建会话表或日志格式 | 一致 |
| 目录与写入 | 必须提供绝对 directory/cwd、policyVersion、访问回调及跨进程独占 acquireWriter；首版保守独占专属根，覆盖单 Session 单写入者要求 | 一致；代价是同根会话不能并行写，后续缩小锁粒度另验 |
| 身份 | 原生 sessionId、branch、operationId、invocationId；业务 taskId 稳定且预算不属于 Session。宿主 bindOperation 在 native accept 前可靠确认关联 | 一致；业务映射落在宿主现有账本，不另定 SQLite schema |
| 基数 | 门面允许多次 Run、多个依次绑定的 Task；宿主 reconcile 决定允许的业务关系。Fork 仅复制历史，不能复制授权或重置预算 | 一致；JuanerAI 实际映射待产品接线 |
| 读写保留 | create/list/read/run/fork/delete 都检查宿主策略；list 再逐项过滤 read。关闭不删除，删除会话不删业务审计；无默认全局根和自动清理 | 一致；真实内容保留/加密由产品实施 |
| 恢复 | inspect/history 不推进；每次 run 都核查授权、账本及外部回执，unknown/denied 阻断。resume 只能推进已有 Operation，不能夹带新 prompt | 一致；未知工具不自动重放 |
| 跨存储窗口 | 任务预算先 claim；宿主绑定确认；Pi accept；每次物理效果前授权、预留、可靠审计；效果后结算/审计，再交 Pi 提交。各存储没有共同事务，故障必须对账 | 一致；不承诺 exactly-once 或断电 fsync |
| 辅助成本 | 普通调用、自动/手动压缩、摘要和 native retry 都经过同一 guarded transport；保留未知预留。native retry 可显式开启，先耗尽声明的 fallback 路由，再由 Pi 有界重试当前候选；quota 不重试 | 一致；无隐式默认重试/压缩 |
| 兼容与回滚 | 保留 Worker/Text/0.3.1 用途和旧 checkpoint；新 SessionRuntime 的这些入口共用新配置身份与权威账本。既有任务不能直接换配置身份，须宿主对账迁移 | 一致；旧包与历史不改，不自动迁移 |
| 分工与发布 | 当前仓库实施 SDK；不写 Mini 产品工作树、不联系其他会话；完整候选验收后发布，再交 Mini 接入 | 已批准；发布状态见0.4.0收据 |

本增量没有创建生产目录、生产业务表、长期 Memory 或新的会话引擎。测试目录是可清理的合成夹具；测试中的 JSON 预算账本不是供产品使用的数据库实现。

## 公共入口

`createSessionRuntime(options)` 增加必需的 `budgets`、`storage`、`reconcile` 和 `bindOperation`。没有持久 BudgetStore 的默认降级。宿主回调本身应遵守信号与可靠存储合同。

- `create/list/history/inspect/fork/delete`：中立身份和内容，原生对象不出 Adapter；生命周期方法失败抛 RuntimeFault。
- `run({sessionId, branch?, taskId, purpose?, limits, tools, prompt, operation?})`：原生 accept/drive；默认 branch=main、operation=prompt。resume 使用已有 Operation；skill/template 使用固定资源；compact/navigate 调用原生机制。compact 返回摘要文本，navigate 返回可用的原生分支摘要或空字符串。
- `runWorker/runText/runAgent/waitForIdle` 保留；不可变 purposes 支持 Agent→Worker→Text 共用 Task 的预算。旧 checkpoint 仍走兼容路径。
- `harness.skills/templates`：可信宿主提供内容，交 Pi 原生资源与 invocation 格式化处理；loadHarnessResources 已提供原生磁盘来源加载、诊断和内容身份。内容与配置一起纳入任务 hash，不能只凭版本标签掩盖内容变化。
- `harness.compaction`：显式 enabled/reserveTokens/keepRecentTokens；省略时关闭。自动压缩、手动压缩均实际调用原生摘要算法和 guarded Models。
- `harness.retry`：显式 enabled/maxRetries/baseDelayMs/maxAgentDelayMs；省略关闭。失败用量保留原预留，额度不足会先停止，不能承诺重试次数一定执行完。

业务授权与审计收到 `session` 关联；工具授权、执行器可选第三参数及审计收到稳定 `invocation` 关联，供现有外部回执/幂等系统使用。这些是中立值，不含 Pi 类型或原始 Hook 对象。

`storage.policyVersion` 是宿主策略身份，不代替实际访问/保留策略。宿主应限制目录的 OS 访问、禁止其他进程绕过独占回调、管理备份/加密/删除和 symlink 信任。用于 Session 存储的 NodeExecutionEnv 不向模型开放 Shell，也不是沙箱。

## 恢复与停止

`reconcile` 每次推进都调用，包含 session/task/branch 与所有未完成 Operation；宿主检查当前权威记录后返回 ready、unknown 或 denied。ready 不是忽略未知的便捷开关。bindOperation 重复确认必须幂等，拒绝 Operation 改绑其他 Task/purpose；预算配置由 BudgetStore 独立校验。

同一个 SDK 实例拒绝重叠存储操作；其他进程由 acquireWriter 拒绝。取消可先返回，物理 IO 未结束时独占权和预算 lease 继续持有；waitForIdle 等待本实例真正收尾。关闭或超时不能证明外部动作被撤销。

原生 JSONL open 会修复未完成尾事务；所以 history/inspect 也取得写入所有权。完整坏行拒绝，不用删坏行伪造成功。Fork 拒绝有未完成 Operation 或队列的源分支，防止原生 fork 丢弃执行状态后被误当恢复。

## 验证证据

`tests/session.test.ts` NS01–NS14：磁盘真实工具消费、Fork 累计预算、访问/恢复拒绝、写入竞争、尾行修复/坏行拒绝、两个独立 Node 进程续接、效果后硬退出与未知拒绝、Skill/模板实际消费、手动/自动压缩摘要消费、辅助请求护栏、绑定失败、取消后写入权保留、原生 retry/配额负例、混合用途共享账本、稳定 invocation 关联。

证据位于 `artifacts/native-session-20261009-001/`。早期类型检查失败日志保留，修复未削弱断言。NS05/06 的进程夹具只使用合成 transport/工具/临时文件，没有 Provider、真实数据或 Mini 操作。

后续完整接线与修复已在0.4.0补齐：队列/空闲撤回、观测扩展、资源加载、受限执行环境、模型条件能力、故障恢复、独立打包消费者。新证据在 artifacts/full-harness-20261009-001/；详见 RELEASE-v0.4.md 和能力台账。JuanerAI Analysis IR、专业质量、生产账本/授权策略及真实双模型验收留给产品采用，不拿共享合成 PASS 代替。

队列额外使用原生 value `sdk.queue-authority.v1` 保存 taskId/purpose/operationId，先写绑定再入队；未知绑定或跨任务/用途阻断。该元数据不是另一个队列引擎。宿主负责业务绑定和对账，原生仍管理队列执行状态。
