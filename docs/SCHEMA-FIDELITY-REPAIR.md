# A：固定 .3 的工具 schema 编码保真修复

2026-10-18，用户授权在原 SDK 任务内先离线复现、最小修复并交本地固定新候选。
基线 main `14d548f625cab8760269fe877153c1596ff84373`；原工程树无 WIP，
本次使用同树隔离分支 `codex/harness-schema-fidelity-20261018`，不改消费者工程。
原 `.3` 167472 bytes / SHA256 `e6cf0c99cfbcb43ae0b197e9d45d82bae20c0c3257ba0e7bad131f6b1778e12a` 保留。

## 最小行为与验收接点

公开 createSessionRuntime/ToolView → createPiTransport → 同版 Pi Anthropic 编码 →
合成 fetch 中的最终协议 DTO，是用户已确认的测试接缝。固定工具与阶段取 allOf 交集；
模型最终 input_schema 与执行端使用同一完整约束，不由编码器默默删掉根关键字。
先用交接包未修改的消费者记录原包 RED，再用同一消费者验证新候选 GREEN；
平面对照也须继续成功，不能以全部拒绝代替修复。

优先复用 Pi getCurrentTools 与 onPayload；仅 SDK 适配边界修正非 strict Anthropic
根 schema 裁剪，不改变消息、工具顺序/身份、参数准备、strict 配置、原生循环或权限。
不实现 schema 展平/合并/推断引擎，不修改 node_modules/Pi，不承诺真实 Provider
或任意 JSON Schema 方言支持。无法编码的非 JSON/非 object 参数或异常原生工具映射
在物理发送前安全拒绝；已发送的原请求与 UNKNOWN 不因拒绝后续请求而退款。

覆盖最终 DTO 中 required、enum、additionalProperties、受影响根对象约束及嵌套/联合、
合法参数/缺字段/阶段外值、工具执行一致性和不支持形状的零发送；保留旧协议/调用、
R1～R4、批屏障、取消/终止、物理 view、计量及 UNKNOWN 不重放。
完整结果集中做 verify/example、适用固定同 tgz 消费者和独立只读审查；无需真实 Provider。
新候选精确版本为 `0.5.3-harness.4`，本地固定交付，不覆盖任何旧包。

## 独立事项 B 与保留边界

B 只核对公开 Authorization/Audit/BudgetStore/Session 能否可靠组合共享业务工作恢复，
必要扩展仅报方案，不新增公共契约/持久结构；不阻塞 A。原跨 purpose 五次观察符合
逐逻辑请求 once-extra，不称 SDK 违约 RED；OUTPUT_LIMIT/CONTEXT_LIMIT 复用已有载体。
原产品任务和消费者工作不接管；历史物理调用、token/费用 UNKNOWN 及全部历史
FAIL/BLOCKED/UNKNOWN/因果 RED、累计消耗和预留保留。历史工具名缺失的精确因果仍 UNKNOWN。
本轮不恢复/重放旧任务、改资源值/模型/补发策略、联系其他 session、提交/推送/PR、
正式发布/真实 Provider/生产或消费者升级。结果和 A/B 分项证据保存在原任务资料内。
