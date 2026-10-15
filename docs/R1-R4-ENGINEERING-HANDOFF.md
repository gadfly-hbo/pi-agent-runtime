> 0.5.1 发布副本说明（2026-10-15）：下文保留工程各阶段与 API 增量；早期“待材料/未实现/未授权发布”仅代表当时时点。当前实现以末尾增量002/003及 RELEASE-v0.5.1.md 为准。正式发布授权只覆盖 SDK；Mini 仍采用原 .3 固定包并接受限定离线范围。此次仅把本机路径/SSH别名替换为中立占位，原候选包和完整本机工程原件不改写。

# R1–R4 共享 SDK 工程合同与消费者返回点

2026-10-14。状态：Mini002已核验；S1最终请求guard公共切片和独立S2/S3机制已局部验证，文末中间API合同供Mini准备接线，R2/R3完整新增载体仍在修复。本文不是完整R1–R4固定候选或产品验收收据。

## 授权与身份

用户批准路线 B 严格边界组合，先收口 R1–R4。共享 SDK 负责 S1–S4；JuanerAI Application/Adapter/业务工具、IR/核验/Outcome/UI 与端到端验收由 Mini Engineering Controller 负责。通过用户转交材料协调，不跨聊天发消息、不远程修改消费者。

启动远端只读 `git ls-remote origin refs/heads/main` 与本地 `origin/main` 均为 `b07057faaecd919109fff6adaca8f9365be95ccc`。主仓库及原聊天工作树干净，未改动。

- 独立工作树：`<SDK_TASK_WORKTREE>`
- 工作分支：`codex/r1-r4-sdk-boundaries-20261014`
- 基线：上述 origin/main commit；SDK 0.4.3
- 唯一写入者：本聊天工程 Agent（MacBook）；独立审查者仅只读
- 独立 `npm ci --ignore-scripts --cache .npm-cache`；node_modules 是独立安装目录，无其他工作树链接
- Node 24.21.0、npm 11.19.0；Pi core/ai 均 0.86.1，lockfile 未变
- 专属证据与 Session/tmp：`artifacts/r1-r4-20261014-001/`；现有回归服务只用 OS 分配的 loopback 端口
- 不提交/推送/合并/正式发布；不调用真实 Provider、不读取真实凭据或业务资料、不恢复原失败任务

审计输入：用户指定 `JUANERAI-PI-FULL-STACK-AUDIT-2026-10-14.md`。审计旧包 SHA256 `475480217d5f644a15264b2f838e5567d3e2c2e431b8a23c061a0665dbdbfa70` 仅为输入身份；不重打或改写旧包。

## 新接口与共同验收待Mini产出的材料

Mini最小合同/合成消费者材料尚待其已启动任务产出，通过用户转交。交付渠道已由共同起步说明确定，不再把渠道或尚未生成的新包当作启动前置。以下只有真实依赖的部分等待，不从产品活跃目录或旧聊天补猜：

1. 合成消费者合同/夹具可读路径与内容身份，当前真实生产 Adapter 的受信最终工具声明/description 投影位置，以及 R1–R4 的共同验收点。
2. 窄可读资料视图与解析授权：宿主如何把完整本地结果转为原生 read 可分页的文本视图，句柄版本/可读资源定位；超长单行资料如何通过宿主派生资料视图访问。SDK 不擅自裁切 JSON、不开放 bash。
3. 安全错误/输出语义消费规则，实际候选能力/窗口配置和接收方授权，合成恢复/once-extra 验收夹具。
4. 固定包交付使用已批准的独立文件传输渠道，独立Mini接收目录见下方更正；固定后双端核验。没有包时不创建假版本目录，不向其他聊天发消息。

以上材料是工程对齐输入，不要求用户逐项批准普通实现。待产出材料只阻止相关新接口/兼容决定与共同消费者验证；现有合同内原生机制修正继续。

## 最小共享接缝方向（待消费者对齐；名称与签名未定）

| 范围 | 必需行为与边界 | 验收对应 |
|---|---|---|
| S1 完整实际请求准入 | 同一中立检查可用于 SDK 候选请求与宿主最终受信投影之后；包含 system、当前工具 schema/description、全部实际 history/tail、图像/协议开销与输出预留；每个候选及压缩/摘要后重查。Pi 估算、配置窗口、Provider 实测分别标注；不宣称 chars/4 是精确上界，无法安全判定则拒绝或宿主有界结果路径。 | F01/F03，R1，V03/06/07 |
| S2 stop/error/usage 保真 | 保留 length 与实际 Provider 分类/已知用量，未知预留不退款；Worker 继续拒绝截断结构化输出，Agent 适用恢复交原生 Harness；错误只安全中立分类，不记录原响应或敏感原因文本。 | F02，R2，V08/10–13 |
| S2 恢复共用额度 | 原生 overflow/length 恢复、SDK fallback/retry 共享逻辑请求 once-extra；原生压缩/分支摘要均独立授权、同 Task 计量/审计。native retry 与 modelRecovery 冲突继续拒绝；无法核清物理状态/UNKNOWN 不重发。 | R2/R4，V08/09/13 |
| S3 原生 read | 沿用 core 工厂，保留 schema/offset/limit、继续提示、content/details；保留 not_found/permission/cancelled 等安全分类；名单仅 read 不授予提示中 bash 权限。 | F10，R1/R3，V05/17 |
| S3 小结果/可读引用 | 仅提供必需预算/中立投影接缝；完整结果、引用持久化与解析权限由宿主提供。effect 已发生后输出超限不能抹掉效果与计量。不得新增通用存储/分页引擎或业务资源含义。 | F04，R3，V04/05/10/15 |
| S4 已有主备消费 | 首先验证现有 purposes/fallbacks 在持久 Harness、压缩/摘要及工具后续请求上的真实消费；合同足够即给准确用法。逐候选重新检查 window/protocol/thinking/image/外发授权，实际身份回宿主，不重放已完成工具。 | F05，R4，V06/08/09 |

不启动 R5 全套 grep/find/ls、R6 全面兼容退役、第二 Session 引擎或全面 Pi 升级。当前依赖已能支持原生 read 与核心恢复；未证明需要新增 coding-agent 依赖。路线方向批准不等于这些已实现。

## 当前因果证据（基线未修复）

完整基线：`baseline-verify.log`，typecheck/build PASS、核心 204/204、UI 2/2、零跳过。基线 PASS 只证明既有回归，不关闭新 finding。

`baseline-probes.mjs` 经构建 JS 公共 SDK 入口执行，HTTP 使用内存 Response，编解码与持久 Harness/JSONL/压缩为真实 Pi：

- F01/R1/V06 RED：200k 配置下 100k system +750k prompt 仍产生 1 个物理 HTTP 边界调用。仅说明配置准入缺失，不推断真实 Provider 硬窗口。
- F03/R1/V07 RED：900k 当前工具结果执行一次，原生自动压缩实际发生一次；3 个物理请求含摘要，压缩后仍发送巨型 tool tail 一次。未手造 summary 或循环替代 Pi。
- F10/S3/V17 RED：专属获准根中不存在的文件被 factory 映射为 `permission_denied`，预期 `not_found`。
- S3/V05 PASS：真实 native read 的 offset/limit 声明、第二页与继续 offset、Unicode 超长首行 details 均保留；工具名单仅 read，无 bash。

新增 `error-probes.mjs` / `error-probes-RED.log` 两项 R2/V08 因果 RED：持久 Agent 的 length 回复在只调用两次后提前 INVALID_OUTPUT，PARTIAL 未保留且没有原生恢复摘要；结构化 HTTP400 context_length_exceeded 被抹成 MODEL_FAILED 且无安全分类。length 场景权威账本仍保留已知 input18/output4；缺陷发生在原生 Assistant 桥接，不能误称所有用量都被清零。

