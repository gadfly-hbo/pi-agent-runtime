# Harness 首批闭环：固定 .3 工程接收

本记录对应用户于2026-10-18批准的 SDK 正式工程接收与 Git 交付范围。固定对象为
`0.5.3-harness.3`；**固定包未正式 Release/npm 发布**，不创建发行Tag或新的正式版本。
提交/合并结果从所属PR和Git历史读回；此文件不预先宣称合并已完成。

## 固定包、源码与 Git 的映射

- tgz：167472 bytes，SHA256 `e6cf0c99cfbcb43ae0b197e9d45d82bae20c0c3257ba0e7bad131f6b1778e12a`。
- 完整本机SDK交付归档：4412977 bytes，SHA256 `5324c9088efc598da297bbcc6546ec4d4e047f943a7b99f601ed17888436e07b`。
- 原HEAD/最新远端main基线：`75bade32b812879bd68131a3527b79e06ea5d87a`；本轮fetch后无整合差异。
- 原冻结133项源码/WIP aggregate：`eb7e41589bf791be453f5b0f9cba8a65d425a37ba1f29f1ffdba7ff93cf87792`，HEAD不是全部WIP身份。

[固定身份与133项清单](FIXED-IDENTITY.json)、[实际55项包内容](PACKAGE-CONTENTS.json)
只公开经筛选的路径/bytes/hash和边界，不上传完整历史归档、原始会话、机器路径或包文件。
运行源码、类型、导出、版本、锁文件、测试及原固定合同均与冻结身份一致。
相对冻结源码，Git接收只更新根README的工程状态指针，并新增本目录的工程证据元数据；
两者不改变原tgz。当前构建dist逐文件与固定tgz一致。
Git提交还包含从该基线起原17项任务WIP：源码/公共类型、两份任务合同、四份测试、
两个固定包验证入口及隔离安装helper、package/lock版本和README；不混入其他任务。

版本字段是已有候选版本，不表示正式发布。新增文档会改变未来打包内容；**不承诺重新
npm pack得到原字节**。原包、完整交付归档及其历史不覆盖，所有消费证明仍绑定上述tgz。
[首批合同](../../../docs/HARNESS-FIRST-LOOP.md)和[NATIVE准备合同](../../../docs/NATIVE-PARAMETER-PREPARATION.md)
保留冻结时的授权/停点描述；本记录只补本次新的Git交付授权，不回写历史或改变运行保证。

## 正式工程接收的验证范围

本次新执行：`npm run verify`（typecheck/build、329核心PASS/3既有SKIP、UI2PASS）、
离线example、直接指定同一固定tgz的Core/UI消费者及Harness消费者（52PASS/1OS SKIP）。
均为隔离、锁定离线安装，Core不强制React、公共类型中立、旧入口/持久Session通过；没有重新打包。
同一tgz的既有R1/R2/R4消费者40PASS复用：源码/测试/fixture/包未变化，当前构建和新安装再次核对身份。
[验证结果和原始日志hash](VALIDATION.json)分列本次执行、复用与SKIP；集中独立审查见[审查记录](REVIEW.md)。
本地证据命令/全文保存在原任务资料目录，不因公开摘要而删除。
没有跟踪的GitHub Actions配置；接收时main未保护、有效branch rules为空。合并前仍读回最终head与检查；
无托管检查时仅报告本地验证，不称CI PASS，也不新增CI平台。

## Mini 联合回执

用户转交candidate-final-007 r2：50项冻结WIP，aggregate
`7b5a0afd58cf1903e0bfe1e92cf605d9a78b37250286f2b9dc41742bed3c8e2e`，
产品HEAD `081031af8c17242f93c94f8f5b4d035328bc9a36`。SDK接收结论
`RECEIVED_VERIFIED_WITH_LIMITS`；联合结论保持`JOINT_OFFLINE_PASS_WITH_LIMITS`。
V006-01仅在007闭合，无新的共享SDK缺陷被确认。固定包55项与所附安装读回匹配；
这是转交材料静态核验，不是SDK重新登录产品设备或运行产品。

作者portable23PASS/2SKIP，本机非Darwin分支23PASS/2SKIP，macOS25父例内16子例/40叶例；
独立CLI另有macOS25父例、portable23+2、受影响CI子集78、边界6和类型检查。
作者423、14+3以及更早996+13/SSR build按原范围复用，不冒称SDK本轮或独立CLI新跑全部。
r2仅更正文档不可靠截断计数，候选/测试/独立结论未变。

## 历史、权限及停止线

0.5.1、旧0.5.2、.1/.2/.3、Mini003～007、全部FAIL/BLOCKED/UNKNOWN、SDK与007因果RED保留。
`.2`仍为“两项重跑通过＋22项有效证据复用”，不变成一次完整24项通过。006 FAIL和原生BLOCKED
不被007 PASS回写。早期TS2339与同包消费者漏fixture导致39PASS/1FAIL等历史亦保留。

实际Ubuntu/托管CI、产品全量canonical、真实Provider/strict/模型质量、真实业务质量、视觉/用户产品验收、
Desktop交付仍未验证或未代签。此前CLI取消外层OS沙箱例外不延续，本轮不改变当前模型/权限。
本次SDK工程接收/Git交付不代签Mini当前运行采用、产品正式工程接收、Provider、生产或包发布。
不自动安装升级消费者，不恢复/重放UNKNOWN、不清账，不操作产品服务或联系其他session。
试用修复-2、Change-007继续暂停。同步仅对已配置SDK仓库、干净同分支且可快进的目标执行；
活动/脏树、main占用、分叉或SSH不可达时跳过，不切换/detach/stash/reset/clean/强推。
Git交付完成后停止，保持待用户反馈。
