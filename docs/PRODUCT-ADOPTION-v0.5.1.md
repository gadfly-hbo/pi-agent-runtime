# 转交产品 Agent：SDK 0.5.1 正式版接续

沿用你的既有任务、分支、工作树和已批准范围。本消息是固定 SDK 发布回执与采用评估材料，不自动授权换包、真实 Provider、生产切换或其他产品升级。Mini 当前采用 0.5.1-r1r4.3，146131 bytes / SHA256 e02175ff42eaa83b994e6f49a1e041b4b3f0b9c807b0b8c192a7dfd836f70cce；已完成的限定离线接受和历史证据保持。

从 https://github.com/gadfly-hbo/pi-agent-runtime/releases/tag/v0.5.1 取得正式 tgz、SHA256SUMS、RELEASE-RECEIPT、源码/依赖/内容清单、逐文件候选差异及验证/评审记录。先校验实际 bytes/SHA256/SRI 和最终 Tag/commit；未取得文件不能把版本号或 URL 当已收到。正式包与 .3 运行字节相同，但新包 hash 和安装采用须单独核对。无安装授权时只读评估并回交准确状态。

获准采用后使用本任务隔离安装及产品 lock，逐文件核对包和实际解析路径，不用在研源码、软链接或 node_modules 补丁。先完整读 docs/AGENT-RUNTIME.md v0.3、RELEASE-v0.5.1.md、R1-R4-ENGINEERING-HANDOFF.md 的最终增量和实际公共类型。R2/R3/API004 已闭合，不重造接口。

接线顺序：每候选授权 → transport 最终真实 schema/system/history 投影 → admitModelRequest → 同一冻结 DTO 的物理账本准入 → HTTP。每候选、压缩后、摘要/恢复都重查；Runtime/PiTransport 同开 modelObservations v1，持久 BudgetLease.recordModelUsage 原子记录 known-zero/partial/UNKNOWN。原 purpose.fallbacks 与恢复共享 once-extra；全部辅助物理调用同 Task 计量审计，不重放成功/UNKNOWN 工具。

read 仍用 createExecutionTools(host,['read'])，宿主授权资料映射，原生 offset/limit/content/details。按 RunResult.toolOutcomes / AuditEvent.toolOutcome.failureCategory 封闭枚举显示安全原因；缺字段为 UNKNOWN，不从文字或 TOOL_FAILED 猜因。cancelled/timeout/host limit_exceeded 分列；native 截断续读不是限额失败。Tool.modelOutput/ToolOutputFailure 保留完整宿主内容、效果、匹配 invocation、receipt 与已知资源；输出超限不重放、不假装未执行。

仅对正式换包受影响链路核验 Application→Adapter→实际 tgz→IR/核验→Outcome/UI，保留 read 分类、撤权/取消/超时、UNKNOWN/迟到、已知用量/持久故障、工具一次、旧配置/历史、恢复核账及最终 guard 拒绝断言。可复用匹配未变证据，不机械重复全产品验收；新安装身份不能借用 .3。SDK PASS、文件送达、安装采用、产品接受分别报告。

生产 overhead/margin/image 仍 UNKNOWN 时失败关闭，禁止照搬 512/8192 或 961743 bytes 放行。保留旧 Task、Skills/fork 的权限和固定配置、历史消费/预留/失败/UNKNOWN。不得自动 resume 新状态、清账/退款未知、迁移/重放。原 Validator BLOCKED F-ROLE-01、技术 PASS 与用户精确候选豁免不改、不扩展。真实 Provider、凭据、业务数据、生产/服务、部署、其他项目、Git 操作均按目标项目另行授权。不要联系其他 session。

回交实际包身份、安装/解析身份、适用验证命令与退出码、旧配置/历史保护和未验证项。共享缺陷应附固定包、最小合成复现、预期/实际与证据，由用户转交 SDK；不把业务所有权问题升级成通用 SDK 存储/恢复功能。
