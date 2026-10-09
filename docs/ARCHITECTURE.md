# 架构与复用边界

以下运行图描述当前 SDK。2026-10-09 已批准完整接入原生 Harness；目标接线与状态见 [路线图](../HARNESS-ROADMAP.md) 和 [能力台账](NATIVE-HARNESS-COVERAGE.md)。当前普通运行使用 AgentHarness＋临时原生 Session，新增 createSessionRuntime 使用原生 JSONL 持久 Session（见 NATIVE-SESSION-CANDIDATE.md）；0.3.2 显式 checkpoint 仍走 Agent 兼容路径。完整共享接线及适用环境见 RELEASE-v0.4.md；JuanerAI 尚未采用，历史冲突处置见 [非原生扩展审查](SDK-EXTENSION-AUDIT.md)。

## 最小模块

| 模块 | 职责 | 不负责 |
|---|---|---|
| `index.ts` | 准入、授权、审计接线、独立取消/定时器、迟到栅栏、运行结果 | 业务状态机、正式报告提交 |
| `pi-adapter.ts` | 唯一 Pi 入口；Harness／Models 装配、旧 checkpoint Agent 兼容、真实 Pi 参数验证、协议/事件/错误转换、显式 HTTP transport | 权限权威、语义与资产模型 |
| `execution.ts` | 受限专属文件根与 macOS 单进程沙箱；显式宿主环境接缝 | 任意多进程/网络权限、业务授权 |
| `budget.ts` | 同进程原子任务配额参考实现；claim/预留/结算/release | 数据库、跨进程锁、故障迁移 |
| `validation.ts` | 输入限制、不可变授权快照、JSON 检查 | 产品业务正确性、数据匿名化 |
| `types.ts` | 中立公共 SDK 与宿主接点 | Pi 类型、JuanerAI 私有字段 |
| `testing.ts` | 合成模型录制/严格回放；独立测试导出 | 生产日志、真实动作重放 |

不机械拆成 tools/policy/context/providers/store 五个目录。已有深模块先容纳必要职责，避免在多个产品真实需求出现前建平台。

## 端到端执行

```text
产品 Application → 产品业务 Port → 产品 Adapter/composition root → 共享 SDK
  claim 稳定任务预算 lease → run.started 审计
  Pi Harness（旧 checkpoint 为 Agent）→ 模型授权 → 额度预留 → model.admitted 审计 → transport
  响应/用量验证 → token 结算 → model.finished 审计
  整批工具预校验 → 逐项授权/额度/审计 → 宿主工具 → 审计 → Pi 上下文
  单次输出校验或有界工具循环结束 → 发布授权 → 完成审计 → lease 结算 → 返回
旁路：安全审计事件 → UI observer（不作为准入或业务完成权威）
独立取消/截止时间：关闭新效果 + 拒绝迟到成果；后台保留未知操作占用
```

模型输出不支持的工具、非法参数或重复调用身份会在执行前拒绝。工具可按运行选择并行，单工具 sequential 声明令整批串行；仍逐项授权/原子预留，单 run 审计 append 排队串行。并行不是事务，已启动操作的未知效果仍保留 lease。Pi 参数校验包含它自身的类型转换语义；敏感业务类型还需在工具入口做严格领域检查，不把 SDK schema 当权限系统。

thinking 能力配置进入模型/任务身份，由 Pi 编码协议参数并保留签名续接。公开接口只暴露中立 reasoning 块，不暴露 Pi 类型；它不进入最终文本或普通审计，但自定义 transport/授权接点会接触完整块。跨模型转换可能把未屏蔽思考转为文本上下文，须纳入候选外发授权。runText 和严格 JSON Worker 共用无工具单次阶段，工具 Agent 共用有界循环；单阶段 fallback 可产生多次物理请求。

## Pi 已提供与本包补齐

以下来自实际安装的 0.86.1 导出、声明和实现，而非旧版本记忆：

- pi-ai：统一模型/流接口、协议适配、normalized transcript、工具参数验证、usage 表示等。本包复用协议编解码，并完整构造 assistant usage，避免历史消息缺字段。
- pi-agent-core：Agent/工具循环、顺序/并行执行选择、before/after tool hooks、turn 停止 hook、abort、事件订阅等。本包调用真实 Harness（旧检查点保留 Agent），不手写模型工具循环。
- core 的 session、compaction、skills、工具工厂及 Harness 等导出需按具体能力评估；不是无条件可用的业务恢复/安全体系，也不是都未实现。这些正式机制已通过中立门面接线，逐项见能力台账；不另造一套会话或压缩系统。
- 本包新增的价值是跨产品一致的宿主接缝、逐次准入、预算/墙钟双线、原始故障原因保留、审计隐私、迟到栅栏和合成回放。Pi hooks 是接点，不等于业务授权、硬预算或外部隔离已经自动完成。

安装包源码定位：`pi-agent-core/dist/agent.js`、`dist/agent-loop.js`、`dist/types.d.ts`；`pi-ai/dist/types.d.ts`、`dist/utils/transcript.js`、`dist/utils/validation.js`、`dist/api/openai-completions.js`、`dist/api/anthropic-messages.js`。锁文件固定验证版本，node_modules 不作为永久证据；失败及最终结果保存在 artifacts。

## 有意不做

不实现第二 Runtime、registry/hot switching、中央网关、企业租户、通用插件平台、隐藏自动 retry、供应商怪癖库或跨语言服务。原生会话、恢复核查、手动/自动 compaction 已在新门面实现并完成合成验证，需显式宿主配置；完整生产采用尚未发生。v0.2 新增的显式有序模型 fallback 在同任务授权／预算内执行，不是第二 Runtime 或热切换正在执行的配置。

上下文目前是宿主装配的 system/prompt 与 contextVersions；不是 Semantic Context Runtime 或 Analysis IR compiler。分析计划实际执行、数据权限与证据报告回链仍由 JuanerAI 业务核心验证；Runtime 统一不自动统一业务契约。

Node/TypeScript 是首版实现形态，不声称 Python、浏览器 Renderer、所有插件宿主可直接运行。Electron 应在获授权的 Main/后端边界使用，不能向 Renderer 泄露 Provider 密钥。非 Node 产品如需桥接，先定义有界的产品 Adapter，不能偷偷扩成常驻共享服务。
