# SDK 0.4.0：原生 Harness 接线合同

状态：共享源码完整合成验收与独立只读复审 PASS；原本地不可变 tgz 已原样发布到 GitHub v0.4.0 Release；公开字节身份见 artifacts/public/v0.4.0/RELEASE-RECEIPT.json。Git首次提交与双设备同步不改变原包，未发布到npm注册表。精确依赖保持 `pi-ai + pi-agent-core 0.86.1`，标准仍为 v0.3。此次新增公开持久会话与控制合同使用 0.4.0，不覆盖历史 0.3.2 包。

## 已实现的完整机制范围

普通运行和持久持续任务均由原生 AgentHarness 推进。JSONL 会话、分支/Fork/导航/恢复、Skills/模板、自动/手动压缩、分支摘要、队列/撤回/停止、配置/观测/扩展、工具 memo/progress/replay、文件/进程执行接缝、图像输入和可选 proxy/deferred 均有中立接线及合成消费者。逐项能力、来源、配置、正负例和产品采用状态见 [能力台账](NATIVE-HARNESS-COVERAGE.md)。接口型搜索和 experimental/pico3 不伪称成可启用的正式功能。

“完整接线”覆盖这些正式 Harness 机制，不表示所有 Pi 低层导出原样成为产品 API，也不表示所有 Provider/平台/执行权限默认开放。产品持有业务、权限、成本和完成定义；共享层没有复制 Pi Session/压缩/工具循环。

## 中立入口与默认行为

- `createSessionRuntime`：必需 budgets、storage、bindOperation、reconcile；create/list/history/inspect/result/update/fork/delete/run/control；保留 runAgent/runWorker/runText/waitForIdle。
- `run`：prompt/skill/template/compact/navigate/resume/abort。resume 只推进已存在 Operation；压缩/导航恢复返回原生摘要。返回新增 `suspended/DEFERRED` 分支，消费者须处理。
- `control`：活跃绑定任务/会话/分支可 steer/followUp/nextRun/cancelQueued/abort/snapshot；空闲或重启后原Task/purpose可snapshot/cancelQueued，无须先启动模型；先授权与可靠审计。内容快照需显式 includeContent。残留队列所有权写入 native Session value，跨 Task/purpose 或缺失身份拒绝推进；产品先核账处置，SDK 不自动改绑。
- `harness`：固定 Skills/templates、队列模式、retry、compaction、deferred 和 extensionVersion，进入任务配置身份。retry/compaction/deferred 默认关闭；产品按需要明确开启，不能拿默认关闭当作未接线。
- `extensions`：原生上下文/请求/工具/结束 Hook 与 custom entry projector；版本由可信宿主固定。Hook 抛错按 Pi 继续机制处理，授权/预算/审计仍在物理效果边界。
- `onHarnessEvent`：安全身份与事件类别旁路；不携带原始 Pi 对象，不是可靠审计。不承诺每 token UI 流。
- `loadHarnessResources`：仅显式绝对可信路径，source 逐项授权，原生 source loaders 加载；返回诊断和内容 digest。路径是宿主管理的可信树（包含它允许的链接），不是供模型探测任意文件的 API；不扫描 home 或 coding-agent。
- 工具第三参提供 native invocation 的中立身份、getMemo/setMemo/update；replay 默认为 never。safe 是宿主对幂等/回执恢复的声明，实际恢复仍核授权、预留、审计；未知不自动重放。

## 受限执行环境

`createExecutionTools` 使用 Pi 原生 read/write/edit/bash 工厂，接到宿主 `ExecutionEnvironment`。任务只获得显式列出的工具；文件/外部效果仍经过逐次授权。

本地 `createLocalExecutionEnvironment` 要求专属绝对根、exclusiveWorkspace、policyVersion、文件/输出/时间上限。文件拒绝路径越界、符号链接、硬链接与非普通文件，nonblocking/no-follow 打开后再核类型。可信宿主须保证专属根及祖先不被其他主体并发替换，不把原始 Session/凭据放入模型 workspace。