探针总计 6 项、1 PASS/5 因果 RED；失败原件保留。context category 在探针中是中立语义预期，最终公开字段/类型仍待 Mini 对齐；length GREEN 还需验证完整原生恢复及统一一次额外请求，当前不能称恢复验收完成。

## 既有接缝追加验证与独立审查

- S4/R4/V09：`routing-probe-attempt2.log` PASS。真实PiHTTP与持久Harness的工具后续调用、手动压缩都按既有purpose.fallbacks切到backup，history/audit保留实际模型身份；随后report通过runText共享Task账本。6物理请求、工具仅1次、摘要1次；output36含已知4加未知预留32，非Provider实测36。未证明report同持久Session续接、不同窗口安全准入或全S4矩阵。
- S3/R1/V05：`native-read-consumer.log` PASS。真实HTTP模型消费原生read的两页与继续提示，3物理/2工具；实际JSONL保留truncation.details，工具名单无bash。验证页首/尾/边界哨兵，非全页逐字核对；未取得Mini获准资料视图或新tgz。
- 当前追加探针总计3 PASS/5因果RED。S4首次摘要字符串预期修正的失败原件保留，独立审查确认该原生split-turn包装正确；这次夹具错误不计SDK RED。
- 独立只读审查见`artifacts/r1-r4-20261014-001/STARTUP-INDEPENDENT-REVIEW.md`：未发现启动越权或伪造RED，明确不是修复候选评审。
- F01断言中的chars/4仅是完整payload的启发式说明；当前Pi estimateTokens对system返回0，不能宣称原生估算已覆盖system。输入估算、实际用量与配置窗口仍需分开。
- 旧缓存合同对零/缺失输出保守预留；新S2必须把已知output=0与未知/预留分别表达并记录合同增量，不静默重写历史。

## 后续验证与交付闭合

独立机制已按现有合同逐片RED→最小实现→GREEN；新接口在消费者材料到齐后记录接口/错误/兼容增量再实施，受影响回归与独立只读审查各自留证。验证 Worker/Text/Agent、用途集合、旧配置/历史读回、持久 Harness、完整请求、不同候选、恢复/辅助计量、取消/撤权/迟到/UNKNOWN、账本/审计/保存故障和 read 权限。SDK 验证只覆盖共享接缝，不声称完成 V01/V02/V11/V12/V16 的产品业务/UI 全链。

版本按最终真实兼容影响选择；目前未定版本、未生成修复候选。公共/持久合同若必须破坏或迁移先给出具体用户决定；历史包和会话/账本不改写。已有用于采用/验收的固定包不原位覆盖。

交付必须包括实际 tgz、SHA256、源码/依赖/包内容清单、合同增量、原生复用说明、删除/替换清单、RED/GREEN/回归/独立评审、独立安装消费者与受控采用/回滚说明。消费者依赖另行独立安装，不使用此可变工作树的 node_modules 或源码。

共同返回点：Mini 取得并按字节核验固定新包及完整材料后，在自己的隔离工作树完成 Application→Adapter→实际安装包→IR/核验→Outcome/UI 离线/合成联合验证，返回包身份、共同 R/V 编号结果与共享缺陷。若共享层需修正，SDK 另交新固定版本/身份，Mini 重验受影响链路。UNKNOWN 不清账、不退款未知、不让旧包自动 resume 新状态。

## 2026-10-14 起步顺序更正与独立实施范围

已完整补读共同起步说明与修订SDK Prompt。Mini材料尚待其已启动任务产出，仅新接口/消费者相关决定等待材料；不阻塞现有合同内原生修正。本工作树/分支沿用，不重建任务。

交付渠道已明确：MacBook通过已批准的独立文件传输渠道，Mini接收根 `<MINI_RECEIVING_ROOT>/<exact-version>/<sha256>/`。固定包来源可采用本工作树专属持久输出根，交付时回交精确路径。新包是后续成果。文件渠道无需再次澄清；只复制实际固定新文件，冲突不覆盖，不安装/升级消费者，不操作其SDK仓库或服务。

先实施的现有接缝：

- S3：ExecutionEnvironment→native工具的安全错误分类；not_found/permission/aborted/unavailable保留，进程timeout复用原生分类；不复制宿主异常正文/cause、不改变工具名单或授权。
- S2：length非零已知用量与内容交给原生Harness；Worker继续拒截断，Agent的适用compact-and-recover交Pi处理。原生assistant trigger身份作为内部逻辑请求关联，SDK fallback/retry与native recovery复用一个额外计数；辅助请求仍经同Task准入/预留/审计。计数不成为公共消费者或新持久schema；不能核清跨运行恢复额度时停止，不自动重放。
- 不新增Mini业务接口、结果handle格式、持久字段或公共Provider错误/usage新类型。已知零输出/未知预留、最终受信投影及小结果接口等具体增量待Mini材料对齐。

S3 RED/GREEN与S2 RED分别另存本任务证据；之前启动/RED/UNKNOWN收据保持原样。版本与固定候选尚未定稿，不能将这些focused GREEN称为消费者或产品验证完成。

## 独立修正实况（完整候选未生成）

- S3：已修复安全错误映射，unknown不再冒称permission，已知cancel/timeout/unavailable映射原生分类；不保留原宿主异常正文/cause。工厂名单/授权不变。
- S2：已保留原生length及非零已知用量/内容；Worker仍硬拒。利用native generation trigger关联内部额度，fallback/retry与新native恢复相互阻止叠加；摘要/后续请求继续逐物理授权/计量/审计。
- 独立审查001发现省略modelRecovery的叠加及跨进程摘要先付费后拒绝三项问题，原报告保留。已取得真实RED，修正后恢复无论显式/省略配置都不能叠加native retry或fallback；native retry先消费则拒额外length恢复。旧独立多候选路由与既有native retry配置保留原合同，新加入的恢复不扩大其额度。
- 跨进程恢复在原生overflow摘要出站前核对原trigger与当前run的计数；无法核清则STATE_FAILED，零新增物理请求。不新增持久schema、不重写旧JSONL/账本；测试只核账本任务模拟死进程、保留全部已知消费，不提供生产迁移程序。
- 旧checkpoint的新原生read调用改为复用同一content桥接，模型真实收到页文本与续读提示；已存旧history/acknowledged结果原样消费，不改旧格式。
- 已知output=0与未知预留、HTTP400 context的公共诊断/用量增量、完整最终投影准入及小结果/可读引用仍等待真实Mini材料。类型/参数不提前定稿，不宣称关闭全部S2或R1–R4。
- 没有生成tgz，开发package.json仍为基线0.4.3，不作为新候选交付；未来新包必须新精确版本/固定身份。

## Mini消费者交接002已接收（增量，不改写历史状态）

用户转交002后，已通过既定SSH/SCP渠道取回实际归档；399836 bytes，SHA256 `468de7c4034819fb0c74ad1ee94fc29cc2e131c593b39056ad4bab8d922dfd87`。manifest SHA256 `32762c21fe99e0fe902f2c2b1a6df8beabdd7a307dde26a7166bfe6092effdd4`；69个manifest文件、70项SHA256SUMS及5份源码快照全部核验。接收收据见 `artifacts/r1-r4-20261014-001/MINI-002-RECEIPT-001.json`。来源HEAD 8265a3920ee1205faec7dede8b0c84e648105d9d为包内来源声明及快照核验，不冒称实时Mini Git读回。此前待材料文字是历史阶段记录；本节取代当前等待状态。

