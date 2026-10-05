# 第一阶段旧实现与 Rust 迁入边界

核对日期：2026-10-04。证据目录为 `D:\EDY\Documents\CL\director-web-3008-stage2-images`。本文依据当前源码与规则正文；未运行旧后台、未发起模型请求，未读写生产项目数据库。旧脚本是迁移证据，不成为新核心运行依赖。

## 应迁入的实际流程

正常产品入口是 [app/actions.ts:449](D:/EDY/Documents/CL/director-web-3008-stage2-images/app/actions.ts:449) 的 `startFoundationDeliveryAction`，启动一份持续保存的制作基础任务。执行入口为 [foundation-delivery.ts:731](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-delivery.ts:731)。不能将旧 `project-foundation.ts` 中保留的 F1/F2/Q1 兼容链误认为当前轻量产品的完整主流程。

实际推进是：

1. 程序保真读取原文、识别分集分场。来源、结构、说者检查通过时直接继续；仅真实未决结构需要模型提出声明式范围决定，正文仍由程序按源区间物化。
2. Rust 迁入旧本地事实索引和按范围检索，不增加事实提取模型岗。
3. F2 依据原文与事实证据生成必要资产目录。短集按顺序合批；过长单集才按原文分片。
4. Q1 直接编辑目录与必要场景元数据，只交实际差异；正确内容保留，程序问题由程序处理。
5. 保存版本化制作基础，为第二阶段提供资产/形象与实际使用范围，为第三阶段按需提供本集原文、背景、历史证据和连续状态边界。

程序直通证据见 [fidelity-source-assist.ts:33](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/fidelity-source-assist.ts:33)。它检查来源证明一致、明确集场、无未决来源问题和有效说者结构；成功标记 `method: PROGRAM`，没有模型调用。不能把所有脚本无条件再送一轮全文摘要，也不能用模型重抄原文。

## 真正的岗位规则与执行脚本

| 证据 | 原有职责 | 最小迁入行为 |
|---|---|---|
| [F2.md](D:/EDY/Documents/CL/director-web-3008-stage2-images/prompts/foundation/F2.md:1) | 轻量资产制作目录 | 迁入必要实体筛选、五类资产、必要造型/持续状态、实体与声音的区分、素材处理方式及真实集场引用。 |
| [Q1.md](D:/EDY/Documents/CL/director-web-3008-stage2-images/prompts/foundation/Q1.md:1) | 轻量目录终编 | 迁入直接修正、局部差异、范围保护和场景拆分计划；不新建独立审查岗。 |
| [foundation-production-prompts.ts:75](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-production-prompts.ts:75) | 加载真实岗位正文并构造运输契约 | F2 规则只作为 system method 一次提供；任务包含自足输入和动态字段要求，不临时检索宿主 Skill。 |
| [foundation-delivery.ts:620](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-delivery.ts:620) | 按当前 scope 装配源、场、事实与目录 | F2 提供既有稳定身份索引；Q1 提供本批候选及批外变体索引。只检索相关证据，保留必要跨批身份 lookup。 |
| [foundation-production-contracts.ts:223](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-production-contracts.ts:223) | 读取作者响应、编号、校验与合并 | 迁入程序编号、已有身份沿 key、范围/来源校验及差异更新语义；不要把显示名误当配图主键。 |
| [run-foundation-delivery.ts](D:/EDY/Documents/CL/director-web-3008-stage2-images/scripts/run-foundation-delivery.ts:1) | 原 web 后台工作进程入口 | 迁移 runner 的职责，由 Rust 执行及保存；不需要常驻 Node 后端。 |

关键规则正文：

> F2：沿用现有对象时填写已有 `key`；新对象省略 `key`，由程序生成稳定身份键。

> Q1：只发实际差异patch，不回抄整份候选；字段的省略、清空与集合替换语义严格按本次schema。

F2 的筛选目标是需要锁定稳定身份、新外观或持续连续性的素材，不是把每个名词登记成图片。必要换装、持续伤态、真实造型和关键物不能为减少数量而删；普通动作、情绪、瞬时特效不自动变为独立资产。

