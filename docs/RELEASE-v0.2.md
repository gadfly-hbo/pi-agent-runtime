# v0.2 可配置模型与共享 UI

v0.2.0 独立 Standards/Spec 评审于 2026-10-07 为 NEEDS_FIX；保留原候选归档及历史证据。当前 v0.2.1 修复空备用引用、低层 endpoint query 拒绝、跨协议工具历史来源。不能用旧 PASS 代替修复候选复审和真实联调。

2026-10-07，本地开发候选。基于用户已通过的简化 UI 和执行授权；未迁移现有产品、调用真实 Provider、发布 Git/npm 或上线。v0.1 的历史验证和原型记录保留原状；本轮证据在 `artifacts/runtime-ui-v0.2/`。旧源文件 manifest 不再代表当前源代码，开发前源材料已另存 `before-development.tar.gz`。

## 产品如何直接引入

```tsx
import {ModelSettingsPanel} from 'pi-agent-runtime/ui';
import 'pi-agent-runtime/ui.css';

<ModelSettingsPanel
  initialValue={hostConfiguration}
  onSave={hostCommitConfigurationAndCredentials}
  onTestModel={hostAuthorizedModelTest}
/>;
```

React 19.3.0 实测；SDK 的 React peer 可选，仅 UI 消费者需要安装。宿主自行提供 React 渲染器。组件 CSS 均限制在 `.pi-model-settings` 内，不覆盖宿主全局样式。

UI 使用 Provider 卡片、Base URL/API 格式/API Key、模型行、添加/编辑模型弹窗、一个主模型与至少一个有序备用、一个保存按钮。没有 Worker/Agent 配置模式、版本或待生效提示。示例不构成默认 Provider；用户自行选择。Responses 与智能推断模型参数暂未支持；不猜模型窗口或工具兼容性。

`initialValue` 是装载时快照。外部配置发生变化时，宿主以新的 React `key` 重新装载，不覆盖用户编辑中的草稿。保存期间锁定编辑；失败保留草稿并显示安全错误，不展示宿主异常原文。

## 密钥、保存和测试边界

`ModelSettings`/Provider/Model 是内存输入类型，不是已批准的数据库、凭据仓库或迁移格式。UI 不提供持久化、自动发现认证或网络模型请求。

- `onSave(settings, credentialUpdates)`：正常配置无密钥；更新密钥仅在第二个参数传递 `{providerId,value}`。UI 从不读取已存 Key，只允许输入替换，成功后清空临时输入。显示开关仅作用于新输入。没有删除已存 Key 的隐含操作。
- 宿主必须重新校验配置、确认用户保存权限、安全存储密钥，并确保回调成功意味着配置和凭据共同提交。提交失败/未知时由宿主回滚或核查；UI 本身不承诺跨存储事务。不要把密钥放普通 JSON、localStorage、URL、日志或回放。
- `onTestModel(provider,model)` 是可选、显式确认后的宿主测试入口，不携带 Key；宿主按 Provider ID 解析凭据，重新验证 endpoint/能力/外发权限/费用。当前预览仅合成测试，不代表真实模型可用。更改 Key 后必须先保存，才可测试。
- HTTPS 必须，本机 loopback 允许 HTTP；URL 的 userinfo/query/hash 拒绝。授权仍须检查实际模型和 endpoint，不能因用户输入 URL 或启用开关就允许企业数据外发。真实宿主网络层应执行 SSRF/私网边界，预览服务器不是正式凭据网关。
- `credentialSet` 是展示/输入预检查，不是可信凭据或授权证明；宿主不能据此绕过凭据解析。

具体产品的磁盘/数据库 schema、凭据仓库、凭据清理和迁移、团队权限与恢复仍由产品明确设计。先前 UI proposal 中的持久化结构议题没有因本轮实现被整体批准。

## 保存配置怎样被执行消费

```ts
import {compileSettings} from 'pi-agent-runtime/settings';
import {createRuntime,createPiTransport} from 'pi-agent-runtime';

// composition root：预先从宿主安全仓库解析所需凭据；不把此代码放浏览器。
const route=compileSettings(savedSettings,(model,providerId)=>
  createPiTransport({model,apiKey:hostResolvedKeys.get(providerId)!}));
const runtime=createRuntime({...route,budgets:hostBudgetStore,
  authorize:hostTaskAuthorization,audit:hostAuditSink});
```

编译前拒绝缺少主备、重复引用、禁用/未知项、未设置凭据、非法参数、未知字段和未支持协议。实际 Provider 适配只支持 Anthropic Messages 与 OpenAI Chat Completions，供应商「兼容」程度需单独实测。

SDK 捕获配置快照；保存不会热换正在执行中的任务。新任务由宿主重新装配 Runtime；同一 taskId 的配置/限制变化拒绝为 `CONFIGURATION_CHANGED`，不得通过换 ID 绕过额度。已有任务切换配置的业务决策由产品持有。

