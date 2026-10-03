# 3008 资产生产卡与全剧方向供给（2026-10-01）

本轮在已有 dirty/untracked 开发成果上做增量修改；没有提交、推送、发布、真实模型／图片调用或生产库写入。旧协议、历史采用与普通单资产入口保留。

## 单集供给

`attachEpisodeMaterials()` 保留 `EPISODE_UPSTREAM_V1`、旧 `modelDesigns`，新增：

- `assetProductionCards: AssetProductionCard[]`，类型位于 `lib/asset-design-model-input.ts`。
- `seriesKnowledge`，由已确认方向卡的有来源索引按生产集顺序投影。

生产卡包含身份、适用集场、实际出场／仅材料依赖、原文依据、已采用设计增补、自由设计范围、图片可用性与非阻断材料缺口。未采用／过期设计不阻挡本集原文事实投递，也不把旧简述当作采用。`materialCandidates` 继续留在上游候选区，不自动整库扩成生产卡。

原文依据保留引用与来源，场景卡可关联本场动作，以支撑门、通路、遮挡、固定物、道具功能；不生成镜头或人物调度。台词及视觉提取引用中的人物主张继续标记 `CHARACTER_CLAIM`。采用简述明确标记 `ADOPTED_DESIGN_NOT_SOURCE_FACT`；旧简述兼容，不自动拆词后伪装原文依据。

采用表单新增可选 `freeDesignScope`（300字），原 `brief` 仍1–600字。无图片可继续文字制作；卡的 `imageEvidence` 固定为 `NO_PIXELS_READ`。参考图仅传安全说明和可用性，不传私有文件路径或声称已看像素。材料缺口的 `required:false` 不得被界面或下游擅自升级为“所有资产必须先采用”的硬门。

## 全剧方向与关系／揭示索引

方向确认卡继续不超过600字、由有权限用户确认。确认文字改为认可方向及表达边界，不要求用户声称逐字读完全剧。实际模型覆盖仍逐批核对全部 unit 回执，人工确认与模型送达证据不混用。

既有 `generateSeriesDirectionCandidate()` 的 evidence 批次可同时返回 `knowledge`，不新增逐集摘要或额外调用。关键关系、揭示、变化保存为 `knowledgeIndex`，每项包含原文、来源ID、UTF-16位置、主体与主张类型；模型不能指定或回填更早的来源集。程序根据实际源集绑定生效顺序，引用落在对白行时强制保留角色主张。没有明确生产集时点的作者资料仍保留索引，但不冒充本集已知事实。

本集仅收到当前及此前来源：当前项 `CURRENT_EPISODE_EVENT` 只从引文位置起成立；此前项 `PRIOR_EVIDENCE` 不表示状态永久持续。未来真相、未来伤情及其引文不下发前集。索引和集顺序受卡hash保护；旧无索引卡维持原hash规则。人工修改方向时只保留同源版本的索引。

## 明确选集资产生产入口

- `planEpisodeAssetProduction(projectId, episodeNumbers, requestedAssetKeys?)`：只读计划，返回选集、实际身份及必要派生依赖闭包、可生成项和来源版本。
- `generateAssetPromptsForEpisodes(projectId, episodeNumbers, {assetKeys?, runner?, shouldContinue?})`：明确生产动作；`assetKeys:[]` 为零工作、零模型调用。指定keys只处理选集内的指定项及必需来源；不自动覆盖人工提示词。
- `ensureAssetVisualFacts(projectId, runner?, {scope:{episodeNumbers,assetKeys?}, ...})` / `readAssetVisualFacts(projectId, allowPartial?, scope?)`：按选集和身份提取／读取；不把未选集正文、无关身份、未来形象送入模型。作者段只路由与当前身份有关的原始分片，仍是来源材料而非当前状态。
- `generateAssetPrompt(projectId,key,revision,runner?,scope?)`：旧四参数可继续；带scope时核验所选范围完整事实并仅使用该范围事实。

