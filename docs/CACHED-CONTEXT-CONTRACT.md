# SDK0.4.3 · 缓存上下文计量兼容修正

用户在原Change005 v1.3批准cached-context100有界决策。本增量仅修正现有Pi Provider→中立ModelReply→原生Harness的usage桥接；不重写会话/压缩引擎，不修改不可变配置、模型分工、上限、授权或历史。

## UC100验收

1. `ModelReply.usage.inputTokens`计全部已报告输入（非缓存+缓存读取+缓存创建）；可选`cacheReadTokens`/`cacheWriteTokens`是该总数的互斥子集。复用Pi已归一的分类，不按Provider名称重算，OpenAI prompt_tokens已包含缓存，不能再叠加。旧自定义Transport省略分类时沿用原input/output定义，配置签名不变。
2. 原生AssistantMessage保留分类，并以`input=total-cacheRead-cacheWrite`重建；总上下文=全部输入+输出。持续JSONL、临时Harness及旧checkpoint Agent路径都使用同一桥接。不伪造价格。
3. 全部已报告输入进入现有权威Task结算，不改变输出预算。零/缺失输出沿用既有保守上限预留合同；缺失输入不推测补值，0不证明免费或完整计量。失效/失败/取消保留历史UNKNOWN及预留。
4. 缓存分类须非负安全整数、和不大于inputTokens；错误usage在结算/后续工具效果前拒绝。旧消费者不需改BudgetStore或持久schema。
5. 原生自动压缩须在缓存占主要上下文的真实HTTP合成输入中触发，压缩摘要进入后续请求；摘要及后续请求仍共用Task预算、授权/审计，拒绝与耗尽护栏不变。
6. 固定0.4.2旧运行/JSONL/账本由0.4.3同Task继续，configuration签名及历史数值不变，不重算旧usage、不批量清零。安装包新版本固定字节及独立只读评审通过后才采用；原0.4.2回滚字节保留。

已确认RED：real134 SSE1139报告26399非缓存+297849缓存，旧SDK仅保留26399，实际324248输入；max_tokens截断不是已证明由本缺陷单独造成。本次离线测试不发Provider；产品补验复用既有有效窗口/额度，无新增预算/Git发布。
