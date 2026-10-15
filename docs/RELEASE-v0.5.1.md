# SDK 0.5.1 · R1–R4 正式发布

2026-10-15。由固定 `0.5.1-r1r4.3` 晋升，正式 tgz 单独生成、隔离安装验证。源码 `src/`、测试、构建产物 `dist/` 与候选逐字节核对；仅版本/锁根元数据、当前文档及筛选发布材料变化。旧包/源码快照/API001–004/失败原件保持原样。发布事实以 v0.5.1 Tag、GitHub Release 及下载读回收据为准，不发布 npm。

候选：146131 bytes，SHA256 `e02175ff42eaa83b994e6f49a1e041b4b3f0b9c807b0b8c192a7dfd836f70cce`。原基线 `b07057faaecd919109fff6adaca8f9365be95ccc` 不含全部修复；修复由 84 文件 WIP aggregate `c22952fa75a825faee71e2d2b2fe2e7e438a0614fbc14f1fa2f4be1ea62f8eca` 固定，正式提交见发布收据。没有夹带其他 0.5.0 候选。

## 现行接口与接线

完整签名和示例以包内 dist/*.d.ts、[工程合同增量002/003](R1-R4-ENGINEERING-HANDOFF.md) 为准；工程合同早期进度为历史。API003 的 R2/R3 与 API004 的 read 载体均已实现，不重新列为待定。

1. 新 Task 显式选择 `contextAdmission`、`modelObservations:'v1'` 和相应 purpose/工具输出策略。Runtime 与每个 `createPiTransport` 同时开启 v1；宿主 BudgetLease 实现 `recordModelUsage` 原子部分计量。不得热改旧 Task 配置。
2. 每候选授权覆盖实际接收方、协议/thinking/images；宿主 transport 完成真实 system/tools/schema/history 投影后调用 `admitModelRequest`。guard 后使用同一冻结 DTO，经宿主物理账本准入再发 HTTP。observer、50KiB read 页或 1MiB 工具存储限制都不能代替 token 窗口检查。主请求、压缩/摘要和恢复逐次经过同一接缝。
3. `createExecutionTools(host,['read'])` 复用原生 read schema、offset/limit、content/details 与续读。宿主提供获准资料映射/撤权/完整本地计算；超长单行应提供窄文本资料视图，提示 bash 不授予 shell 权限。
4. `RunResult.toolOutcomes` 和 `AuditEvent.toolOutcome` 的可选 `failureCategory` 枚举为 `not_found | not_directory | is_directory | permission_denied | invalid | not_supported | cancelled | timeout | limit_exceeded | unknown`。观察需既有 v1 或工具 modelOutput opt-in；旧未观察结果不补造字段。缺字段保持 UNKNOWN，不从 TOOL_FAILED 或原异常文字推断 UI 原因。既有 reason 不变，分类不授权重试/退款。宿主取消与超时用受信结构化错误；native 截断/续读是成功内容，host 限额是失败类别。
5. `ModelOutcome` 保留 stop/category、实际候选/responseModel、physicalStatus、已知 usage 和 usageFinal；`recordModelUsage` 保留 known-zero/partial 与未知预留。Worker 拒截断，Agent 使用适用 native 恢复；fallback/retry/recovery 共用 once-extra，辅助调用同 Task 授权计量审计。未结调用不退款，已完成/UNKNOWN 工具不重放。
6. `Tool.modelOutput` 在完整结果/效果之后提供有界完整 JSON 或宿主可读引用；`ToolOutputFailure` 与 `ToolOutcome` 保留匹配 invocation、effect、receipt 和 resource。输出超限不是未执行，不能丢回执、裁坏 JSON 或 soft success。内容/引用可读性、保存及产品生命周期由宿主持有。

## 兼容、回滚与范围

旧省略新策略的配置 hash、用途、Skills/fork/history 保留。新策略需要新 Task 或另行明确迁移合同；不自动迁移、恢复或重放。回滚必须核对旧包能理解的配置/载体与持久账本；不能用旧版本自动 resume 新状态、清消费/预留或退款 UNKNOWN。Skills 不能覆盖宿主权限，fork 不能重置 Task 消耗；无第二 Session、分页或恢复引擎。

Pi core/ai 仍 0.86.1，openai 6.40.0 仅同版本 SSE framing；相对候选无依赖变化。R5/R6、完整 coding-agent、认证继承、Shell/Edit/Write/网络权限不新增。

## 验证与产品状态

正式包隔离消费者、类型、构建、受影响正负向、旧任务/历史、UNKNOWN/迟到/恢复核账与独立评审结果在 Release 附件。原 .3 评审只按完全匹配的运行/测试字节复用，正式安装/hash 另验。

JuanerAI 已采用原 .3 包；PR #83 合并提交 `07f6ec36bd1efc275e89322384adef94440cdd03` 的接受只覆盖 R1–R4＋D1–D8 A 离线合成、显式 opt-in。原及当前 Validator BLOCKED F-ROLE-01、技术评估 PASS、用户对此精确候选的具名豁免分别保留；Mini 豁免不适用于 SDK 发布评审或新包。正式版发布不意味着 Mini 换包，其他产品未升级。

生产 overhead/margin/image、历史故障归因及未知消耗继续 UNKNOWN。512/8192 仅合成参数；961743 bytes 仅旧观察。没有真实 Provider/凭据/业务数据验证，没有生产切换、服务、部署或历史 Task 操作。