已完整读取合同、spec、SDK/JuanerAI消费者脚本，核对执行日志、失败/用量及最终投影请求。独立只读审查完整读取两份Pi消费者Adapter快照：native-open-analysis.ts 67–74完成业务工具声明替换，75检查接收方，76–77 reserve/issue，80–83进入凭据访问/HTTP。最终guard应在产品投影后、物理reserve之前强制执行，SDK早期检查与observer不能替代该接点；不要求SDK阻止宿主任意绕开公开API。

R2产品失败当前仍全写UNKNOWN，正常run只读status/reason/value且静态返回model；SDK须提供真实中立stop/category/known usage/physical state/model载体后由Mini消费。R3业务工具在返回JSON归一前已执行，SDK小结果接缝必须保留已发生效果/回执及计量。R4四用途当前无fallbacks，不能把report的backup变量当作analysis已接通主备。引用资源含义、授权、全量计算和业务证据由产品持有。

C02修正后仍仅排除permission_denied；新消费者应按正式合同明确断言not_found。C06是未消费guard的旧接口缺口探针，须在API确定后改为实际guard消费。J01保留两份2985行合成输入及最终投影，停于inspection；50KiB是read页目标，不冻结catalog预算，也不是token数。C01/C04/C05/C07局部PASS不关闭V01–V17。合成memory/reconcile host不证明生产持久安全。

不需再转交先前索取材料的Prompt。材料齐备允许继续必要中立接口实现与因果验证；尚无新精确版本tgz、新包安装消费者或产品联合验收。既有工作树/分支、旧包/失败/UNKNOWN全部保留，未向其他聊天发送消息或升级消费者。

## 最终准入实施切片（因果验证中，非已交付公共接口）

经Mini002核对，采用中立最终请求准入机制：既在新任务声明的固定策略下逐候选检查，又允许宿主在67–74最终投影之后、76物理reserve之前显式执行同一检查。工具存储上限/read分页上限不作为模型窗口上限。策略身份与开销/安全余量固定进新Task配置，未声明的新策略不重写旧Task配置。Pi内容估算覆盖system/真实工具的补充估算，另用完整Unicode/转义JSON字节包络形成保守预算；其不是Provider实测或精确token保证。图像必须有宿主验证的每图预算，否则拒绝；thinking/图像/协议能力按实际候选复核。拒绝不成为ProviderFailure，不触发无条件fallback。此段先记录行为规格，名称/类型以随后实际源码及测试为准。

## Mini 最小 API 合同与接入说明：中间交付001

本节是现有R1–R4工程合同的增量；固定转交副本由本节生成，不另建共享标准。供Mini对齐设计和准备测试，**不是新包可安装、联合验证或产品验收通过的声明**。接口状态只对应下述源码身份，后续修订另交新身份，不原位改写已交付副本。

### 来源与状态

- SDK来源HEAD：`b07057faaecd919109fff6adaca8f9365be95ccc`；工作树 `<SDK_TASK_WORKTREE>`；分支 `codex/r1-r4-sdk-boundaries-20261014`，工程Agent唯一写入。HEAD是基线，修复在未提交WIP中，不能把HEAD独自作为本接口源码身份。
- 源码/测试/依赖/编译配置清单：`API-SOURCE-MANIFEST-001.json`；文件集合SHA256 `fe0b6dfc9169ff3eed7ac9cb21f0ea98c0b1777c9b1a237418d12c506b783256`，`54`个文件。本中间副本的文件SHA256另见同目录收据。依赖Pi core/ai仍精确0.86.1，lockfile未升级。
- Mini输入：实际收到mini-consumer-002.tar.gz，399836 bytes，SHA256 `468de7c4034819fb0c74ad1ee94fc29cc2e131c593b39056ad4bab8d922dfd87`；manifest SHA256 `32762c21fe99e0fe902f2c2b1a6df8beabdd7a307dde26a7166bfe6092effdd4`，69文件与70校验项核验一致。其生产快照声明HEAD `8265a3920ee1205faec7dede8b0c84e648105d9d`，5快照校验一致；未独立读回实时Mini Git。
- 开发package.json仍为0.4.3；**不得将当前构建打成同版本修复包或在产品安装**。新精确版本待完整兼容评估/固定打包，未制作新tgz。

### 实际公共入口及三种状态

| 需求 | 实际公共入口/载体 | 接口已确定 | 实现已验证/仍待确认 |
|---|---|---|---|
| R1最终请求准入 | 新增 `admitModelRequest(ModelRequest, ContextAdmissionPolicy): Readonly<ContextAdmission>`；`ContextAdmissionFailure`；`RuntimeOptions.contextAdmission?`（SessionRuntimeOptions继承） | 本源码身份下已确定并公开导出 | 10项源码公共接缝检查及真实Pi codec正反链路；未安装新包，Mini实际guard接线未验证 |
| R1原生read | 沿用 `createExecutionTools(ExecutionEnvironment, ['read']): Tool[]`；`Tool.execute(args, signal, invocation?) => Promise<JsonValue>` | 既有接口直接复用，S3只修桥接分类/content | 原生分页/续读/content/details及缺失/权限/取消/不支持局部已验证；宿主可读引用映射、限额独立分类仍未闭合 |
| R2stop/usage/错误 | 既有 `ModelReply.stop/content/usage`、`RunResult.usage/usageKnown/reason`、`RuntimeFault`、`ProviderFailure.category`、`AuditEvent.provider/model/failureCategory` | 现有类型按下文消费；不可假设额外字段 | length桥接/once-extra局部已验证；完整安全failure/known-zero/physical-state/实际candidate返回载体尚未确定 |
| R2恢复 | 沿用 `BaseRequest.modelRecovery?: {extraAttempts:0|1}` 与原生Harness compaction；`HarnessSettings.retry`保持原限制 | 现有公开参数无需第二恢复引擎 | 原生长度/overflow、fallback/retry防叠加等13项机制检查；Mini C03第一轮材料尚未以新固定包重跑 |
| R3小结果/已执行输出超限 | 既有 `Tool.execute`、`ToolExecutionContext`及原生read；新增bounded-result/receipt公共契约**未确定** | 仅列已存在入口，暂无新handle/引用API | 当前1MiB工具值上限不能充当窗口准入；执行后超限receipt保真与模型有界输出组合仍在修复，Mini不要依猜测字段接线 |
| R4每用途候选 | 直接复用 `PurposeConfig.fallbacks?: readonly {model:ModelConfig; transport:ModelTransport}[]`，新准入策略逐实际候选执行 | 不新增路由API；候选用途/能力/授权由宿主固定 | 既有持久Harness工具后续/摘要fallback局部已验证；1M→200k不安全候选拒绝已测。生产4用途候选及端到端未闭合 |

### R1新增类型、返回和失败语义

以下名称/签名来自src/types.ts、src/errors.ts、src/pi-adapter.ts及构建声明；不是设想接口。

```ts
interface ContextAdmissionPolicy {
  policyVersion: string;
  protocolOverheadTokens: number;
  safetyMarginTokens: number;
  imageTokens?: number; // 实际候选经过宿主核验的每图预算；无预算则拒图像
}
interface ContextAdmission {
  basis: 'pi-estimate-with-byte-envelope';
  policyVersion: string;
  model: Pick<ModelConfig, 'provider' | 'id' | 'protocol'>;
  contextWindow: number;
  piEstimateTokens: number;
  envelopeBytes: number;
  budgetedInputTokens: number;
  protocolOverheadTokens: number;
  imageTokens: number;
  safetyMarginTokens: number;
  reservedOutputTokens: number;
  requiredTokens: number;
}
admitModelRequest(request: ModelRequest,
  policy: ContextAdmissionPolicy): Readonly<ContextAdmission>;
// ContextAdmissionFailure extends RuntimeFault; reason === 'INVALID_REQUEST';
// readonly admission: Readonly<ContextAdmission>
```

