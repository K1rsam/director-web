# 全剧方向减负与已付进度恢复 V2

2026-10-01 起，2026-10-02 续记。增量说明，extends：S3-E0008、S3-E0013～0016；对应追加事件 S3-E0017。保留[全剧方向卡 V1](3008-SERIES-DIRECTION-CONTRACT-V1.md)及旧历史，不用本说明改写此前能力和验收结论。

本轮修复方向候选的机械分批、引用坐标、显式源定接收副本与失败恢复，不改变第三阶段创作职责，也不自动确认方向。免费工程验证已通过；同一《神君》campaign 的剩余综合已完成，现待方向确认，业务语义与实际候选仍由主线程审查。

## 1. 实际根因与适用边界

此次保存的完整来源为 61 个 unit / 61 个旧分片：30 个正文集、31 个 BACKGROUND。背景中 1 项有实际作者资料，另有 29 项仅集标题、1 项仅空白；后两类合计 388 个 UTF-16 字符。旧算法同时限制每批 6 个 unit 和 24,000 字符，导致 11 批证据加 1 次综合；其中后 5 批只有机械标题/空白，并不需要再次让模型解释剧情。

第二批模型已经返回完整正文及已知用量，但两个 knowledge 引文的 `start` 错误，旧校验器以 `DIRECTION_MODEL_EVIDENCE` 停止。不能把本地坐标校验失败当作模型未返回而重买；也不能把历史 `FAILED` 因仍持有指针而继续显示为“生成中”。

| 本样本的只读重放计划 | 新调用数 | 范围 |
| --- | --- | --- |
| 旧规则全新生成 | 12 | 11 批证据＋1 次综合 |
| 新规则全新生成 | 3 | 2 批有效来源＋1 次综合 |
| 核验并复用首 2 份已付回包后继续 | 2 | 1 批剩余有效来源＋1 次综合 |

这些是《神君》当前 61 units 的实测计划，不是通用固定调用数，更不是 Token 或费用节约百分比。真实输入、缓存命中、输出长度与费用须按实际回执另记；本轮没有删除必要语义素材或提高请求上限。

## 2. canonical V1 不变，传输清单升级

方向卡仍为 `DIRECTOR_SERIES_DIRECTION_V1`。canonical V1 的完整来源、证据身份和 `sourceVersion` 计算不因本轮减负而改变；新版本只描述发送与恢复，不升级原件、已付请求或旧方向卡指纹。

`prepareDirectionSource` 保留旧的单 unit 每 24,000 Unicode codepoint 分片、相同 `part-N-of-M` ID 及 UTF-16 `sourceOffset`；返回的 `allParts` 保留全部原文及额外元数据。新模型批次去掉“6 unit”硬限制，只按累计 24,000 UTF-16 字符装箱。若旧单片本身超过该发送预算，明确阻断，不截断、重编号或提限。

新存档 `SERIES_DIRECTION_MODEL_INPUT_V2` 冻结：

- `source`、`units`：原规范来源和上下文，供同源核验；不是压缩后的替代原件。
- `modelBatches`：该次实际采用的分片集合与顺序；恢复按这份清单理解本次回包，不用新算法猜旧调用。
- `reusedResponses`：扁平已付引用 `{runId, call, outputId, outputHash}`；多次恢复仍直接绑定原回包，不复制成新的付费调用。
- `programRecords`：机械覆盖回执。每项保留 `unitId/evidenceId/text/textHash/sourceOffset/reason`，不假冒模型证据。

无 schema 的旧来源包只按冻结的旧 6-unit 算法复原；未知版本停止，不擅自迁移。新恢复另建 run/来源清单/复用证据记录，旧 FAILED run、原输入、原响应及指纹保持原样。

## 3. PROGRAM 只处理已证明无需语义判断的部分

只有 `kind=BACKGROUND`、`production=false`，且字段形状完全已知的分片可进入 PROGRAM：全文空白，或每个非空行均为明确完整的“第 N 集”标题，N 必须在真实制作集号中。服务显式传入制作集号；不以未知标题推断新的正文集。

含正文、冒号内容、未知字段或元数据的 BACKGROUND，以及任何 EPISODE / UNRESOLVED，均不能按这条规则省略。PROGRAM、已核验旧覆盖与本次模型批次互斥且完整覆盖 `allParts`；`alreadyCovered` 只接受精确且不重复的已验证 part ID，未知/重复 ID 直接拒绝。

PROGRAM 是机械覆盖，不是“AI 已读完”或剧情理解证明；实际作者背景仍须进入模型证据与综合。

## 4. 唯一逐字定位不等于语义验收

