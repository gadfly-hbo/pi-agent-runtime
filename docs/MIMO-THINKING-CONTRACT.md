# MiMo 思考协议兼容候选

2026-10-11：原 Change005 用户明确同意正式补齐共享 SDK MiMo 显式思考开关，并在固定交付后做一次有界产品对照。基线 SDK0.4.1，703a2649090e5e145a86479dce0ced675d011035；本候选不改已发行包、不自动迁移产品或启用 MiMo 主链，不新增 Provider/凭据/预算/Git 发布权限。

## 合同

- MT01：ModelConfig 新增可选、中立 `thinkingProtocol:'mimo-chat'`，仅适用于 openai-completions 且 reasoning:true。宿主确认模型能力后显式选择，不依 provider/id/endpoint 名字猜测。
- MT02：选用该协议后，thinkingLevel 省略/off 编码为 thinking.type=disabled；其余合法等级编码为 enabled，不承诺 MiMo 支持各等级强度。关闭 unsupported reasoning_effort。保持实际 provider/model/endpoint 和单次输出上限。未选用的新旧消费者保留原标准映射，off 仅不请求启用。
- MT03：复用 Pi0.86.1 内部已有 thinking 编码/assistant reasoning_content 续接能力。工具多轮保留原思考块和工具关联；不剥离块、不自造循环/HTTP body 修补器、不改安装依赖。
- MT04：无效协议值、协议不匹配、未声明 reasoning 能力在模型效果前拒绝。公共接口不暴露 Pi compat 类型。新字段属于不可变模型/用途配置，旧 Task 改绑拒绝，不清账、不伪造迁移成功。
- MT05：模型设置编译支持同一显式字段并验证/保留它。无需新增用户配置 UI 或更改既有 UI；由宿主受控后台配置采用。
- MT06：真实产品对照仍需要有效资源窗口，使用原凭据入口和合成资料，不启用默认 MiMo 链。离线 wire 通过不是超时根因证明或产品能力 PASS。历史 16 笔 UNKNOWN 及全部消耗保留。

## 因果验收及允许修改

先在真实 createPiTransport/Pi 编码器与 createRuntime 工具多轮消费建立行为 RED，再最小 GREEN：MT01/02 出站开关、无非标准强度字段/旧形态、MT03 真实工具结果及思考块后续消费、MT04 配置/授权前拒绝及任务配置变更、MT05 设置编译正反例。运行完整共享套件、类型/构建/UI和解包消费者检查；环境条件测试按已有许可，不以跳过冒称通过。

允许 src/types.ts、src/validation.ts、src/pi-adapter.ts、src/settings.ts、对应 tests、必要版本/锁文件及此合同/接入/标准/版本说明；禁止其他依赖升级、Runtime/存储/预算/重试/权限/UI重构。Pi精确0.86.1保留。候选版本与包hash在打包后记录，发布和产品采用分别报告。

## 来源

官方 MiMo 文档明确 Flash 默认开启思考，thinking.type=disabled 显式关闭；启用时工具续接须完整传递 reasoning_content：
https://mimo.mi.com/docs/en-US/api/chat
https://mimo.mi.com/docs/en-US/quick-start/usage-guide/other/deep-thinking

当前 SDK off 的离线 wire 未带 thinking 字段；这是兼容能力缺口，不是已证明的超时根因。产品侧原始超时/诊断见 Change005 唯一证据根 business-handoff069 及 checkpoint070，不能覆盖失败。