界面有明确“制作集数”，空白仅浏览不派单；选集范围传到事实整理和提示词生成。持久队列保存scope，支持当前LOC/PROP与必要派生，不只人物。局部缓存可供全局界面回看，但不会冒充全剧完整；相同scope复用精确缓存。统一调用预算由外层 `runRoleByProvider` 包装，不在此处重复记账。

默认工作流应总传显式 `assetKeys`：没选关键设计时传 `[]`，让原文生产卡先进入分镜；只有用户明确指定或第三阶段结构化材料需求才点补。未选关键设计应诚实提示，不替用户推断全套资产都要生成。

## 验证

新行为先失败后通过的回归包括：未采用仍投递生产卡、未来揭示过滤、知识索引随既有读取保留、角色主张防升级、知识集序绑定、选集不扫描全剧、显式空资产范围零生成、选集队列涵盖LOC。

已运行并通过：

- 新增 `verify-asset-production-cards`、`verify-series-knowledge`、`verify-series-knowledge-service`、`verify-scoped-asset-production`、`verify-asset-scope-ui`。
- 旧 `verify-asset-design-adoption`、`verify-series-direction`、`verify-series-direction-service`、`verify-upstream-integration`、`verify-asset-design-input`。
- 旧 `verify-visual-facts-planner`、`verify-visual-facts-selection`、`verify-visual-facts-merge`、`verify-asset-visual-facts-service`、`verify-asset-prompt-queue`、`verify-asset-prompt-stop`、`verify-stage15-automation-races`。
- `verify-asset-design-adoption-ui`、`verify-series-direction-ui` 的真实浏览器拦截请求交互；新增选集浏览器测试确认空范围禁用、请求范围正确、未来资产不派单。
- Node 24 `tsc --noEmit` 和已跟踪改动的 `git diff --check`。

数据库测试仅在新建合成SQLite或该合成库副本进行，模型均为注入替身。未声称真实模型语义、画面或用户认可已验收；集成正式构建由主任务统一执行。

## 选集闭环工作台与第三阶段状态

新增 `/projects/[projectId]/production`，沿用 Soft Iris 玻璃流程卡，导航及项目页仅增加闭环入口，第二阶段与第三阶段既有入口和历史保留。范围须明确选单集或连续链；关键设计默认空选并标为「未指定」，不等于已确认，也不自动生产全套资产。创建只保存范围及预算记录；查看、刷新、切换流程、登记补料、选择旧稿均不调用模型。

页面直接消费 `production-workflow` 的当前快照、下一步及共享预算。每次推进带 `expectedRevision`，409只刷新，不隐式重试。连续链明确保存各集选用版本，不取“最新稿”。默认沿用已有共享预算，新一轮需主动选择；未知用量明确显示，单任务风险确认不解除共享预算暂停线。首集质量核对由实际执行者检查主创、整编与主要问题，并留下说明；不是新增用户逐集审批。

第三阶段显示 `run.production` 的初步承接／实际核对／非连续／局部待补、材料需求与共享预算。执行阶段区分排队、本机等待、生成、接收回包；玻璃材质动效不作为运行证据。`legacyReadOnly` 禁止全部旧任务变更，但可查看并导出已存 Markdown、JSON。既有原文、任务、候选与分镜不会删除。当前界面显示统一 `GPT-6.1 Sol / medium / 全局4 / 同集1`；「1.5阶段」只在当前展示改称第二阶段，存储协议与历史文档不追改。

## Stage 3 按需材料候选

`generateAssetPromptsForEpisodes` 新增可选 `materialNeeds`。仅在非空局部需求时传入；常规选集生成省略此字段。每项为：

```ts
{ workflowId, requestId, needRef, runId, episodeNumber, sourceVersion,
  target, purpose, sourceRefs, packageIds, blocking? }
```

workflow先验证需求来自当前选用任务的结构化 stage2 needs，登记动作不生成。下一次明确推进才调用 `lib/asset-material-candidates.ts`，校验选集、目标键及本集权威原文节点。只给模型所需原文证据、已有设计与采用简述；不先跑全剧事实，不重建资产库，已有人工／READY提示词也不被覆盖。角色固定为 `gpt-6.1-sol`、`medium`，预算仍由统一外层逐次限制。

