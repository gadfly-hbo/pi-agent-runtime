# Pi Agent Runtime 0.4.3 正式发行

本次将既有固定 0.4.3 候选晋级正式 GitHub Release，归回原始源码、测试、锁文件和合同，不新增运行行为。包含 0.4.2 的 MiMo 显式思考协议修正及 0.4.3 的缓存输入、上下文计量和原生压缩消费修正。Pi 两包仍精确锁定 0.86.1，接入标准保持 v0.3。不单独发布 0.4.2，不发布到 npm。

正式附件 `pi-agent-runtime-0.4.3.tgz` 为用户指定、已固定的原字节：

- 大小：108617 bytes。
- SHA-256：`475480217d5f644a15264b2f838e5567d3e2c2e431b8a23c061a0665dbdbfa70`。
- 本次发布前，原始源码的 94 文件清单无漂移；49 个包内文件与源码文档或构建输出逐字节一致；本机重新打包也得到相同完整 hash。发布附件仍取自原固定候选。

包内 `RELEASE-v0.4.2.md`、`RELEASE-v0.4.3.md` 和接入材料中的“本地候选／未发布”等说明保留其历史状态，不覆盖原合同。正式晋级关系以本说明和 Release 附件 `RELEASE-RECEIPT.json` 为准。合同为 `docs/MIMO-THINKING-CONTRACT.md` MT01–06 与 `docs/CACHED-CONTEXT-CONTRACT.md` UC100-1–6。

## 验证与评审

2026-10-12 本机执行并通过：

- `PI_RUN_OS_SANDBOX_TESTS=1 PI_RUN_LOCAL_PROXY_TESTS=1 npm run verify`：204 核心检查、2 项 UI 渲染检查、类型检查及构建，0 失败、0 跳过；包含进程隔离和本机 loopback 合成代理。
- `npm run verify:harness-package`：实际解包的原生会话、旧消费者、不封顶消费者和中立公共类型检查。复用现有精确依赖树，没有安装依赖。
- `tools/verify-release-0.4.3.mjs`：直接消费三个固定版本的 tgz。固定 0.4.3 上的 19 项 MT/UC 检查通过，包括原生自动压缩实际触发及摘要进入后续请求。0.4.1／0.4.2 的有限及不封顶合成持久宿主分别跨独立进程续接 0.4.3，同 Task、配置签名、旧工具结果和累计历史保留；两个旧版本的硬退出 UNKNOWN 均保留并拒绝免费重放。

复用与同一固定候选及原始 94 文件身份匹配的独立机制评审；0.4.2 原报告包含 27 项独立关键检查，0.4.3 原报告为 PASS。本次没有新独立评审，不继承原一次性沙箱豁免。公开收据分别列出旧评审与本次实跑证据。

保留原 RED、GREEN001 的输出上限断言失败、离线安装缓存失败，以及 compatibility005/006 未完整执行断言的记录。配置历史断言仅引用实际执行通过的 compatibility007。本次新的跨版本验证使用 SDK 合成宿主；不重跑产品 SQLite、真实 SSE 或产品验收。

复跑固定包验证（先构建，并提供保留的原始三个包）：

```sh
npm run build
node tools/verify-release-0.4.3.mjs /path/to/0.4.3.tgz /path/to/0.4.2.tgz /path/to/0.4.1.tgz
```

`SOURCE-MANIFEST.json`、`PACKAGE-CONTENTS.json` 提供对应清单；公开日志经过路径脱敏，`HISTORICAL-EVIDENCE-INDEX.json` 仅定位原证据。原始日志仍留在原证据根，公开摘要不是原始证据备份。正式 Release 收据关联最终合并 commit、Tag 和附件身份。

## 兼容及回滚

未启用新字段的旧自定义 Transport、有限／不封顶 BudgetStore 继续有效。新请求中缓存输入只计一次，分类是总输入的互斥子集；历史输入不重算，UNKNOWN 与预留不清零。输出上限、授权、审计、取消、错误停止和恢复核账维持原合同。

保留旧精确包与配置。回滚前由宿主确认物理空闲并核对账本、UNKNOWN、会话及配置兼容；不得通过换 Task、清账或隐式移除 `thinkingProtocol` 回滚。0.4.2 会恢复旧缓存漏计行为，不能把回退解释为继续修正后的计量。旧包不被覆盖。

真实 Provider、业务数据、产品采用／验收及 hosted CI 本次均未运行。无其他设备同步、产品依赖变更、服务操作或任务恢复。**其他产品未自动升级。**