新提示词要求模型提供本 unit 内的原文短引，不再要求模型计算字符坐标。程序只在指定 unit 中精确匹配；唯一连续逐字引文可机械恢复错误、缺失或无效的旧 `start`，并追加 `coordinateCorrections`，保存原始 hint、修正后的局部/绝对范围及理由。重复引文仅可沿用准确的旧整数坐标，否则阻断；不跨 unit 搜索，不改标点、空白或 Unicode 形式。

旧回包原文不变；正确旧坐标的条目 ID/hash 不变。范围与对白、OS/VO 相交时，`SOURCE` 保守降为 `CHARACTER_CLAIM`，已有角色说法不会被升级成客观事实。后台定位范围不再重复发给模型机械抄算。

这只证明“引文与来源坐标对应”，不证明 `statement` 被引文直接支持：请求不能写成已完成，单段引用不能捎带别段人物/动作，作者梗概或后集揭示不能提前变成角色知情。已有候选仍需逐项语义复核；坐标恢复不会自动改写或认可这些结论。

## 5. 恢复、费用与状态门

恢复须同时证明：原 run 已停止且仍为当前待处理记录；保存的 canonical/sourceVersion 与当前完全一致；每次调用有唯一完整响应及一致的已知输入/输出/总 Token；回包编号完整；扁平引用的项目、run、编号、ID、hash 与原记录一致；所有证据仍通过当前原文覆盖和引用校验。

未知用量不填 0，不根据模型正文自报 usage 解除费用门。已知用量也不代表货币费用已结清或内容已合格：缺失、不完整、重复回包、含糊引用、外来分片、引用篡改、来源变化均在发送前拒绝恢复，不能跳过失败部分再买一次。若完整有效的综合回包已经保存、仅本地保存卡片失败，可零新调用复用；若综合内容本身不合格，仍阻断而非循环重放或自动重买。

上述零新调用复用还须证明综合实际消费了同版证据。程序从综合所属 run 的冻结 refs 与本次证据 outputs 重建消费身份，连同 `reviewId/reviewHash` 比对；后来登记的新审查不得混接旧综合。用于解析的 refs 先深拷贝，不能因内存别名修改历史 manifest 来掩盖版本差异。不一致时停止，不自动重买综合。

`pending` 仅表示当前指针持有的 `RUNNING`；`FAILED` 不显示运行中。`held` 与 `resumable/recoveryIssue` 分开表达“仍待处理”及“能否复用”。网页提供明确的继续已保存进度入口与费用确认；工作流在原授权/共享预算下选择 resume，而非清空旧进度整套重跑。GET 只核验和展示，不调用模型、不采用候选。

工作流将已知用量但接收失败的 DIRECTION 记为 `PARTIAL`，不是 `SUCCEEDED`。中断动作仅在绑定同一 `directionGenerationId`、方向已停止且已知、共享账本无未知/在途时可回收为 PARTIAL；不因保留 activeAction 永久假报执行中，也不把 UNKNOWN 当成功清掉。

源版本、登录身份、权限、CAS 与不可变历史约束保留。每次新付费调用前重查源、当前执行指针与权限；源变更、人工结束等待或撤权后停止后续请求。迟到完整候选只可留历史，不能覆盖并发手工稿或已采用卡。恢复产物仍为未确认 DRAFT，人工覆盖确认和正式采用流程不被 PROGRAM 或付费回执替代。

## 6. 显式免费源定审查：保留 raw，不放宽逐字校验

恢复后的剩余证据批已返回，但抄引文和 unitId 错误仍被严格拒收。这类问题与坐标偏移不同，不能用模糊匹配、自动猜测或模型自审绕过。新增 `validateSeriesDirectionEvidenceReview(original, corrected, units, purpose)` 仅验证明确提交的接收修正：

- 原始错误包不必先通过 `readEvidence`，但对象/数组形状和条目数量必须保留；修正版必须整包通过原严格读取器。
- `coverage/summary` 及未知字段原样保留；仅允许 evidence 的 `quote/signal`，以及 knowledge 的 `unitId/claim/statement/subjects/quote/start` 改动。不增删条目，不改 `kind` 或 evidence 的 unitId。
- 程序按原索引生成 `changes`，每项含 path、before/after 的 presence 和值；purpose 必须显式提供。SOURCE 可改为 CHARACTER_CLAIM，显式 CHARACTER_CLAIM 不可升为 SOURCE。结构通过不代表 statement 语义正确，也不返回任何自动 approve 标志。
- 服务另核对管理员/审查人权限、当前 held FAILED、同源版本、CAS、原响应 hash、完整原回包及已知用量，以及目标确属当前恢复链。授权与 raw/outputHash/sourceVersion 绑定不交给模型或纯函数猜测。