`preparation` 的 `REFERENCE / DERIVE / INLINE / AUDIO / UNRESOLVED` 是素材处理决定；`fromKey` 是真正素材来源，不是召唤者或剧情归属。剧情关系另存 `relationNote`，人物剧情定位另存 `role`。来源循环、缺失父素材及上游未决由程序定位，见 [foundation-production-contracts.ts:297](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-production-contracts.ts:297)。

## 本地事实可直接 Rust 迁移，不追加模型岗位

源实现为 [foundation-facts.ts:42](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-facts.ts:42)、[foundation-fact-cache.ts:6](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-fact-cache.ts:6)。它们是确定性 TypeScript 程序，没有模型调用。输出是原句与检索元数据，不是“模型已核实的语义事实库”。

| 原行为 | Rust 应保留的契约 |
|---|---|
| 扫描全部非空源行，不依赖资产是否已存在 | 先建立程序证据索引；每条保留 source 版本、域、集/背景区身份与 UTF-16 左闭右开区间，原句从原文回读。 |
| 背景与正剧分别为 `CONTEXT / EPISODE` | 背景可支持本集理解，不能升级为本集已发生事件；第 0 集也须依实际来源用途区分背景和剧情。 |
| 格式行单独为 `FORMAT` | 完整格式标题不当剧情；匿名背景叙述不得仅因没有资产主体而丢掉。 |
| 有说者即 `CHARACTER_CLAIM` | 台词中的“必须/不能”等词不能变成世界规则。只有明确背景规则标签且无说者时才可机械标记全局规则候选。 |
| `identityNameGroups` 展开 name/aliases | 只是检索图；同名仍保留多个稳定身份，不据名字和邻句直接合并。 |
| 匿名未关联背景最多 12,000 UTF-16 单元 | 作为 `backgroundCandidates` 提供并报告省略计数；不能暗中变为全局事实，也不能声称已经语义穷尽。 |
| 历史状态先验证原句与源区间一致 | 按主体提供既有证据，标记适用性未知；不能无条件永久继承，不能每集重置。 |
| 历史检索不只看 STATE 关键词 | 保留主体关联的原句与同集各一条邻句，以便识别代词、知情、解除和反证。邻近不证明同身份、故事时序或当前适用性。 |
| 本集全文已发送，当前事实仅给元数据 | 避免重复拷贝整个本集；只有可从已发送完整源恢复的重复项才允许压缩。 |

历史证据的完整选择逻辑见 [foundation-facts.ts:87](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-facts.ts:87)；无损运输与未知结构回退见 [foundation-model-input.ts:212](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-model-input.ts:212)。最小身份 registry 当前保留完整索引，原因是代词、延迟揭示或未知依赖不能仅靠名字未出现而排除，见 [foundation-dependency-selector.ts:26](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-dependency-selector.ts:26)。

旧 cache 为内存 Map，最多 8 项。key 包含源/背景版本、资产 name/aliases、标准结构模式及人工结构决定。Rust 可先保留有界内存缓存；是否落 SQLite 是存储选择，不增加模型调用。缓存必须因实际依赖变化失效，不能因图片渠道、画风或版式变化重建机械证据。

## 调度、作用范围与身份保护