`ModelRequest`仍是实际候选model、完整messages、maxOutputTokens、signal、thinkingLevel?及deferred?。system及**本轮真实工具声明**位于ModelMessage的system条目text/tools；history、当前tool结果、retained tail、reasoning/signature和images必须原样纳入实际messages，不能提供删过的大概摘要冒充最终投影。

- 只接受普通数据DTO请求和模型对象（Object.prototype），非普通实例拒绝INVALID_REQUEST。成功后**原位递归冻结请求**，返回冻结的安全预算报告；宿主发送这个获准对象，重新投影/换模型/换输出上限须再准入。不要把报告当新ModelRequest，也不要把admission当授权收据。
- Pi estimateTokens复用既有内容估算；原生system估算为0，因此额外按system text及实际tools声明补算。完整messages的UTF-8 JSON包络覆盖Unicode、转义、reasoning signature、真实参数/结果等；保守输入预算取Pi估算与包络字节加权值中较大者，再加每图预算、宿主协议开销、安全余量及实际输出预留。
- `envelopeBytes`是字节；`piEstimateTokens`是启发式；`budgetedInputTokens/requiredTokens`是保守准入预算；contextWindow是宿主配置，**均不是Provider实测或通用tokenizer精确上界**。协议隐藏开销、图像规格/模型映射需要宿主核验，策略应覆盖同一已批准候选链的最保守条件。不能因JSON小于768KiB或read页小于50KiB而跳过guard。
- 窗口预算不足抛ContextAdmissionFailure（仅模型/配置/计数，不含prompt/schema/凭据/响应原文），不是ProviderFailure，不会无条件fallback或付费retry。取消抛CANCELLED；非普通DTO/结构/非法输出上限/thinking能力不符为INVALID_REQUEST；图像能力或核验预算缺失为CAPABILITY_UNAVAILABLE。
- `contextAdmission`声明于新runtime配置后，SDK在每个实际候选的模型授权/SDK预留前执行同一guard；其完整策略进入Task配置hash。省略策略保留旧Task合同，**不代表完整R1准入已启用**。新R1–R4任务必须启用策略并在宿主最终投影后再次检查。
- 受信宿主必须在物理发出前调用且原样传播ContextAdmissionFailure。最终窗口拒绝结算SDK已预留输出为0token、不走恢复；SDK modelCalls仍是已入宿主transport的调用计数，不能将它等同产品物理HTTP账本数量。已物理发出的失败/UNKNOWN预留不因该新增分支退款。其他错误的完整已知零/物理状态载体仍待R2闭合。

### Mini实际接线位置与顺序

002的native-open-analysis.ts：63–65检查current/取消/授权，67–74替换业务工具description/schema，75接收方白名单，76reserve，77issue，80–83访问凭据并发送。接入顺序应是：

1. 保留current/撤权/取消检查，完成当前phase的**全部**受信工具投影。
2. 构造真正要交给HTTP的最终ModelRequest：合并取消signal，保留分支若限制2048输出也在此确定；不要在guard后再复制修改payload/model/output cap。
3. 检查该实际候选接收方及model/protocol/thinking/image授权，调用`admitModelRequest(finalRequest, pinnedPolicy)`；这一步在原76物理reserve之前。不能放在onEvent、onHarnessEvent或extensions.beforeRequest观察钩子中替代。
4. 保留异步边界后的撤权/取消复查，使用获准messages的现有digest，才reserve→issue→经授权取得凭据→真实createPiTransport/HTTP。未知/取消/撤权与后续结算沿原安全边界，不因guard通过变为soft success。
5. 每个fallback、工具后续请求、压缩/恢复及手动摘要都经过同一transport入口，最终投影后重新guard；不得缓存旧候选的PASS或给摘要免授权/免计量。

下面仅演示SDK实际公共接缝；projectFinal/send是宿主传入的函数参数，**不是新SDK API**。Mini应在自己的现有transport中插入guard，保留上述账本/授权顺序。

```ts
import {admitModelRequest, createSessionRuntime} from 'pi-agent-runtime';
import type {ContextAdmissionPolicy, ModelTransport, ModelRequest} from 'pi-agent-runtime';

function finalProjectionTransport(
  policy: ContextAdmissionPolicy,
  projectFinal: (request: ModelRequest) => ModelRequest,
  send: ModelTransport, // 宿主现有授权、物理账本、凭据及HTTP发送入口
): ModelTransport {
  return async request => {
    const finalRequest = projectFinal(request);
    admitModelRequest(finalRequest, policy);
    return send(finalRequest);
  };
}
// 在新Task的现有createSessionRuntime(options)中增加contextAdmission: policy。
// policy开销/安全余量需Mini核验；测试中的256/8192只是合成参数，不是产品批准值。
```

### 原生read、宿主资料及输出责任

```ts
import {createExecutionTools} from 'pi-agent-runtime';
import type {ExecutionEnvironment} from 'pi-agent-runtime';
function approvedReadTools(host: ExecutionEnvironment) {
  return createExecutionTools(host, ['read']);
}
// read.execute({path: approvedPath, offset: 2001, limit: 100}, signal)
```

工厂继续采用core0.86.1原生read的schema、offset/limit、2000行/50KiB裁剪和继续提示，返回JsonValue中的content/details保留；Tool.output='content'让模型真正消费页文本，持久native历史保留details，旧checkpoint新read调用也复用同一桥接。不要另写分页/截断器。

宿主拥有引用→获准文件映射、资源版本/业务含义、读前撤权核验、目录/字段边界、完整原始输入/计算/结果/证据持久化；SDK没有新增通用handle仓库。hash单独不可读。长单行/巨型JSON需宿主派生窄文本资料视图，保持完整JSON/证据本地不动；不能随意截断成损坏JSON，不能根据native提示开放bash。只传['read']，不给Shell/Edit/Write/网络，也不增加本轮grep/find/ls。

现有read错误安全分类可读取error.code（不依赖Pi错误类导入）：not_found、permission_denied、not_supported、aborted、invalid、not_directory、is_directory、unknown。超时当前file归aborted且只有中立提示；host BUDGET_EXHAUSTED目前未提供独立read限额代码，不能冒称限额已区分，此处仍待补齐。未知原因保持unknown，不推断权限或HTTP。

工具1MiB是SDK值校验/存储约束，read50KiB是原生页约束，model.contextWindow是准入窗口。当前超限工具值仍走TOOL_FAILED，**尚未提供R3完整的已执行效果/receipt保真载体**；Mini不能把该错误当未执行、不能自动重放，也不能删native历史。ToolExecutionContext已有invocationId/toolCallId/operationId与getMemo/setMemo/update，不代表新结果存储平台或超限回执已经闭合。

### R2现有消费、恢复与UNKNOWN

