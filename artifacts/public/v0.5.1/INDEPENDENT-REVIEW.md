# 0.5.1 独立发布审查

适用固定包：148236 bytes / SHA256 3af3f895a2466b7947b9b9b0025231f856e3a5c4773782c9dabd460e924bfad9。基准为固定 .3 源清单及包，原 baseline b07057f 仅原始 Git 基线。两位独立审查者均只读，未修改文件、未重跑测试、未访问 Provider；不声称 OS 强制只读。Mini F-ROLE-01 豁免没有用于本 SDK 审查。

## Standards

独立审查者 release051_standards：PASS，0 未闭合。独立重算正式/原候选包身份、全部 53 实际安装文件及非软链接路径、98 源文件、23 个 dist 与 .3 一致、151 项非根 lock 不变。最初提出工程交接中的本机路径/SSH 别名公开问题；当前发布文档副本已中立化，原固定包/原件不变，复核关闭。公开元数据及 65 成员消费者归档未见绝对机器路径、真实凭据、原始历史日志或 node_modules。运行代码无新增变更，不为异味扩大范围。

## Spec

独立审查者 release051_spec：PASS，0 未闭合。直接读取两 tgz，23 dist 完全相同、无删除；仅版本及六项文档变更/新增。98 文件来源 aggregate 4568f55b8be2238c767abd714f45f7d34de131fce21141a2ea361e17015792dc 匹配。API、最终投影/guard 顺序、failureCategory、用量/UNKNOWN、once-extra、回执与兼容边界一致。只读 git show 核对 Mini 固定产品提交，限定离线接受、原 .3 采用、F-ROLE-01/技术 PASS/精确豁免未被扩展。

两者独立读取 root 的 verify/consumer/public-consumer 退出码与日志身份：274+2、71+6+7、公开71均 PASS，旧Task/UNKNOWN/迟到/恢复核账及原read9场景有证据。此为独立身份/源码/记录核查，不是独立重跑全套测试。相同实现的原 .3 Standards/Spec 评审只按匹配字节复用；历史 RED/GREEN 与修正记录保留在本机原目录。

Git commit/Tag/Release 和附件下载读回在评审时尚未形成，另由最终发布收据记录。评审 PASS 不表示正式版已被 Mini 安装或产品验收通过。
