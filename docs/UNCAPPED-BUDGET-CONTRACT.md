# SDK 0.4.1 累计不封顶增量合同

用户明确批准累计不封顶，并授权接口设计与兼容实现。本合同记录该批准范围内的技术决定，不再次要求策略审批。来源基线 ec49d741f0c8e7908cdeff30860265efa5a9ebe9，工作区干净；0.4.0与历史证据不变。

| 决定 | 实施合同 |
|---|---|
| 所有权/粒度/身份 | 可信宿主选择，Task仍为权威账本单位；Session/Fork不产生预算重置。无产品业务或数据库结构迁入SDK |
| 明确策略 | 旧Limits字段和有限语义保留；新增UncappedLimits，cumulative:'unlimited'。不允许混用累计数值字段，不使用Infinity/极大数/缺失字段表示无上限 |
| 单次保护 | 新策略必须给maxOutputTokens、modelTimeoutMs、toolTimeoutMs、controlTimeoutMs。无累计或整次多轮运行截止器；每个物理模型/工具调用及运行内控制IO分别受限（含原生JSONL逐次文件操作/行读取；无活动run的管理入口由宿主控制取消）。文件/进程环境限制保持 |
| 持久接缝 | BudgetStore新增显式claimUncapped；旧store不隐式降级。返回UncappedBudgetLease，原子预留/结算与累计input/output/resource/time读回，reservedOutputTokens保留未结算/未知预留；故障拒绝 |
| 迁移/回滚 | 新策略和全部单次参数进入任务配置身份。旧任务直接改策略拒绝；产品只能在无活动lease且核清未知状态后以可审计显式迁移保留全部消耗。SDK不自动迁移，旧包不能接无上限策略 |
| 重试 | 显式modelRecovery.extraAttempts:0或1。每个逻辑模型请求共用一次失败后额外尝试，优先下一备用，否则重试当前模型（quota无备用时不重试）。正常下一模型步骤另起次数。与native retry同时开启拒绝；不创建另一套Harness循环 |
| 超时与物理空闲 | 模型超时只有实际调用已结束才允许额外尝试；未响应取消的调用保持lease并返回截止失败，不并发偷偷重发。工具超时不自动重放。迟到结果不能结算退款或发布 |
| 兼容 | 旧有限claim和配置hash形状保持。公开类型不含Pi。数值计量超出安全表示能力报STATE_FAILED，不当成额度耗尽或清零 |
| 验收 | RED/GREEN、旧回归、真实进程重开/UNKNOWN、辅助请求、取消/故障、打包消费者、独立只读评审；Provider/真实数据NOT_RUN |

状态：合同已按用户授权固定，实现已接通；固定候选验证与独立评审状态以 RELEASE-v0.4.1.md 所指收据为准。无生产迁移或产品采用声明。