- ModelReply现有stop：complete/tools/length/deferred；usage现有inputTokens/outputTokens及可选cacheReadTokens/cacheWriteTokens，缓存子集不重复累计。当前length与内容/非零已知用量交给原生Harness；Worker/Text拒截断，不调用Worker validate去把截断JSON伪装有效。
- RunResult现有status/taskId/runId/usage/usageKnown/reason或value。usageKnown仅说明SDK账本可读，**不保证每个物理调用的Provider token都已知**；未结预留见uncapped的reservedOutputTokens，outputTokens含保守预留。不能由output=1推断length、400或真实旧故障原因。
- ProviderFailure现有constructor(category)仅quota/rate-limit/unavailable/network，不携known usage/status/stop/physical state；createPiTransport仍有HTTP400 context与已知output=0等公共语义缺口。不要给它添加假字段来宣称SDK已支持。安全完整诊断/用量增量将另交实际API身份。
- Mini当前失败账本统一UNKNOWN，run最终只读status/reason/value并静态返回model；需要在新载体确定后消费并持久读回。SDK现有AuditEvent和宿主transport request.model可记录所选实际候选；Provider实测与最终物理状态仍以可信收据/账本为准，不能把未发备用的配置当实际发送。
- 新任务显式`modelRecovery:{extraAttempts:1}`，`harness.retry.enabled:false`。适用length/overflow恢复、SDKfallback/retry共用一次额外尝试；不能核清跨运行原trigger额度时在摘要出站前STATE_FAILED，不因重开Session免费再尝试。保留旧多候选/原生retry配置的固定合同；它们不被自动升级成本轮新策略。
- 摘要等辅助物理调用仍逐次授权、同Task计量/审计；恢复决策的一次额外尝试不是免费摘要，也不是全Task只允许两个模型调用。已完成工具、撤权/取消/迟到/UNKNOWN效果、安全拒绝、保存/账本/审计故障不变为成功，也不重放工具。Mini需持久BudgetStore/reconcile验证，合成memory host不证明生产安全。

### R4候选与兼容

每purpose直接使用现有model/transport及fallbacks数组；每候选显式maxOutputTokens、contextWindow、protocol、reasoning/thinkingProtocol/input能力。固定同Task/purpose/config及整用途集合，不因fallback换Task清预算。新guard在实际候选计算窗口/输出预留；context-invalid不是无条件fallback原因。接收方授权由产品核验，SDK不会将backup名或report用途配置解释成analysis接收方授权。

Mini目前四用途各单model，没有fallbacks；reportModel引用backup变量不构成analysis候选链。产品只在已批准用途内接真实候选，不统一扩大到四用途。实际model不能继续由静态首选配置推定。

旧固定包、旧Task配置、旧skills/templates/CLI兼容路径、旧checkpoint历史/acknowledged结果均保留。新增contextAdmission改变新Task配置身份，同Task不能加策略或改策略强行resume；应保留旧Task原包/原配置，仅在授权的新任务采用。fork只是原生历史副本，不复制新Task授权、旧消费退款或恢复额度；本批不迁移历史/账本。回滚不清账、不退款UNKNOWN、不让旧包自动resume新策略状态。无不兼容历史迁移实施或发布授权。

### 测试证据、采用条件和暂未闭合项

命令均在SDK独立工作树、专属TMPDIR执行，不读取真实凭据/业务数据。

```sh
TMPDIR="$PWD/artifacts/r1-r4-20261014-001/tmp" \
  node --experimental-strip-types --test tests/context-admission.test.ts
TMPDIR="$PWD/artifacts/r1-r4-20261014-001/tmp" \
  PI_RUN_OS_SANDBOX_TESTS=1 PI_RUN_LOCAL_PROXY_TESTS=1 npm run verify
```

10项guard矩阵：完整system/prompt拒绝、Unicode/schema/reasoning/signature/tail、200k/1M、较小备用拒绝、图像预算/thinking能力/取消、冻结普通DTO、同Task策略固定、真实持久Pi巨型tool尾部拒绝与有界原生摘要、最终投影前物理账本零调用、真实Pi HTTP/SSE正向已知用量。日志context-admission-matrix-003.log，exit0；RED原件分别保留context-admission-RED-001/002、review-RED-001、budget-RED-001。matrix001的manual compact预期是夹具错误，保留原件，不作为SDK因果RED。

现有S2/S3对应tests/runtime-boundaries.test.ts的13项机制回归与MECHANISM-INDEPENDENT-REVIEW-001/002，保留独立审查发现和修正回执；本guard独立只读审查发现非普通实例绕过冻结，已有真实RED/GREEN，原报告不改写。完整最新回归见verify-context-admission-002.log（执行结果以收据为准）；源码/构建PASS不替代新包安装验证。

Mini准备将002的C06改为实际admitModelRequest消费，在最终投影后先guard，再计物理reserve/HTTP；增加获准schema真实codec正向、不同窗口、所有摘要/保留尾部及零token拒绝检查。C02加强为明确not_found，并分别覆盖denied/unsupported/cancel/limit；C03不得为了固定两调用而另写恢复器，应核对真实Pi是否需要有界摘要并按同Task计量。C01/C04/C05/C07及J01旧包局部证据都保留，不称V01–V17通过。J01仍未到全量计算/IR/proof/Outcome/UI；50KiB不是已冻结catalog总预算。

仍待闭合：R2 HTTP context/全部安全错误与已知零/错误usage/物理状态/实际model公共载体；R1 read限额分类及产品获准资料映射；R3 bounded-output与已执行receipt保真；所有受影响取消/撤权/UNKNOWN/保存/账本/审计故障、旧Task/skills/fork回归增量；新精确版本不可变tgz及独立安装消费者；Mini Application→Adapter→实际安装包→IR/核验→Outcome/UI离线合成联验。

SDK继续上述工程，不等待Mini全部产品工作。正式采用仍须精确新版本tgz、bytes/SHA256、源码/依赖/包内容身份、合同增量/完整命令退出码/独立审查及回滚限制；Mini接收根 `<MINI_RECEIVING_ROOT>/<version>/<sha>/`。由用户转交，不跨聊天发消息；不可指向在研源码/可变链接或临时node_modules补丁代替固定包。真实Provider/发布/部署仍未授权未执行。

## R2完整载体与R3输出收口实施规格（001交付不改写）

R2新策略仅对新Task显式启用，完整策略入Task配置hash；旧固定配置及cached-context的零/缺失输出保守预留保持。实际公共载体以实现与RED/GREEN后新身份交付为准。载体分别记录所选candidate/Provider报告model、可信stop、安全分类/诊断、HTTP状态、not-sent/response-received/UNKNOWN，以及每个input/output的已知数（包括0）或未知状态，不保存响应正文/业务文本/凭据。未知output保持原预留；已知input须计入同Task，即使output未知。需为新策略BudgetLease提供可原子记录部分用量的显式可选扩展；不支持则发出前拒绝，不重造账本或迁移历史。

SDK仍用Pi原生HTTP/SSE内容编解码及Session。Pi0.86.1归一后丢失usage字段是否出现，不能从0推断未报告/免费。为了保留字段报告状态，拟复用已经随Pi精确安装的openai6.40.0原生SSE消息迭代器，仅观察元数据；不重建内容/工具/恢复编解码。作为直接依赖精确固定同一6.40.0，是消除未声明传递依赖所必需，导入只解码器不创建OpenAI客户端，不发现凭据，不增请求/接收方/权限；必须证明lock中各包版本/完整性不变并在安装包消费者核对实际解析。Pi core/ai不升级，不增加coding-agent依赖。

R3在真实工具执行完成之后区分完整宿主资料与模型小结果，宿主持久回执/读引用仍由宿主提供。共享工具签名沿用execute与invocation；最小输出投影策略应固定到tool配置，在已执行后输出不合法/超限/保存失败时留下可消费的完成/未知效果信息和已知成本，禁止自动重放。不裁断JSON、不自建存储/分页，也不将危险失败改soft success。

## Mini 最小 API 合同与接入说明：增量002

此节覆盖001的“仍待实现”项；001固定原件、源码快照及历史失败不改写。源码基线HEAD为b07057faaecd919109fff6adaca8f9365be95ccc，实际实现是本任务未提交WIP，必须结合此次source manifest核验。接口已确定、源码回归已验证与固定包消费者验证分列；Mini产品联合验证仍未执行。

### R1与接线顺序

