# R1–R4 本地候选合同

基线b07057faaecd919109fff6adaca8f9365be95ccc（SDK0.4.3），独立codex/r1-r4-sdk-boundaries-20261014工作树。精确候选版本与tgz字节以package.json和固定交付收据为准；未提交、未发布，不覆盖任何旧发行包或其他0.5.0候选。

新增可选准入/ModelOutcome/部分计量/工具输出合同构成相对0.4.3的兼容增量，采用独立0.5.1-r1r4.2本地预发布身份。旧省略选项的配置hash与历史不迁移，安全缺陷修正保留失败关闭；选择新策略须新Task及宿主相应callback，不能自动恢复旧任务。新event可选字段需严格消费方更新解析，原version1.0不改。Pi依赖不升级；openai直接声明同一原传递版本6.40.0，完整lock身份不漂移。

具体公共签名、Mini最终投影顺序、原生read、失败/known/UNKNOWN/物理状态、统一once-extra、输出效果/receipt及兼容限制见R1-R4-ENGINEERING-HANDOFF.md增量002。没有删除第二循环或分页代码，因为未新增这些引擎；替换清单为错误擦除/usage归一推断/未保真输出桥接/独立叠加恢复的受影响分支。旧checkpoint保留，R5/R6退役未启动。

正式消费者必须安装固定新tgz并核对完整bytes/SHA256、manifest、lock及解析路径。独立SDK消费者PASS不代替JuanerAI Application→Adapter→安装包→IR/核验→Outcome/UI联合验证。Mini002生产BudgetStore缺快照，生产原子计量/Store/UI和真实Provider均未验证。不迁移、清账、退款UNKNOWN或自动resume；回滚只可在明确兼容/账本核查后受控采用旧固定配置。

## 0.5.1-r1r4.3 read载体增量

基于Mini实际采用的0.5.1-r1r4.2固定字节，新增ToolOutcome.failureCategory可选稳定枚举，修复factory分类在公开Session/audit丢失以及cancel/timeout无法区别。既有顶层reason、配置hash、效果/回执、usage及UNKNOWN不变。无依赖变更，不复制Pi read/分页/Session/恢复。具体合同见R1-R4-ENGINEERING-HANDOFF.md增量003。精确包、来源WIP、依赖、实际隔离安装、RED/GREEN/回归及独立评审身份以本次固定交付回执为准；历史.1/.2不覆盖，产品只补受影响接缝并独立验收。R2/R3现有接线不重新待定。生产准入参数UNKNOWN，真实Provider/生产/Git发布仍另行授权。
