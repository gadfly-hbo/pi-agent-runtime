# 原型验证记录 v0.1

日期：2026-10-07；设备：MacBook；本地独立基础包。整体方案/UI 尚待用户确认。

## 实际执行

- Node 语法检查：app.js。
- CUA in-app browser 真实操作本地页面；13 组观察存于 artifacts/configuration-ui-v0.1/output/playwright/checks.json。
- 空态拒绝生效；草稿保存不生效；刷新清空；无备用拒绝并保留 v1；编辑不改生效快照；生效引用禁止禁用；同 Provider 重复模型 ID 拒绝；备用上移用 Enter 操作且候选去重；工具用途显示能力拒绝原因；Responses disabled；非回环 HTTP 拒绝；自定义 Provider/模型新增与模拟凭据状态；ESC 关闭弹窗。
- 默认桌面、320px、768px 与深色视觉检查。320/768 的 scrollWidth == clientWidth。只对当前合成场景成立，不代表所有长度/语言通过。
- 浏览器捕获的 warn/error 日志为空。原型 CSP connect-src none，JS 无网络/持久化 API、无 Pi 导入，没有真实 Key 输入；这些是静态限制检查，不是正式应用安全审计。
- 原 SDK npm run verify：typecheck、33 tests（33 pass，0 fail）、build 完成。日志 artifacts/configuration-ui-v0.1/sdk-regression.log。未安装依赖、未迁移消费者。

## 证据与复核

截图：desktop-review.jpg（交付评审草稿）、desktop-draft.jpg、narrow-320.jpg、dark-768.jpg；另有 desktop-dom.txt。均在上述 output/playwright 目录。浏览器临时捕获后复制到该持久根并独立读回；临时原件仍保留，不依赖临时目录完成交付。

node tools/verify-ui-prototype.mjs 验证已捕获观察的断言、原型静态边界和旧 bootstrap 全部 manifest 条目未改变。它不是自动重跑浏览器测试，不替代 fresh UI 验证。本轮独立 evidence-manifest.json 绑定新增源文件与证据字节身份。

## 未完成 / 未验证

- 正式 React 共享组件、headless 配置合同、多模型 fallback、宿主凭据/存储适配都未实现。原型保存/生效/检查仅模拟。
- 未执行真实 Provider、真实凭据、费用、协议端点兼容性验证；截图中的模型能力不能作证。
- 未跑完整 WCAG/屏幕阅读器审计、真实 200% 浏览器缩放、任意长文本/跨浏览器矩阵。
- 离开未保存提示、异步载入/保存失败、版本冲突、真实检查取消等正式宿主状态尚未实现，批准后进入正式 UI 验证。
- 原型同 Provider 模型 ID、token 上限校验是交互演示，数值 guard（目前 1～100000000）不是冻结的公共字段合同；正式上下文约束由配置核心闭合。
- 当前独立仓库仍未提交、没有远程仓库；本地文件不等于 Git 发布或产品接入。

**结论：本轮方案与原型可供整体评审，不代表正式 UI 包或产品完成。**