公开入口为 `admitModelRequest(request: ModelRequest, policy: ContextAdmissionPolicy): Readonly<ContextAdmission>`；配置 `RuntimeOptions.contextAdmission?: ContextAdmissionPolicy`（SessionRuntimeOptions继承）。`ContextAdmissionPolicy`为 `{policyVersion:string, protocolOverheadTokens:number, safetyMarginTokens:number, imageTokens?:number}`。模型窗口、输出cap、thinking和图像能力仍使用既有ModelConfig。错误 `ContextAdmissionFailure` 的reason为INVALID_REQUEST，安全report在admission。取消、非法DTO或能力不足保留既有Reason。

Guard纳入完整system/tools/schema/description、history/current tool/tail、reasoning/signature/images及输出预留。复用Pi estimateTokens，额外补算system/tools；预算取Pi估算与UTF8 JSON包络字节加权值的较大者，加入协议/图像/安全余量/输出预留。所有值均是配置或保守估算，不能声称通用tokenizer保证；Provider实际usage另记。1MiB工具存储、50KiB原生read截断和model window互不替代。仅接受普通无accessor/proxy/循环的DTO；通过后递归冻结原请求。宿主发出同一对象，重新投影须重新guard。

Mini固定002的native-open-analysis.ts:63–83接线：已有任务/授权/取消检查 → 67–74受信schema/description替换 → 75实际候选接收方许可 → 设置实际输出cap、合并实际signal → 调用guard → 76物理账本原子reserve（digest同一final.messages）→ 等待后重新检查撤权/取消 → 77issued → 80–83调用同一实际候选createPiTransport。SDK前置guard不能替代此最终guard，observer不是权威门，guard也不授予数据外发权限。

```ts
import {admitModelRequest, createPiTransport} from 'pi-agent-runtime';
const policy = {policyVersion:'host-verified-v1',protocolOverheadTokens:1024,safetyMarginTokens:8192};
const wire = createPiTransport({model: candidate,apiKey: syntheticKey,modelObservations:'v1',fetch: offlineFetch});
// trustedProject/checkAuthority/physicalLedger由宿主实现；此例不创建新SDK入口。
const transport = async (request: ModelRequest): Promise<ModelReply> => {
  const final = {...request, messages:trustedProject(request.messages)};
  checkAuthority(final); // 检查最终资料、候选接收方和实际signal
  admitModelRequest(final,policy);
  const reservation = await physicalLedger.reserve(final);
  checkAuthority(final);
  await physicalLedger.issued(reservation);
  try {const reply=await wire(final);await physicalLedger.record(reservation,reply.outcome);return reply;}
  catch(error){await physicalLedger.recordFailure(reservation,error);throw error;}
};
// 上例宿主ledger方法仅示消费顺序，不是SDK公共接口。record失败必须失败关闭且保留原效果/UNKNOWN。
```

在新Task的createSessionRuntime同时配置contextAdmission:policy。SDK逐候选、真实后续工具轮、原生摘要/压缩辅助请求都执行准入/授权/计量/审计。最终guard明确未发出的拒绝载体为not-sent、usage已知0；不会付费恢复或blind fallback。

### R2完整载体与部分计量

实际增量公共类型与入口：

```ts
type ReportedTokens = {kind:'known';value:number}|{kind:'unknown';reported?:number};
interface ModelOutcome {
  model: Pick<ModelConfig,'provider'|'id'|'protocol'>;
  responseModel?:string;
  stop:'complete'|'tools'|'length'|'deferred'|'error'|'cancelled'|'unknown';
  category?:'context'|'quota'|'rate-limit'|'unavailable'|'network'|'authentication'|'invalid-request'|'invalid-output'|'safety'|'unknown';
  physicalStatus:'not-sent'|'response-received'|'unknown'; httpStatus?:number;
  usageFinal:boolean; usage:{inputTokens:ReportedTokens;outputTokens:ReportedTokens};
  diagnostic:'COMPLETE'|'OUTPUT_LIMIT'|'CONTEXT_LIMIT'|'REQUEST_FAILED'|'CANCELLED'|'UNKNOWN';
}
// ModelReply.outcome?; RunResult.modelOutcome?; AuditEvent.modelOutcome?
// ModelFailure(outcome:ModelOutcome, reason:Reason='MODEL_FAILED') extends RuntimeFault
// ProviderFailure(category:'quota'|'rate-limit'|'unavailable'|'network', outcome?:ModelOutcome)
// RuntimeOptions.modelObservations?:'v1'; PiTransportOptions.modelObservations?:'v1'
// BudgetLease.recordModelUsage?(reservedTokens:number,
//   usage:{inputTokens?:number;outputTokens?:number;final:boolean}):Promise<void>
```

新Task在Runtime和每个createPiTransport同时显式开启modelObservations:'v1'。新策略要求每个回复显式ModelReply.outcome（自定义transport也一样）；无载体即INVALID_OUTPUT/UNKNOWN、保留预留并停止。不能将旧PiTransport/旧ProxyTransport的保守数值冒充实际已知用量；Proxy本轮未增加v1编码，不能直接搭配新策略。旧省略策略仍兼容。Pi仍负责实际HTTP/SSE内容、工具、reasoning编解码；共享层仅用精确openai6.40.0原生SSE framing保留usage字段是否出现，不能从Pi归一后的0或output=1推断缺原因、免费、length或HTTP400。HTTP错误只解析有界结构化code/type/usage；不记录响应原文、message、密钥或cause。配置候选与Provider报告model分列，UNKNOWN不猜身份。成功工具后的模型错误仍失败，Worker/Text仍拒绝length结构结果，Agent仅适用原生恢复。

known包含已确认0；unknown.reported是已确认部分计数/下界，**不是总量已知**。usageFinal=false或physical unknown不得退掉输出预留。预算callback每次物理尝试原子调用一次：已知input/部分input计入同Task；final且output已确认时才释放该次预留并计实际output；其余保持预留并至少保留大于预留的已报告output。不支持callback的新策略BudgetStore在发送前CAPABILITY_UNAVAILABLE，不能以旧settle/零值模拟。memory store只是同进程参考，不证明生产持久原子性。

取消/截止后立即返回的RunResult是当时冻结快照，可包含UNKNOWN；不能原地改为成功/退款。物理操作实际结束后，SDK继续保留lease并记录独立terminal model.finished/tool.finished事实，已知计数计入但晚到不退款、不发布、不重试；waitForIdle等待本实例实际结算结束。宿主audit拒绝/ledger不可写时无法声称持久确认，需保留原UNKNOWN并独立核账，不能补造收据。此机制不自动恢复历史任务。

Mini80–89必须将ModelReply.outcome或ModelFailure/ProviderFailure.outcome映射到真实物理账本，分清known0/部分known/UNKNOWN。586–615消费RunResult.modelOutcome、toolOutcomes和usage，不再用静态primary替实际model。生产持久BudgetStore源码未在002内，recordModelUsage原子持久、重启读回和晚到结算须Mini实现并验收；此点仍待消费者确认，其余SDK工作不等待。

### R3已执行结果、回执与read

```ts
interface ToolOutputPolicy {
  policyVersion:string; maxBytes:number; //1..1MiB，模型投影的JSON字节上限
  project?(input:{value:JsonValue;signal:AbortSignal;invocation?:ToolExecutionContext})
    :Promise<{value:JsonValue;receiptId?:string}>;
}
interface ToolOutcome {
  name:string; effect:'read'|'write'|'external'; status:'completed'|'unknown';
  modelOutput:'pending'|'ready'|'rejected'|'failed'; receiptId?:string;
  resourceUnits:number; invocation?:ToolInvocation; reason?:Reason;
}
// Tool.modelOutput?:ToolOutputPolicy; RunResult.toolOutcomes?; AuditEvent.toolOutcome?
// ToolOutputFailure(outcome:ToolOutcome,reason:Reason='TOOL_FAILED') extends RuntimeFault
```

