# SDK0.4.2候选：MiMo显式思考开关

状态：本地兼容候选，未发布、未被JuanerAI安装；0.4.1历史包与已安装字节保持。源基线703a2649090e5e145a86479dce0ced675d011035；分支codex/mimo-thinking-compat。用户已批准共享SDK最小兼容修正及固定交付后的有界产品对照。Pi两包精确0.86.1、其他依赖、运行护栏和标准v0.3不变。

合同见[MIMO-THINKING-CONTRACT.md](MIMO-THINKING-CONTRACT.md)，接法见[INTEGRATION](INTEGRATION.md#042候选mimo显式思考协议)。新增可选thinkingProtocol:'mimo-chat'进入ModelConfig/设置编译及任务配置身份；内部复用Pi兼容映射。未选择选项行为不变。普通/持续Agent、Text、Worker由原共享传输接点消费，无新增恢复机制或协议修补器。

实际因果RED→GREEN、完整测试、类型/构建与真实解包消费证据由Change005唯一设备证据根shared-sdk-thinking071保存。GREEN001最初精确4096期待忽略Pi原生上下文收窄（实际4093），保留失败后改为验证不扩大单次上限；不改运行护栏。正式数据/Provider不由本SDK候选测试发送。

当前固定产品包仍为0.4.1；本候选必须正常固定交付后按产品原生任务配置采用，仅用于批准的MiMo工具对照。旧Task直改返回CONFIGURATION_CHANGED，历史失败/UNKNOWN/用量不能清零。回滚依旧0.4.1精确包和旧配置任务，新增协议Task不能静默改回；先核账、确认物理空闲并按宿主明确迁移条件处理。发布、SDK机制通过、产品真实用途验证、正式启用与用户验收分开报告。

## 本地机制结果（2026-10-11）

因果RED保存：显式开关缺失/无效配置未拒绝/设置字段不支持；受影响GREEN50项，完整196核心+2UI全部PASS、0跳过，类型与构建exit0、source_drift=[]。真实解包原生/不封顶旧消费者PASS。完整日志、退出及源清单在设备证据根shared-sdk-thinking071。共享机制独立审查待完成，真实MiMo关闭思考对照尚未执行；不宣称发布/安装/超时根因确定。