服务只新增 `SERIES_DIRECTION_OUTPUT_REVIEW` / `SERIES_DIRECTION_EVIDENCE_REVIEW_V1` 快照并推进 pointer.sequence；保存独立修正版、程序差量、目的、主体、时间和坐标回执，明确 `directionConfirmed=false`。原始输入/输出、run、草稿和采用卡不被改写。恢复第一次选择审查后，在新的扁平 refs 冻结 `reviewId/reviewHash`；后续不能静默热换，也不能把新审查套在已消费旧证据的综合上。

本 campaign 的三份审查由主线程通过专用 preview/apply 脚本执行：硬绑定隔离库/项目/预算，检查无 driver、未知和在途；每次 apply 先做 SQLite 备份及独立审计。落盘后逐项验证旧 runs、正文、snapshots、请求/响应/账本文件保全；旧指针仅 sequence 增一。不调用 provider，不等于用户采用全剧方向。

## 7. 验证证据与未完成事项

主线程在当前修复检查点实际执行并通过下列免费验证；本说明已对照日志摘要。证据目录：`runtime-3008/three-stage-comparison/shenj-2026-10-01T11-15-12-535Z-2AZMuz/verification-v3.aPG3OK/`。

| 范围 | 结果与日志 |
| --- | --- |
| 来源装箱＋证据定位＋显式审查 | 26/26；含实际保存 61 units 只读重放及新审查 8 项红→绿，`direction-pure-review-final.log`；此前 18 项检查点另留 `direction-pure-final.log` |
| 原服务回归 | 权限、CAS、源变更、长文完整、并发/迟到保护、用量、CSRF 全过，`direction-service-with-reviews-final.log` |
| 恢复与审查反例 | 多跳扁平引用、保存失败后有效综合 0 新调用、显式复核 raw 保全、晚到 review 不得混用旧综合；未知用量、来源变化、含糊引文、缺失/重复输出、外来分片、篡改/重复 ref 均 0 dispatch，`direction-review-late-synthesis-final.log`；该混版反例的旧实现红灯另存同名前缀 `-red.log` |
| 页面 | 真实组件 SSR＋5 个拦截式浏览器场景：late-read、late-post、history、preserve、resume，`direction-ui.log` |
| 工作流 | 17/17，含已知失败 PARTIAL 回收与未知停发，`direction-workflow-recovery-green.log`；真实适配层搭配合成服务，`direction-workflow-adapter-final.log` |
| 类型检查 | 主线程报告最终命令 exit 0、无诊断，`direction-review-typecheck-final.log`；新纯审查模块另做独立 strict 检查通过 |

服务/恢复测试使用可清理的合成临时 SQLite，并非“零数据库写入”；不写 campaign 或日常库。服务专项屏蔽 Prisma 项目环境文件读取，默认 provider 与网络硬拒绝，执行后清理临时库并恢复环境。浏览器请求拦截、合成 runner 与只读重放不等同真实模型产出或业务/艺术验收。

三份真实审查还经过独立只读核对原 raw 和冻结批次：分别为 6 evidence/1 knowledge、6/4、19/17，程序记录 2、10、42 项字段差量，原 raw SHA 保全。已知抄引和跨集错挂由显式源定修正处理，不改旧模型回包来伪造原始成功。

综合前检查点：主线程已确认的同 campaign 记账基线为 **8 次调用、398,102 个已知 Token**（上一检查点 7 次/365,083；新增证据回包 33,019）。三份免费审查已 apply、备份及保全检查通过；随后仅一次真实 synthesis 执行中。此历史检查点保留，不回写成当时已完成。

2026-10-02 最新检查点（主线程报告）：最后一次 synthesis 已完成，同 campaign 累计 **9 次调用、417,748 个已知 Token，0 未知、0 在途**；状态为 `WAIT_DIRECTION_CONFIRM`。第三阶段两侧 EP1/EP2 均未开始。主线程继续审查实际方向卡与最后发送请求；本说明不把生成成功等同方向确认、语义验收、资产设计完成或第三阶段成片通过，也未提交、推送、启动或重启服务。

实现入口：`lib/series-direction-source.ts`、`lib/series-direction-evidence.ts`、`lib/series-direction-evidence-review.ts`、`lib/series-direction-service.ts`，以及方向 API/面板、`lib/production-workflow.ts` 和 `runtime/production-workflow.mjs`；对应专项为 `scripts/verify-series-direction-{source,evidence,evidence-review,service,recovery,ui}.ts(x)` 与方向浏览器/工作流验证。旧文件不覆盖，后续真实结果另行追加。