Tool.execute沿用原参数与原生invocation。宿主project保留完整合法JSON和业务计算结果，再返回有界完整JSON及宿主定义的获准read资料定位；SDK不裁断JSON、不增加存储、分页、业务语义或Provider调用。policyVersion/maxBytes进入同Task配置身份；函数实现语义变化由宿主更新版本，不能热换旧任务。opaque receiptId仅技术身份，不是可读证据，不代表产品所有保存/验证已完成。

execute正常返回后status确定completed，即使后续投影/保存/输出超限/模型/审计失败。合法projection receipt保留在失败结果及audit；已确认completed不会因后续UNKNOWN保存被抹掉。若业务在SDK execute内部已发生效果但随后保存/撤权检查抛错，宿主应抛**真实**ToolOutputFailure（匹配name/effect/resourceUnits/同一invocation），明确completed或unknown及已有receipt；SDK不从任意异常推断执行完成。不确定即UNKNOWN，无自动重放。原生Session历史保留，不删旧工具条目。

```ts
const tool: Tool = {
  name:'bounded_compute', description:'host-defined synthetic local tool',
  parameters:{type:'object'},effect:'write',resourceUnits:2,replay:'never',
  execute:hostExecute, //真实效果/内部后检查失败须显式保留已有receipt或UNKNOWN
  modelOutput:{policyVersion:'host-view-v1',maxBytes:16384,
    project:async({value,signal,invocation})=>{
      const saved=await hostPersistAndMakeAuthorizedView(value,signal,invocation);
      return {receiptId:saved.receiptId,value:{status:'stored',read:{path:saved.viewPath,offset:1,limit:100}}};
    }}
};
// hostPersistAndMakeAuthorizedView是宿主函数；path/view/字段授权与资料含义由宿主负责。
```

直接复用createExecutionTools(host,['read'])：schema offset/limit、content/details、截断/续行仍为Pi工厂机制。not_found、permission_denied、not_supported、cancelled和ExecutionLimitFailure(code:'limit_exceeded',reason:BUDGET_EXHAUSTED)可区分；未知错误中立不泄露host异常正文。产品负责reference→获准文件/字段/派生视图映射，授权/撤权、全量本地计算；hash本身不可读。原生超长首行建议bash不授予bash权限，应给宿主窄的分行视图，不能绕开原授权。R5 grep/find/ls不在此批。

Mini固定002中Application224–225、354–379已有执行/保存接缝，SDK不能自动从business错误code恢复丢失receipt；通用Tool注册open-analysis-adapter.ts:57–63/296–299必须显式桥接modelOutput与ToolOutputFailure。Application的自有属性不会自动穿过这套dispatcher；业务effect/IR/核验/Outcome始终由Mini负责。

### R4、兼容与测试返回点

直接复用PurposeConfig.fallbacks，创建Runtime时固定全部用途、候选model/transport/tools/thinking。每候选重新完整准入和接收方授权；不能因备用存在扩大数据接收者许可。实际候选进入modelOutcome及audit；后续工具请求、摘要仍同Task。modelRecovery.extraAttempts:0|1与原生可恢复overflow/length、SDK fallback/native retry共用同一逻辑请求额度。摘要是计量的辅助物理请求，不是免费的独立重试；恢复已消费额度后不会再叠加fallback。UNKNOWN物理失败新策略停止，即使host只抛旧ProviderFailure无载体也不盲切。旧省略观测策略的已固定合同保持。

Pi core/ai仍0.86.1，原生Session/Harness/compaction/read/codec直接复用；精确新增直接依赖openai6.40.0与既有Pi transitive版本一致，依赖锁中151个非root项目身份不变。只用SSE framing、不创建OpenAI客户端、不继承认证/全局目录。不启用第二会话引擎、默认coding-agent、R5/R6或Shell/Edit/Write/网络。

省略新策略的旧配置hash及旧checkpoint/native读回路径保留；选新策略或tool输出版本意味着新Task配置，旧taskId不能偷偷改策略，不迁移账本/历史。fork/skills不授予新的预算/外发/自动resume。回滚须保留新Task消费/UNKNOWN；旧版本不能自动resume含新配置的任务。0.5.0其他候选不被此工作覆盖；本任务从b07057f基线单独交付精确本地候选，不推定包含其他分支功能。

已实现验证对应tests/context-admission.test.ts、runtime-boundaries.test.ts、provider-fidelity.test.ts、tool-output-fidelity.test.ts及完整旧回归；RED/GREEN命令、退出码、固定源码/依赖/包身份在本轮delivery receipt。Mini002 C02断言应强校验not_found；C06应在真实最终投影调用正式guard而非要求SDK阻止host绕过。C03首轮length无可压缩历史不能保证可恢复，应保留首轮失败证据，再以真实历史/原生摘要/恢复验证适用条件，不重建循环或削弱Worker断言。

| 验收 | SDK适用证据/边界 | Mini仍需验证 |
|---|---|---|
| V01–02 | 中立SDK与合成输入机制 | 真实Application两2985行CSV全量计算、IR/核验/Outcome |
| V03–05 | UTF8/转义/完整schema/大结果有界投影/原生read | 8/32MiB资料、catalog多文件/2048sheet、10000列/长cell与资料视图端到端 |
| V06–09 | 最终guard/200k–1M/真实native尾部与压缩/HTTP-SSE/统一额度/用途fallback | 实际最终工具投影、候选授权、全部真实用途安装包接线 |
| V10–11/13 | 工具后模型/输出/保存/审计/账本失败；取消/迟到/UNKNOWN硬停止 | 产品持久budget/物理ledger/business保存原子回执、撤权联合 |
| V12 | 安全中立诊断载体已提供 | Store→HTTP→client→renderer、刷新零调用 |
| V14 | 旧配置/旧checkpoint/native历史/fork/skills回归 | 原产品兼容固定包保留及受控新Task采用 |
| V15–16 | 每tool显式输出策略、实际read引用、已知效果/usage保留 | 27业务工具、纠错回包、完整报告事实/观点/不足/lineage/proof |
| V17 | native read错误/路径隔离/限额/分页/长单行保留 | 真实资料映射、撤权与产品窄视图；搜索能力延期 |

接口已确定不等于新包可安装；源码GREEN不等于独立固定包PASS；固定包PASS不等于Mini联合验收。后续正式联合验证只能消费精确版本不可变tgz并核对bytes/SHA256，不能使用在研源码、链接或node_modules补丁。

### Mini003补充核验与候选冻结边界

mini-consumer-003-r1-codec.tar.gz实际收到2028303 bytes、SHA256 88a45a7f8db2d77dce69ddcd554ce4c780ec07f54a97bdeb8422f7e396d4b903。README/SOURCE-IDENTITY/RUN-RECEIPT/对齐记录/SAMPLE-INDEX已读取，119份payload、112份source来源与120项checksum逐文件核验。9组/18次旧0.4.3离线codec测量均ANALYSIS_INCOMPLETE，最大HTTP body961743 bytes，不证明token安全或新guard通过。生产准入参数仍UNKNOWN，SDK合成策略不得作为启用参数。新固定候选将独立安装运行003实际公共guard脚本与18份相对路径最终投影，明确仅离线合成假设策略。

精确本地候选版本0.5.1-r1r4.2，相对0.4.3可选API增量；没有提交或发布，不重打0.4.3或覆盖既有0.5.0。此文前面的日期分段是历史记录，增量002及最终固定收据是本轮当前状态，不能把历史“未实现”句子当成当前导出缺失。共同返回点仍为Mini核验固定字节、隔离采用并验证实际Application/Adapter/账本/安装包/IR/核验/Outcome/UI。