`processes:true` 仅在 macOS OS sandbox 中可用：文件读写限制、无网络、禁止 fork，输出/单文件大小/CPU/墙钟受限，取消等待受监督进程退出。shell 内建可直接使用，外部程序用 `exec /path/program` 替换 shell；管道、后台进程、subshell、会派生进程的程序会拒绝。禁止 fork 的目的是让 setsid/换进程组无法逃逸监督。未提供硬内存/总磁盘配额；这不是任意不可信代码的通用多进程沙箱。非 macOS 或不支持 OS sandbox 时明确不可用，无无限 Node 回退。

需要分析计算多进程、额外网络或更强资源隔离时，产品提供满足接口合同的容器/虚拟机等执行后端，并验收其资源与生命周期边界；SDK 的原生工具接线无需重写。此次未安装容器、启动服务或开放任意网络。

## 所有权、成本和恢复窗口

Pi JSONL 保存协议上下文及原生运行状态。产品预算/审计/业务 SQLite 保持权威。storage.acquireWriter 首版独占专属存储根，覆盖所有读写（原生 open 可能修复尾事务）；不同 Session 也不能绕过此独占。bindOperation 在原生 accept 前持久确认 Task/purpose，重复绑定幂等且不能改归属。reconcile 在每次推进前核账、核授权及外部回执。

权威预算 claim → 可靠绑定 → native accept → 每次物理请求/工具授权、预算预留、可靠审计 → 实际效果 → 结算/审计 → 原生提交。没有跨存储原子事务或 exactly-once 保证。工具效果发生后 Session 提交失败，保留失败和消耗，未知效果不重放。原生摘要请求在 effect_pending 崩溃可能终止为失败；宿主核账后创建显式新操作，不偷偷重复远端请求。

主备、原生 retry、压缩、摘要、deferred 的 start/poll/cancel 全部使用同一 Task 账本。先按声明路由切换，再由有界 native retry 重试当前候选；quota 不重试。异步 poll/cancel 需要显式声明支持的 transport；内置同步 Pi transport 不虚构该能力。异步初次调用的未知 token 预留不退款，建议显式 maxOutputTokens 为后续轮询留出预算。取消请求不证明 Provider 已撤销或退款。

## 兼容和回滚

旧 Worker/Text/Agent 与 0.3.1 immutable purposes 保留；0.3.2 checkpoint/saveCheckpoint/shouldYield 继续兼容，不与新 SessionRuntime 同时控制同一会话。旧 RunResult 的消费者需要增加新的 suspended 分支处理（只由已启用 deferred Session 产生）。Pi 类型不进入公开 d.ts。

新任务采用原生会话；旧任务、历史消耗和未知状态先核账，产品另行执行已批准迁移。SDK 不迁数据库、不删旧检查点、不自动换 Task ID。回滚固定旧包，仅把兼容入口/新任务路由切回；不能用旧0.3.2读取新 Session 或恢复其未完成操作。保留新 JSONL、预算和回执，直到可在0.4.0核账处理。与同一Pi版本的0.4.0重开由进程测试覆盖，不承诺Pi未来跨版本格式兼容。

## 验证与尚未启用

完整验收包含类型、所有核心回归、构建、UI、native conformance、真实磁盘/独立进程、故障注入、真实本地单进程OS隔离、loopback代理和提取tgz后的独立消费者。消费者编译中立声明，运行原生文件工具及会话再开实际消费；使用已有精确依赖树，未安装依赖，不能称全新联网安装验证。

失败日志与独立 NEEDS_FIX 评审保留在 `artifacts/full-harness-20261009-001/`，最终验证和修复复审另存。完整源码验收 verify-full-003.log：162项核心检查、2项UI检查通过，零跳过；类型与构建通过。独立打包命令 `npm run verify:harness-package`。包SHA与最终评审以冻结收据为准。

**未启用/未知**：JuanerAI 生产采用、Analysis IR真实执行、专业内容质量、真实双模型、真实数据、所有其他平台/Provider/宿主沙箱。基础包 PASS 不能代替这些 Gate。用户要求的 Mini 等待此包后接入仍有效，本轮未操作 Mini 或发送会话消息。