候选独立保存于 `ASSET_MATERIAL_CANDIDATE_V1`，按完整scope、需求及设计依据幂等。重复READY请求复用结果；未结或失败回执不自动重发。简述<=600字是交付约束，超限保留完整回包并标待核对，绝不机械截断功能信息。已有采用设计优先，候选仅补未锁定项；冲突必须反馈，不推翻关键锁定。

`readProductionEpisodeHandoff(projectId, episodeNumber, {workflowId,runId})` 才投递对应的 `assetProductionCards[].candidateDesigns`：每项 `provenance:CANDIDATE_ONLY`，包含版本、scope、精确needRefs／源节点／工作包及限制。无scope、别的workflow/run/集、过期来源或变更的设计依据均不投递。候选并不等于全局采用、原文事实或新出场；保留已采用设计。runtime白名单再次核验scope与本集源节点，不把候选自动写入entryFacts。

`readScopedMaterialCandidateReceipt(projectId, workflowId, requestIds)` 为恢复提供只读持久回执；调用方仍按当前需求和源版本核验，不据失败／未知回执重发。候选资料与其他生产卡一起由上层分离出硬源hash，局部补料不废弃已有正确稿。

新增及收尾验证已通过：

- `verify-production-ui`：7项全拦截真实浏览器检查（连续范围、零默认设计成本、确认门、共享预算、单次推进、首集实际核对、精确补料、关键设计选择、实际零集、409不自动重试及窄屏）。
- `verify-stage3-settings`：21项全拦截真实浏览器检查；`verify-stage3-state`、`verify-workflow-glass`、`verify-legacy-production-navigation`。
- `verify-asset-scope-ui`：闭环选集链接只恢复范围、不派单；范围传入事实／提示词，未来资产不生成。
- `verify-asset-material-candidates`：隔离合成SQLite与注入模型，精确证据、仅一次调用与缓存、人工和采用设计不变、scope隔离、来源变化失效、回执查询、600字超限完整保留及实际零集兼容。
- `runtime/storyboard-v4/input-upstream.test.mjs`：16项，包含局部候选scope篡改、源节点错配、未知字段过滤和旧输入兼容。
- 最后一次 Node 24 `tsc --noEmit` 通过。

## 独立需求候选保留修正

随后真实函数复现了同资产候选“最后一条覆盖前面”：CH01先补p1袖口A、后补p3鞋底B，按assetKey取最后记录导致A消失，进而让已经消费A的p1误判资料移除。修复改为按 `(assetKey, needRef)` 选当前最新READY记录，保留其他需求；构卡不再只取首条，改用 `candidateDesigns[]`。没有新增模型合并或额外真实调用。

材料层按need分别建立稳定依赖ID，仅投递与当前工作包匹配的候选；未知工作包或规划阶段不默认收到所有局部候选。基础卡剔除候选字段，A/P1和B/P3的新增及更新不改变基础卡版本。A真正替换版本时只更新A依赖；旧持久记录不删除，人工提示词及全局已采用设计不改。

旧 `candidateDesign` 单需求仍可读取，生成的材料ID及版本与新数组形态一致；两字段同时出现以数组为准，不重复投递。旧的**多需求合并singleton**属于本轮尚未发布、未写生产的形态，会规范化成逐need依赖；若将来导入已有消费者的此类旧合并ID，需要结合消费者工作包进行显式迁移，不能声称所有旧shape均零失效。

本次红→绿证据：新增 `verify-asset-candidate-retention` 在合成SQLite真实执行 A:p1→B:p3→A仍可消费，验证p1投递及版本不变、p2不收到候选、p3只收B、A新版本只影响A、旧记录与全局采用不变。仅两次注入替身调用，真实模型为0。`production-materials.test.mjs` 与 `input-upstream.test.mjs` 合计22/22通过，覆盖数组严格scope、重复need拒绝、旧单需求材料字节兼容；候选旧回归、生产卡及上游集成通过。该轮全库类型检查仅发现主任务正在修复的 `lib/storyboard-service.ts:150`（`runId` on `never`），本分工文件未报错；不将此轮全库检查标为通过。