### 冻结候选001复审更正（历史保留）

0.5.1-r1r4.1固定142524 bytes/SHA50533d16e9e8f6148d03324982965a0d5efa31911a5e60a380651155838bd0a3，源码83文件aggregate78c737ca0313a459c2afc729a46ce7eb33f39ce5e863ff5886e5aeee1cf71241。完整252+2回归PASS不抹掉随后独立复审NEEDS_FIX：HTTP非法cache usage与context code组合误走原生恢复。该固定包未交产品采用，保留失败/源码/包不覆盖；增量修正将invalid-output优先分类，原生overflow恢复只允许MODEL_FAILED的已确认context错误，非法输出不summary/recover/fallback。新候选0.5.1-r1r4.2另起包身份。API签名不变，合同副本另起003身份，不覆盖001/002。

## Read 安全失败载体增量003（0.5.1-r1r4.3）

2026-10-15 Mini `mini-sdk-read-carrier-001`固定复现确认：0.5.1-r1r4.2 factory的FileError.code会在公共Session收敛为TOOL_FAILED；API003的“可区分”只覆盖factory直接调用，不足以支持Session→UI。API003固定原件不改写，此节修正该公开载体缺口。R2 ModelOutcome/原子recordModelUsage与R3效果/执行后超限已由Mini落实，不重新标为待定。

### 实际公共增量

```ts
export type ToolFailureCategory =
  | 'not_found' | 'not_directory' | 'is_directory' | 'permission_denied'
  | 'invalid' | 'not_supported' | 'cancelled' | 'timeout'
  | 'limit_exceeded' | 'unknown';
// ToolOutcome新增可选字段，其他字段及函数签名不变：
// failureCategory?: ToolFailureCategory
// RunResult.toolOutcomes?: readonly Readonly<ToolOutcome>[]
// AuditEvent.toolOutcome?: Readonly<ToolOutcome>
// new ToolOutputFailure(outcome: ToolOutcome, reason?: Reason)
```

既有createExecutionTools(host:ExecutionEnvironment,names:readonly ('read'|'write'|'edit'|'bash')[]):Tool[]签名不变；Mini只选择['read']。观察条件仍为RuntimeOptions.modelObservations:'v1'或工具配置modelOutput，不新增观察开关或Task配置字段。省略两者的旧消费者保持无toolOutcomes形态。failureCategory是诊断，不能推断效果完成、退款、重放许可或业务成功。

| 受信结构化来源 | failureCategory | factory直接code / RunResult reason |
|---|---|---|
| ENOENT | not_found | not_found / TOOL_FAILED |
| ENOTDIR、EISDIR、EINVAL | not_directory、is_directory、invalid | 同名 / TOOL_FAILED |
| EACCES、EPERM、RuntimeFault(AUTHORITY_REQUIRED) | permission_denied | permission_denied / TOOL_FAILED |
| ENOTSUP、RuntimeFault(CAPABILITY_UNAVAILABLE) | not_supported | not_supported / TOOL_FAILED |
| ECANCELED、ABORT_ERR、RuntimeFault(CANCELLED) | cancelled | aborted / TOOL_FAILED |
| ETIMEDOUT、RuntimeFault(DEADLINE_EXCEEDED) | timeout | aborted / TOOL_FAILED |
| ExecutionLimitFailure、宿主RuntimeFault(BUDGET_EXHAUSTED) | limit_exceeded | limit_exceeded / BUDGET_EXHAUSTED |
| 未分类宿主错误 | unknown | unknown / TOOL_FAILED |

显式RuntimeFault停止原因优先于附带errno。只有名称为AbortError/TimeoutError而无上述受信类型/code的异常不推断cancel/timeout。

不解析message/name/cause，不把任意工具的.code或.failureCategory当受信载体。factory使用内部原生FileError子类保留已有code兼容、区分明确cancel/timeout，再经受控桥接复制中立分类到ToolOutcome；不向公共类型暴露Pi类。未知原生异常（例如Pi只有文字的offset越界）不猜具体类别，failureCategory可缺省，UI必须显示未知。其他已公开Reason可保持自己的运行停止含义；外部取消、SDK deadline首先决定RunResult CANCELLED/DEADLINE_EXCEEDED，不能因某工具诊断反转运行停止。

read未成功返回时status仍unknown，modelOutput failed；name/effect/resourceUnits和invocation来自已准入调用，已知模型usage照旧保存。同一Task失败关闭，不因类别精确而重试/重放。取消返回时未结工具的冻结快照仍unknown/pending、类别可能尚缺；晚到事实在独立tool.finished中带类别，不改写原快照，不退款、不触发自动resume，waitForIdle等待实际结算。

ToolOutputFailure仍仅在name/effect/resourceUnits及完整invocation匹配时采用；failureCategory验证上述封闭枚举、剥除额外属性。completed/receipt及已知消耗仍按既有R3保真，诊断不覆盖完成状态；不匹配或普通伪造对象不能引入类别/收据。审计或账本故障继续失败关闭，返回载体不证明持久写成功。

### 最小采用示例

```ts
import {createExecutionTools, type ToolOutcome, type ToolFailureCategory} from 'pi-agent-runtime';
const tools = createExecutionTools(host, ['read']); // host为现有授权资料映射，非新增SDK API
// 保留现有createSessionRuntime的modelObservations:'v1'、budget/audit/guard接线。
const result = await runtime.run({...approvedRequest, tools});
const read = result.toolOutcomes?.find(item => item.name === 'read');
const category: ToolFailureCategory = read?.failureCategory ?? 'unknown';
// Mini将category与read.status/modelOutput/invocation/resourceUnits分列持久化；
// AuditSink.append同步接收event.toolOutcome，同样只消费已验证枚举。
// 无精确类别时保留unknown，不解析result.reason或异常原文以猜not_found。
```

公共reason不扩枚举；既有结果/审计读取器需允许新增可选字段。新增分类不进入Task配置hash，不要求迁移旧Task或历史；历史无类别维持UNKNOWN，不回填猜值。已启用v1的配置可在经核验采用后保持身份，原新Task启用、旧Task恢复/迁移授权边界不变。回滚读不到新字段仍须保留原存储/历史，不清账或重放。旧版本不会因此获得自动resume新Task的权限。

### 限额与产品责任

宿主文件限额是ExecutionLimitFailure/limit_exceeded。Pi原生50KiB/2000行截断及offset/limit续读成功返回content/details，不能标成工具失败或host限额；超长首行提示不授bash权限，宿主仍负责获准窄视图。工具modelOutput超限是已有modelOutput:'rejected'及完成/回执保真，与read文件失败类别不同；不强行归为limit_exceeded。

Mini需在固定包核验/隔离安装后补真实Application→Adapter→Session→持久Store→HTTP/client/UI的类别透传及负向/刷新零调用，保持原completed/UNKNOWN/usage事实。SDK公共/codec/持久Session合成验证不替代产品存储或UI验收。未保存正文、checkpoint.required.execution_plan、finish_result.result的所有权/重开归产品；SDK不建立通用存储、读取、分页、压缩或恢复替代机制。

生产overhead/margin/image参数仍UNKNOWN；512/8192是合成参数，961743bytes是旧观察值，4552离线PASS/1真实ProviderSKIP不是完整R1–R4或产品验收。保留历史0.5.1-r1r4.2与本增量所有RED/FAIL；真实Provider/凭据/业务数据/生产/服务/Git发布及其他产品停止线不变。固定候选及实际验证身份另见交付收据。
