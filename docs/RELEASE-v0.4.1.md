# SDK0.4.1：显式累计不封顶兼容增量

日期：2026-10-09。标准仍为 v0.3。Pi 两包保持精确 0.86.1，无依赖升级或安装。

采用来源：用户明确批准 JuanerAI 暂不设累计额度上限并授权本项目实施、相称验证和独立评审。基线 main/ec49d741f0c8e7908cdeff30860265efa5a9ebe9；产品提供的三个文档 SHA-256 已读回匹配，初始工作区干净，根 AGENTS.md 不存在，遵守当前全局规则。实现分支 codex/uncapped-budget。0.4.0 的 tgz、历史合同、失败及评审证据未改写。

版本按用户决定使用 0.4.1，作为 0.4.0 的兼容策略增量。新增策略仍需宿主显式适配；原有限接口与行为保留。规格与结构决定见 [合同](UNCAPPED-BUDGET-CONTRACT.md)。

## 实际变化

- `UncappedLimits` 的 `cumulative:'unlimited'` 是可持久的明确选择。无累计模型/工具次数、token、resourceUnits、activeMs 截止；继续累计全部消费。不能用缺失、Infinity、NaN、大数、换任务或清零代替。
- 单次 `maxOutputTokens/modelTimeoutMs/toolTimeoutMs/controlTimeoutMs` 全部必填。原生循环/压缩不重新实现；每次模型、工具与控制 IO 单独计时，JSONL 文件与行读取也受保护。文件/进程大小、隔离、授权与停止仍按现有接线生效。
- `claimUncapped` 与 `UncappedBudgetLease.settleModelUsage` 明确要求新计量能力；旧 store 不支持时失败。已知输入/输出与未结算预留分别可读回；已知超出单次输出上限先入账再阻止成功。快照读失败或无效值返回 STATE_FAILED，不把零占位报为已知消耗。
- `modelRecovery:{extraAttempts:1}`：每个逻辑模型请求的备用/失败/已结束超时重试共用一次额外请求。与 native retry 同开拒绝。正常工具反馈后的下一模型步另计；未知工具效果不自动重放。
- 取消/超时后仍等待真实物理结束才释放 lease；停止返回不等于物理空闲。未结束的模型不能与额外尝试并行，迟到结果不能成为成功或退款。定时器不能打断同步 CPU 阻塞；宿主仍负责隔离。
- 旧有限接口、未使用新字段的配置 hash、用途集合、Worker/Text/Agent、checkpoint 兼容保留。Task 是权威计量单位；Session/Fork不清账，业务父子关系由产品拥有。

## 验证和身份

当前版本收据目录为 `artifacts/uncapped-0.4.1-20261009-001/`，包含重新打包验证、完整 hash 和 REPORT.md/RECEIPT.json。运行源码与已评审候选逐文件核对一致；机制测试与独立评审保留在 `artifacts/uncapped-20261009-001/`，不改写其历史版本身份。此前候选包仅供历史追溯，当前交付使用0.4.1。这些本地证据不自动发布到公开 GitHub。

可执行验证：

```sh
npm run typecheck
node --experimental-strip-types --test tests/uncapped.test.ts
PI_RUN_OS_SANDBOX_TESTS=1 PI_RUN_LOCAL_PROXY_TESTS=1 npm run verify
npm run verify:harness-package
```

本轮新增 UB01–17 包含实际多轮/工具消费、共享一次额外尝试、控制/JSONL故障注入、取消/迟到与真实独立进程硬退出恢复；NS01/08/09、HE04/07、用途切换同时运行有限/不封顶模式，证明持久上下文、自动压缩和分支摘要被后续模型真实消费，deferred各物理请求入同一账本。打包检查提取真实 tgz、在独立目录经公共 exports 消费旧有限与新策略，并验证公开类型不含 Pi；使用已安装精确依赖，不执行安装。

这些是共享包合成机制验证，不能代替 JuanerAI Analysis IR/业务质量验收、真实双模型 Provider 验证或生产持久 Adapter 验收。Provider/真实数据 NOT_RUN；历史 Provider PASS 不沿用成本或授权。

## JuanerAI 采用与回滚

接法见 [INTEGRATION](INTEGRATION.md#sdk041juanerai-累计不封顶接法)。生产 Adapter 须实现原子持久 claimUncapped/settleModelUsage，提供有效单次保护参数、明确开启 extraAttempts:1 并关闭 native retry；仍落实专属JSONL目录、单写入者、对账和可靠审计。没有默认生产数值，没有迁移产品状态/预算权威到 SDK。

旧 Task 直接切换策略返回 CONFIGURATION_CHANGED。显式迁移需要宿主批准、物理空闲、外部回执/UNKNOWN核查，事务保留全部累计量、未知预留、旧新配置和审计关联；SDK不提供静默改绑。回滚保留旧包及有限任务合同，新无限策略账本不能交给旧0.4.0或清零迁回。

当前交付为本地新版本候选；GitHub发布/设备同步/安装/产品采用未由本次策略授权推定。未修改 JuanerAI，未联系或唤醒 Mini。是否发布及产品何时启用，分别依据对应授权处理；本包验证不声明 Change005 已采用或验收通过。


## 后续发布授权

用户随后明确授权本轮 Git 发布、依赖安装和共享 SDK Mini 同步；JuanerAI 接入由现有 Mini 任务继续，另行转交固定包和接续 Prompt。本次发行采用已固定 tgz，不重写候选包字节；包内文档保留打包时的本地候选状态，当前发布收据入口为 [公开收据](../artifacts/public/v0.4.1/RELEASE-RECEIPT.json)。真实 Provider 验证有本轮独立限定授权，其结果另记，不从历史 PASS 推定。
