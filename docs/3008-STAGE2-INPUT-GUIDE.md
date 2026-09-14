# 第一阶段 → 第二阶段：岗位提示词设计交接

更新：2026-09-14。代码基线：9f17466；分支：handoff/3008-stage1-20260912。本页针对已提交的第一阶段实现。当前工作区另有正在开发的1.5资产形象设计文件，不在本页承诺的已验收接口中。

## Mac 从这里开始

只设计岗位提示词时，不需要运行网站或拿到私人数据库。先读本页，再按字段查阅链接源码。

```sh
git clone --branch handoff/3008-stage1-20260912 --single-branch https://github.com/K1rsam/director-web.git director-web-3008
cd director-web-3008
```

已有克隆先确认工作区干净，再 fetch / switch 该分支；不要覆盖 Mac 上未提交的修改。运行网站与迁移私人数据另见 [3008 Mac接手](3008-MAC-HANDOFF.md) 和 [.env.3008.example](../.env.3008.example)。仓库没有真实剧本、项目数据库、模型登录或密钥。

## 已有成果与尚未实现的部分

第一阶段提供：保留正文的来源与集场索引、全剧资产/子形象目录、集场使用关系、相关原文事实检索、前集末场参考、已确认决定与局部后续事项、版本化按集交接包。P4是第一阶段本地装配交接，不等待第二阶段岗位接入，也不需要额外买一轮总结。

第一阶段没有提供：最终分镜、镜头时长与运镜、完整视觉设计、已生成资产图片、经过完整语义推理的逐场连续性状态表。资产目录不是美术设定全集，事实检索不是“全剧记忆已经理解无误”。

## 正式读取入口

源码：[readLightEpisodeFoundation](../lib/light-foundation-reader.ts)、[buildLightEpisodePackets](../lib/light-foundation-supply.ts)。这是应用内函数，不是已发布的外部HTTP接口。使用方式：

```ts
const { packet, readiness, reasons } = await readLightEpisodeFoundation(projectId, episodeNumber);
```

返回 READY / PARTIAL 与原因；读取不调用模型、不修改任务。新第二阶段应沿这个读取口接入，不把旧E链当作已经适配的新消费者。READY仅表示该集第一阶段文字资料就绪，不等于图片已生成或专业创作已经验收。

## 按集包字段：LIGHT_EPISODE_SUPPLY_V2

| 字段 | 实际内容 | 第二阶段如何使用 |
| --- | --- | --- |
| documentRevision、sourceVersion、sourceContextVersion | 当前工作稿和来源版本 | 输出绑定这些版本，避免旧成果覆盖新资料 |
| episode、title、sourceText | 集号、标题、完整本集正文 | 正文为权威依据，不润色台词、不从历史响应恢复正文 |
| scenes | 场次表 | 以episode + sceneKey定位，不假定键总是“集-场”简单数字格式 |
| scenes[].sourceRange | 本集正文中的start/end | JavaScript UTF-16偏移，end不含；用sourceText.slice(start,end)，Python不能直接按Unicode字符索引照搬 |
| scenes[].heading/location/timeOfDay/interiorExterior/weather/timeLayer/characters | 场头与必要元数据 | 未知字段不当作创作事实，人物表也不自动证明全程在场 |
| scenes[].assetKeys | 本场基础身份及有关变体的引用键 | 先解析身份/变体再选用，列表中有父键与子键不等于两者同时出镜 |
| assets | 本集有关资产与变体目录 | 字段为key/name/type/role/aliases/episodes/sceneRefs/preparation/variants等；本包用episodes，全局工作稿目录用usageEpisodes |
| materialDependencies | 派生需要的额外素材身份，use=MATERIAL_SOURCE_ONLY | 仅素材来源，不新增角色出场或额外剧情；不是图片URL |
| facts | 原文事实检索结果，见下节 | 作为证据，不把关键词分类当语义定论 |
| boundaryContext | 前一集末场参考，见下节 | 辅助衔接，不代替本集原文 |
| decisions、scenes[].decisions | 已确认事项 | 使用userAnswer；推荐选项不等于确认。遵循applicationScope及changeTargets |
| followUps、scenes[].followUps | owner=STAGE2的局部后续事项 | 只交给相应集场/岗位，不广播全剧，不代表第二阶段已处理 |
| gaps、warnings | 来源定位缺口和读取提示 | 区分真正缺口与提示；不把全部warning变成人工问题 |
| materialStatus=TEXT_ONLY | 只有文字材料 | 必须另查素材是否真正可用 |
| productionEligible | 当前构建器固定填写true，不能独立证明生产资格 | 函数允许集号0，接入时须依据来源分区与实际生产范围判断，不能声称它已自动排除第0集；同时检查readiness |

资产type：CH人物、GROUP群像、BEAST非人、LOC地点、PROP道具。role支持男主/女主/主角/配角/反派/路人，旧值可能缺失或自定义，不因缺标签中断工作。子形象继承父角色定位。名字不能代替稳定key。

