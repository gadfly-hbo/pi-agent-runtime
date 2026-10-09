# 首版验证与限制

本文件是 v0.1 历史验证记录，后面的未联调/未独立评审状态只适用于该首版，不覆盖后续证据。当前 0.3.0 范围见 [v0.3 合同](RELEASE-v0.3.md)；本机最新证据根为 `artifacts/runtime-v0.3/`，当前 README 指向历史 Provider 联调。新增并行/thinking/文本能力本轮只做离线验证，不能沿用旧联调宣称新能力已实测。

设备：MacBook；日期：2026-10-07。授权对象：独立本地仓库 `pi-agent-runtime`，不是 JuanerAI 产品 Change。结果级别是 SDK 本地离线验证，不是独立 Validator、真实 Provider 联调或产品用户验收。

## 候选与命令

SDK `0.1.0`；两个直接 Pi 依赖均精确 `0.86.1`；Node 24.21.0 / npm 11.19.0 / TypeScript 5.9.3 / @types/node 24.10.1。

- `npm ci --offline --ignore-scripts --no-audit --no-fund --cache <repo>/.npm-cache`：从 lockfile 和本地缓存重建，不执行安装脚本。
- `npm run verify`：typecheck → 33 项离线测试 → 编译 JS/声明。
- `npm run example`：worker、模型回放、两轮工具示例。
- `npm run verify:package`：本地 npm pack；在新的临时目录离线安装 tarball 和固定消费者编译工具；运行公共导出消费者、TypeScript 消费者，并检查发行声明无 Pi 类型。

HTTP 测试把 fetch 替换为内存 Response；真实 pi-ai 编码/解码及真实 pi-agent-core 循环被执行，网络和 Provider 未被调用。没有把 mocks 的输出当真实 Provider 可用性。

## 覆盖及因果证据

| 验收 | 证据 |
|---|---|
| R01 worker 单次结构化结果 | `R01-red/green.log`；非法 JSON、length 停止拒绝 |
| R02 真正工具消费 | `R02-red/green.log`；第二轮断言实际工具结果；非法整批/未知/重复调用拒绝 |
| R03 授权与发布 | `R03-red/green.log`；写工具/混合批次拒绝后零效果、零后续请求；撤销发布没有 value |
| R04 累计与并发 | `R04-red/green.log`；跨实例共享 lease；各配额独立；`host-ledger-red/green.log` |
| R05 取消与未知执行 | `R05-red/green.log`；未结束操作继续 TASK_BUSY、迟到不发布、未知模型不退款 |
| R06 审计隐私与故障 | 回归覆盖首个/最终审计失败、UI 观察者失败/挂起、审计无原文；没有单独制造 R06 专用 causal RED |
| R07 中立边界及协议 | `R02-R07-negative-red/green.log`、`R07-http-*`、`result-snapshot-red/green.log`；OpenAI/Anthropic 离线两轮消费 |
| R08 回放与打包 | `R08-red/green.log`；请求错配拒绝、未消费报错；独立消费者验证公共导出/类型 |
| R09 固定依赖 | 包/lockfile 一致，无 coding-agent；`lockfile-ci.log` 和重新安装后的完整验证 |

首轮 HTTP 接线失败保留在 `R07-http-green-attempt1.log`：normalized transcript 与默认 max_completion_tokens 的理解错误，按 0.86.1 源码修正，不削弱行为要求。扩展配额测试失败保留在 `conformance-expanded.log`：工具预算原因被 Pi 工具错误转换覆盖，修正 latch 后不改变断言。

`package-consumer-red.log` 是独立新消费者依赖重新解析的真实失败：它试图获取本地未缓存的 undici-types 8.9.0。修正验证消费者，明确选择其 @types/node/TypeScript 精确工具链，再离线安装成功。没有改 SDK 依赖基线，也没有宣称生产者 lockfile 自动传递到消费者。

## 原始证据定位

持久根：本仓库 `artifacts/bootstrap/`（本机；未作 Git 备份）。保留历史失败与 GREEN，不删改历史结果。最终命令完整输出分别为 `final-verify.log`、`example-final.log`、`package-consumer-final-verified.log`；以其实际退出结果为准，不仅凭本文件描述。

发行候选 tarball 位于 `artifacts/bootstrap/delivery/`；最终打包日志列出内容 SHA-256、字节数、精确路径。每个新候选按内容 hash 另存，避免覆盖历史候选。`evidence-manifest.json` 汇总证据文件的路径、字节数和 SHA-256；manifest 不给自己做循环 hash，也不替代可读文件。

本轮代码、标准和证据均为本地未提交文件，未推送、无远程仓库。Git 保存、正式版本发布和产品采用是后续独立状态。

## 未验证与不宣称

- 未执行任何真实模型单轮/多轮/工具稳定性验证，全局标准 §7.5/§8/§11 仍未通过。
- 没有跨进程持久化 BudgetStore、审计数据库、崩溃恢复、企业权限或隔离验证；memory store 只是同进程参考。
- 没有完整工具/审计生产回放、真实业务证据库或自动学习。hash 和历史文件不等于执行消费或学习。
- 取消不是强制物理停止、补偿、事务或跨请求 exactly-once。宿主工具还需要幂等/恢复；元数据和合成夹具不能充当生产取证。
- 当前只验证 Node 工具链；没有浏览器 Renderer、Python 或其他版本 Node 的兼容证据。
- 两个独立消费者模式是 worker 和工具 agent，不是假称两个真实产品已接入。JuanerAI、其他产品及插件均未改动或迁移。
- 未做独立人工/Agent Validator；本轮为作者实现、自检和自动行为/发行接口验证，不标成独立验收。

本地交付完成不授予 Provider、真实数据、服务、Git 发布、产品迁移或上线权限。下一阶段若需要这些权限，先由用户决定。
