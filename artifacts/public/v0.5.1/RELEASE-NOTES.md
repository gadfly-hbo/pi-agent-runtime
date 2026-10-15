# Pi Agent Runtime 0.5.1

R1–R4 共享机制正式发布。运行源码、测试及 23 个 dist 文件与已接受的 0.5.1-r1r4.3 候选相同；新包仅版本元数据和当前说明不同。逐文件差异见 CANDIDATE-SOURCE-DIFF / CANDIDATE-PACKAGE-DIFF。标准仍 v0.3，Pi core/ai 0.86.1，openai 6.40.0，非根锁依赖 151 项未变。不发布 npm。

固定正式 tgz：pi-agent-runtime-0.5.1.tgz，148236 bytes；SHA256 `3af3f895a2466b7947b9b9b0025231f856e3a5c4773782c9dabd460e924bfad9`；SRI `sha512-8mfN4/Aw5wr0/ur8WK9wphP+7l6BLL3IX5MwokjSvj8GGzvU5+laAVwomt/HdHXvIJJhsAdiW8Zj7BJtaS7BhQ==`。最终 commit、Tag 与 Release 下载读回见 Release 附件 RELEASE-RECEIPT.json。新包未继承旧包安装或采用结论。

完整本机离线 verify：274 核心＋2 UI、类型/构建 PASS，零失败/跳过。实际正式 tgz 独立 npm ci：53 文件匹配，无源码链接；71 公共边界、Mini003 六项、Mini002 七项、三组真实 Pi codec、九组 read 强断言、18 投影样本（16准入/2拒绝/0物理）、旧 Task/history/已知用量/UNKNOWN/迟到/恢复核账及严格公共类型 PASS。正式包 SDK 验证不等于产品验收。

可复跑公开子集：下载并解开 pi-agent-runtime-0.5.1-consumer.tar.gz，在支持的 macOS / Node24.21.0 / npm11.19.0 上，使用获准准备的独立精确依赖缓存运行 `SDK_INSTALL_CACHE=<cache> sh consumer/RUN.sh`。内含固定包、锁文件、71 边界测试、类型/旧Task/codec探针；已另做 fresh npm ci 实跑通过。完整 Mini 原材料及原始日志保持本机，不公开原始交接归档。验证摘要/原日志身份见 VALIDATION.json；源码及依赖清单随附。

相同实现复用的原因果证据：R1 超大 system/schema/retained tail 放行→guard 拒绝；R2 length/context 分类抹除→原生适用恢复及安全 usage；R3 执行后输出超限→效果/回执保留；read missing/取消优先级 RED→GREEN。旧 .1/.2/.3 包及全部失败保留。正式发布没有新增运行改动，不伪造新的实现 RED；新包安装及独立发布评审另记。

现行 API/调用顺序见包内 docs/RELEASE-v0.5.1.md，转交产品 Agent 使用 docs/PRODUCT-ADOPTION-v0.5.1.md。最终受信投影后必须调用 admitModelRequest，物理账本/HTTP 前使用同一 DTO；所有候选/摘要重查。modelObservations v1 + 原子 recordModelUsage；原生 read 的 failureCategory、安全 UNKNOWN 与 host 限额/native续读分开；Tool.modelOutput/ToolOutputFailure 保留匹配 invocation/effect/receipt。恢复/fallback 共用额度，不重放成功或 UNKNOWN 工具。

JuanerAI PR #83 已合并到 `07f6ec36bd1efc275e89322384adef94440cdd03`，实际采用仍为 .3，146131 bytes / SHA256 `e02175ff42eaa83b994e6f49a1e041b4b3f0b9c807b0b8c192a7dfd836f70cce`。接受仅 R1–R4＋D1–D8 A 离线合成、显式 opt-in。原及当前 Validator BLOCKED F-ROLE-01、技术 PASS、精确候选用户豁免分别保留；豁免不适用于本 SDK 发布审查或新包。正式版未在 Mini 换包采用，其他产品未升级。

回滚保留旧固定包与 Task 配置；先核物理空闲、账本、Skills/fork/history及载体兼容。不得清账、退款 UNKNOWN、自动以旧版 resume 新状态或迁移/恢复/重放历史 Task。生产 overhead/margin/image、历史故障归因和未知消耗仍 UNKNOWN，512/8192 仅合成值、961743 bytes 仅旧观察。真实 Provider、凭据、业务数据、生产/服务/部署未执行。R5/R6 未交付。