## 主备切换合同与兼容

`RuntimeOptions.fallbacks` 为有序 `{model,transport}[]`，可不设置，旧单模型消费者不强制提供 UI。配置 UI 层必须一个主模型、至少一个备用；两者不是强制所有低层运行都多模型。

所有路由候选显式 `maxOutputTokens`，且不超过该模型 `contextWindow`。每次尝试取 per-model cap 与剩余任务额度的较小值。供应商未知消耗仍保留该次预留；所以一个主模型失败后，剩余额度不足时不会切备用。任务额度不是供应商账户余额，也不是货币账单。

可切换类别：402 quota、429 rate-limit、500/502/503/504 unavailable、fetch 网络错误；自有 transport 必须主动抛出安全 `ProviderFailure`。不扫描供应商错误文本，不把 400/401/403、上下文错误、结构化结果错误、任意异常认作可切换故障。若供应商把额度不足编码在其他状态，需要明确适配和验证后支持，不能承诺任意「出错」都自动切换。

每次尝试重新授权实际 Provider/模型/消息，次数/token/resourceUnits/时间仍用同一任务账本。授权拒绝、任务额度不足、取消/超时、审计失败、工具失败/未知副作用立即停止；不能通过备用绕过。切换在同一个模型阶段内；已经完成的工具结果继续交给备用，不重执行工具。切到备用后该 run 后续模型阶段继续使用该备用，直到失败后向下一个备用前进。所有候选用尽才结束失败。

`BudgetLease.reserveModelUpTo(maximum)` 为新增可选宿主接点。旧单模型且无 per-model cap 的存储仍兼容；有 cap/主备运行必须实现此原子预留接口，否则拒绝，不模拟非原子扩展。内存账本已实现；正式持久化账本需宿主落实原子性和同 taskId 的跨实例累计。

审计沿用 version 1.0：主备路由事件新增可选 attempt/failureCategory，provider/model 始终记录实际候选，runId/taskId 不变。严格旧事件消费者需要接受这两个可选字段；不复制 Pi 事件和供应商原始错误。

v0.2.1 中立 `ModelMessage.origin` 增加可选 `{provider,id,protocol}`，记录 assistant 历史的实际来源；SDK 自己产生的历史始终携带，Pi Adapter 据此复用 Pi 原生跨模型转换（包括匹配 tool_call/tool_result ID）。不重新实现 Pi 的映射。旧手工注入且无 origin 的历史保持目标模型缺省解释；跨模型手工历史必须由宿主补真实 origin，不能把缺省当成已验证跨模型历史。录制回放会捕获该可选元数据，旧精确回放夹具需重新核对；未强制迁移现有产品。

不提供自动上下文截断、compaction、跨进程会话恢复、工具沙箱、实时余额查询或通用 Provider 故障魔法。备用模型能否承担同一内容/工具任务，需宿主真实 Gate 和任务授权。

## 本轮证据

| 增量验收 | 主要证据 |
|---|---|
| F01/F02 | 配额/真实 Pi 离线 HTTP 429 触发备用，逐次授权和累计计费 |
| F03/F06 | 已完成工具结果跨切换保留，工具不重复；多个备用按顺序消费 |
| F04/F05/F07/F08 | 额度/授权/取消/错误输出/未知工具副作用停止；400/401/403 不绕过；耗尽路由审计完整 |
| S01/S02/S03 | 配置编译被 Runtime 消费；非法协议/引用/参数/密钥字段先拒绝 |
| U01/U02 | 可导入 UI 简化字段、主备和样式；已存凭据不渲染、无测试宿主时禁用 |
| 浏览器 + 包消费者 | 保存配置和编辑备用改变实际执行；两模式成功；工具一次；320px 无溢出；核心无需 React |

- 因果 RED：F01 缺少备用执行、F02 真实 Pi HTTP 429 未分类、S01 不支持协议未拒绝、U01 缺少可用 UI；日志保留。F01 初期缺少异常类也是失败原因，不能将该次 RED 全部解释为循环行为缺失。
- 本机合成 UI 保存后驱动共享包 Worker/工具 Agent；编辑备用模型 ID 后 modelsUsed 实际改变，工具调用数仍 1。错误参数和缺少备用拒绝保存。320px 宽度无页面横向溢出。
- 独立 tarball 消费者验证 root/settings/ui/css 导出、旧单模型 Worker/Agent/回放和新主备两模式。它不是独立 Validator 或产品验收。
- 类型检查、核心/配置测试、SSR、包消费和复现结果见本轮完整日志及最终 manifest。所有 Provider HTTP 测试均使用注入的离线 Response；没有真实请求。

真实接入仍须各产品 host 存储/凭据/授权、安全边界、模型工具可靠性和产品回归验证。本轮结果是共享包本地工程交付，不是现有产品或生产发布完成。
