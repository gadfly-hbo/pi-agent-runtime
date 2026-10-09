# 模型配置交互原型 v0.1

这是整体确认用的内存态原型，不是正式共享 UI 包。没有 Pi/Runtime 依赖，没有真实 Key 输入、Provider 请求或持久化。合成示例不是默认配置；刷新清空所有状态。

本地预览（只绑定回环地址）：

    python3 -m http.server 48173 --bind 127.0.0.1 --directory prototypes/model-settings-v0.1

浏览器打开 http://127.0.0.1:48173 。默认空态，点击“载入合成演示”可体验 Provider/模型编辑、主备排序、模拟生效和检查。

界面先使用独立静态 HTML/CSS/JS，避免在 UI 确认前引入正式组件依赖。tokens.css 复用本地 saas-product-ui-system 的 default-product-tokens.css；style.css 按用户浅色截图参考定制。所有资源本地提供，不载入 CDN 或字体服务。

待确认方案：../../docs/configuration-ui/PROPOSAL-v0.1.md。
行为合同：../../docs/configuration-ui/UI-CONTRACT-v0.1.md。
实际验证记录：../../docs/configuration-ui/VERIFICATION-v0.1.md。