preparation.mode：REFERENCE独立准备；DERIVE复用/派生；INLINE随场表现；AUDIO声音；UNRESOLVED尚未分类。fromKey是素材派生来源，不是召唤者、归属者或剧情关系；剧情关联另看relationNote。DERIVE变体缺fromKey时可按既有协议使用父资产，不自行建立循环依赖。

准备造型可能有空episodes/sceneRefs与用途note：表示未定位实际使用，不等于全剧可用或每集必须出图。当前总目录可查看它；某集的精确assetKeys不会自动把它安排进场。

## facts：必要事实与跨集状态的真实能力

源码：[foundation-facts.ts](../lib/foundation-facts.ts)。程序逐行保留来源证据，按人物/别名和规则检索，不为此新增AI总结。

- current：选出的本集必要证据引用，通常不重复statement；正文已经在sourceText。
- sourceFactIndex：本集非空行的证据索引，不是又一份剧情摘要。
- background：与本集相关的作者资料及被规则识别的全局设定；仍需结合出处核对。
- historicalStates：更早集数中与本集人物相关、被规则识别的状态原文。可能多次重复或已失效，不是“当前最终状态”。
- backgroundCandidates：尚未关联的作者资料候选，文字预算12000字符；backgroundCandidatesOmitted标记未提供条数。
- unlinkedBackground：未关联资料的位置索引；unlinkedBackgroundCount不是阻塞数量。

单条事实含subjects、kind、claim、validity和evidence。台词可能只是CHARACTER_CLAIM，不能自动当客观事实。当前构建的validity通常是UNKNOWN，不保证解除/发生时间已判断。evidence.domain区分EPISODE与CONTEXT，按episode或sectionKey回到相应原文，start/end不跨来源混用。

第二阶段应结合本场核对受伤、换装、持物、时间层与解除依据。不能只取“最后一条记录”，也不能因为未写解除就永久沿用；不把梗概中的未来事件提前应用。当前没有承诺全语义穷尽的身份/关系/状态图。

## boundaryContext：不是上一集全稿

previousSource提供前一集最后一场的地点、日夜、内外及最多2400字符末段，带行号、clipped和adjacentEpisode。若单行超长也会截取尾段，因此行号不能冒充未截取的完整引文。

priorStates实际是相关资产/变体与制作方式的参考，并非模型确认的当前身体、情绪、服装总状态。选取依据是前末场引用及本集首场相关性；地点也可能作为前场参考留下。跨集不相邻或来源缺失会记录gaps，不能补造中间剧情。

## 为第二阶段岗位编提示词时的输入设计

下面是建议，不是已完成的第二阶段实现：

1. 每岗写清“目标、允许修改字段、所需输入、输出结构、完成条件”。技术校验由程序承担，不要求模型输出长篇审核报告。
2. 按本次集场取原文一次；资产优先给本场引用与真实素材依赖，必要时再检索其它资料。
3. 已确认事项按集场和字段权限应用；包顶层与场内可能有同一决定，按id + revision去重一次。
4. 只交自己负责的成果/差异，保留原文与稳定引用，不回抄全剧目录、历史日志或前岗所有输出。
5. 同岗可修的局部问题直接在授权内修，不改别岗锁定内容；需要补取的证据由程序定向提供，不重新阅读全部项目。
6. 只有真实创作取舍才向用户提问。来源损坏、格式失败、无进展重试等是工作流问题，不能伪装成剧情选择。

可供Mac设计任务直接采用的任务说明：

> 基于本分支第一阶段交接协议设计第二阶段岗位。先列每岗实际需要的输入、可修改字段及输出；明确哪些由现有packet直接提供、哪些需要定向回查、哪些确实值得第一阶段统一补充。不得假定已有最终连续性状态表或资产图片。正文逐字保留；确认事项仅在其集场与字段范围内生效。采用按需输入和局部增量，避免整本重复读取、无限打回、无依据增加人工关卡。先形成可审阅的岗位提示词及接口方案，不自行启动真实剧本生成。

## 为什么历史导出可能达到数百万字符

[foundation-export.ts](../lib/foundation-export.ts)导出PROJECT_FOUNDATION_EXPORT_V1，包含当前稿、deliveryState内工作稿、全部episodePackets、原文/保真回执、历史快照、完整模型请求响应和调用日志。重复与历史使其远大于有效新增成果。

这个文件是留档/排错材料，不能整份塞进第二阶段提示词。导出的episodePackets直接构建，未附逐集reader完整的readiness判断；应使用按集读取入口，不能仅凭导出包存在认定可开工。真正需要排查时再读取具体历史记录。导出动作本身不调用AI，文件字符数不等于模型输入tokens或有效产出量。

## 本次交付的验证边界

本页按当前源码核对并独立复查；未启动用户项目、未改变数据库、未把测试样本跑完作为交付目标。现有回归覆盖来源保留、范围路由、局部修复与重复请求边界；不代表各种新剧本都不会失败。Mac实机运行、第二阶段消费者与岗位提示词效果尚需在Mac继续验收。