- 旧短集原文合批上限默认为 **24,000 UTF-16 单元**，不是每集固定一调用，见 [project-foundation-contracts.ts:208](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/project-foundation-contracts.ts:208)。实际发送还会计完整规则/事实/目录请求及输出预留，见 [foundation-request-plan.ts:4](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-request-plan.ts:4)；旧应用预算为 200,000 字符、输出预留 24,000 字符，属于应用保护而不是模型 token 上限。
- 长集默认按 **18,000 UTF-16 单元**分片，避开代理对和 CRLF 中间，完成所有无重复连续区间才登记整集完成，见 [foundation-fragments.ts:4](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-fragments.ts:4)。长集不会改变其它短集的调度方式，见 [foundation-fragment-work.ts:8](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-fragment-work.ts:8)。
- `coverage` 精确等于本批处理集；提供背景、前接原文、身份索引，不表示读过或获准修改其它集。必须同时满足 `scope`、任务 targets 和用户决定的 `applicationScope / changeTargets`。
- 现有资产沿稳定 key；新资产由程序编号。同名身份不能自动合并。旧 V2 作者响应不要求模型自造主资产或变体主键，见 [foundation-production-contracts.ts:228](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-production-contracts.ts:228)。新桌面端可以采用 `assetId / variantId`，但必须保留“程序掌管身份、模型提交已有引用或新增候选”的边界。
- Q1 `changes.assets` 为实际差异；省略保留、允许清空的明确空值才清空、`episodes` 为本批完整使用集合。`removeAssetKeys` 只移除本批用途；`mergeAssets` 仅用于确认同一身份。局部变体修订必须保留同集目标场以外的有效依据，见 [foundation-delivery.ts:313](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-delivery.ts:313)。
- 连续状态必须考虑伤势/服装/残损起点和有据解除、换装、遮挡、时空跳转边界；准备造型不等于实际已穿戴，纯声音标签不证明实体不存在。不能用减少图片数量代替这些判断。
- Q1 拆场使用已有 episode/sceneKey、内部新增起行及完整原文锚点；程序校验并物化，无须再买一轮 Q1。后续表现提醒不阻塞第一阶段；程序能力缺口不得循环派给模型或包装成人工创作决定。
- 已有付费响应与未知提交先按原记录恢复/核对；资料范围或运输优化不应把已购买请求变成新付费工作，见 [foundation-delivery.ts:1048](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/foundation-delivery.ts:1048)。

## 与后续阶段的最小交接及预期验收

第二阶段接资产目录、必要形象、素材准备方式和适用集场；再按选中资产的小事实集创作图片提示词。第一阶段不重做全库图片提示词，也不假称已有图片。

第三阶段按本集领取完整原文、场、身份/变体、已确认方向、背景和历史证据；派生所需但本集未出现的来源只标 `MATERIAL_SOURCE_ONLY`，不能误当本集入画资产。旧交接见 [light-foundation-supply.ts:120](D:/EDY/Documents/CL/director-web-3008-stage2-images/lib/light-foundation-supply.ts:120) 和 `LIGHT_EPISODE_SUPPLY_V2`（同文件第 162 行）；`TEXT_ONLY` 不表示图片生产或视频验收完成。

Rust 离线验收应至少覆盖：

1. 明确格式脚本直接通行，来源区间完整覆盖且字节、顺序、说者与台词不变；未决结构仅产生局部范围决定。
2. 同一短篇多集实际合批，超长集独立分片，代理对/CRLF 不被切坏；不能把这两类都退化为“固定逐集生成”。
3. mechanical facts 与旧实现小样对照：匿名背景、角色主张、格式行、别名检索、历史邻句、反证、跨时间状态与检索限制一致；构建及缓存命中时模型调用数为零。
4. F2 必要实体、准备造型待定位、同名不同人、服装/伤态/进化形象、召唤关系与素材派生区别、纯声音但实际交接实体保持正确。
5. Q1 只交可执行差异；字段省略与清空、局部删用途、身份合并、目标场以外引用、原文锚点拆场和范围保护均有边界测试。
6. 任务中断后复用原响应与已通过步骤，不重新计费；原文/规则/身份依赖变化能够准确使受影响内容过期。
7. 第一阶段产物可直接交第二阶段设计；第三阶段能按需读取本集原文与连续证据。整轮不增设新模型岗，不以写出逐集摘要充当迁移完成。

现有旧测试可作行为样例：[verify-five-step-facts-fragments.ts](D:/EDY/Documents/CL/director-web-3008-stage2-images/scripts/verify-five-step-facts-fragments.ts:1)、[verify-foundation-historical-wire.ts](D:/EDY/Documents/CL/director-web-3008-stage2-images/scripts/verify-foundation-historical-wire.ts:1)、[verify-foundation-asset-preparation-rules.ts](D:/EDY/Documents/CL/director-web-3008-stage2-images/scripts/verify-foundation-asset-preparation-rules.ts:1)。本文没有执行这些脚本；测试声明与静态源码证据不替代真实模型效果或用户验收。
