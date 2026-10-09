# GitHub 与双设备同步

仓库：https://github.com/gadfly-hbo/pi-agent-runtime 。用户已明确选择公开仓库；只发布审查后的项目内容。

Git 跟踪源码、测试、锁文件、文档、原型源码及筛选后的 artifacts/public 发布证据。本机历史 artifacts（含失败、截图、备份、机器路径和同步回执）不提交，不删除或改写。文档中历史 artifacts 链接仅在持有原证据的本机可读；当前公开证据入口为 artifacts/public/v0.4.0。公开仓库不是历史证据已全部交付的声明。

0.4.0 已固定的 tgz 以 GitHub Release 附件分发，SHA-256见 artifacts/public/v0.4.0/SHA256SUMS。首次Git化仅增加发布/同步材料，原安装包不重打、不换hash。Git工作区含新增发布文档，因此不承诺重新npm pack产生完全相同的旧发行字节。

## 工作规则

- GitHub main 是共享源码同步基线。功能开发用 codex/ 前缀分支，完成相称验证后合并；不要让两台机器直接覆盖同一未提交工作。
- 同步前核对实际仓库根、当前分支、工作区和进行中的Git操作。已有改动/分叉先报告，不能reset、clean、强推或覆盖。
- 接收端仅快进；相同分支且工作区干净才更新。依赖安装、Provider调用、服务操作和产品采用不由源码同步自动授权。
- sync.targets 是各设备本地Git配置，不提交机器地址。MacBook配置指向Mini已核对的共享SDK目录；未来反向同步须先核对连接和目标。
- 首次接入已有非Git材料目录时，先完整备份并验证逐文件hash，再在原路径接入Git；保留本地历史材料，不创建平行开发副本。
- 交付读回包括MacBook/GitHub/Mini的branch、commit和发行包完整hash。同步成功不等于JuanerAI生产采用或任务自动恢复。
