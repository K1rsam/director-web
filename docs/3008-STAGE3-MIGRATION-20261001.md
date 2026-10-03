# 3008 Stage 3 内核迁移交接（2026-10-01）

## 范围与证据边界

- 来源：`../director-web-stage1-20260909`，固定 Git HEAD `daad694d2027ad1aa4821ae4ab309d53fb1dbd0d`。该目录只读；迁移后再次确认 HEAD 相同、`runtime/storyboard-v4` 无修改。
- 目标：`runtime/storyboard-v4/**`；未提交、未推送、未调用真实模型、未读写生产任务数据。测试只使用临时目录和合成素材。
- 3008 原工作区备份：`local-backups/three-stage-20261001.Hcua8V/source-before.tgz`。既有标准源协议、上游投影、独立源、旧请求指纹与安全重校边界保留。
- 本报告记载迁移和适配；不是专业成片质量、真实模型可用性、费用或用户验收证明。
- `core/core.mjs`、`core/pipeline.mjs`、`coordinator.mjs` 迁移后已交回总任务，后续独立跨集/材料/预算改动由总任务负责；`acceptedContinuity` 保持集内语义。

## 迁入能力

| 能力 | 迁入与适配结果 |
| --- | --- |
| 调度 | 单集源顺序串行、同集一条派单、共享上限4路；先落库采用再构造后包请求；保留3008实时排队/执行投影。 |
| 长事件 | 源版完整事件策略、安全执行分批、原粗单元/对白所有权、跨批接续、整包合成、已付回包恢复均迁入。 |
| 短包 | 相邻短尾包同次调用，但不合并语义工作包、事件或情绪契约；外部依赖与内部接续保留。 |
| 整编 | 全剧整编delta；完整保留单元/替换组/幻想分区与base hash校验。 |
| 创作契约 | `unitDirection`、完整视觉基座、六栏导出；摄影/表演/幻想等最新知识与校验逐字同步。 |
| 幻想开关 | 源版off/all语义、源文已存在幻想表达的方法加载与可选幻想选择分离。 |
| 模型与时限 | 默认`gpt-6.1-sol`/`medium`；新版按负荷计算startup/idle/total时限、terminal事件与已付原始正文回收。 |
| 3008差异 | 标准包原文与坐标、guidance不可自证入口事实、production-context-v2与retrieval-facts-v1投影、UTF-8诊断与旧显式时限配置保留。 |

Mac CLI定位、`.storyboard-stage3-v2`/旧记录只读、服务层模型与共享预算包装在总任务的`lib/storyboard-service.ts`处理，本迁移未改动这些lib实现。

## 上游新资料适配

`input.mjs`接受上游显式`assetProductionCards`和`seriesKnowledge`，并覆盖plan/author/finish/delta四种请求的投递回归：

- 未采用设计仍传本集原文事实；`adoptedDesign`与来源事实分开。
- `MATERIAL_SOURCE_ONLY`只允许materialDependencies身份，不成为实际出场资产。
- 保留`SOURCE`/`CHARACTER_CLAIM`；本集原句坐标核验，不自动填入entryFacts。
- 当前事件只有引用位置之后成立；历史依据不成为永久状态。
- 图片只投参考说明，不投文件路径、不声称读取像素；缺图不阻断文字。
- 旧packet未提供新数组时不平白增加空字段，保持旧版本/hash兼容。

## 安全边界

- 严格保留3008“只有当前未解决待修候选可重校”规则；已经采用、已解决、源或情绪改变的普通候选直接拒绝，文档不变。
- 源版当前批次的等价重校特例保留；退休批次不可重新替换当前代。
- 旧TIMEOUT无pid回执仍须精确请求目录的进程盘点；新回执带execution却缺退出证据时失败关闭。
- live/queued/reserved工作、未来/倒置退出时间、保存正文、epoch变化阻止错误确认。
- `ABORTED`、`TIMEOUT`、`CLI_FAILED`分型；未知费用保持null。确认仅解除指定记录风险，不自动重试。
- 源版“直接重校已采用稿”的几个合成测试改为明确待修fixture后验证免费派生与请求身份；未为过测试放宽生产校验。

## 验证

使用`runtime-3008/node/bin/node`（Node 24），不使用模型：

1. 迁移前3008原有核心回归：360/360通过。
2. 新上游卡/时点适配：先3项预期失败，再15/15通过；旧固定hash未改。
3. 旧fact/production投影兼容：17/17通过，预存固定期望hash不变。
4. 新版接续/分批/短包/失败恢复适配专项：118/118通过。
5. 整套`runtime/storyboard-v4/*.test.mjs runtime/storyboard-v4/core/*.test.mjs`：678/678通过，0失败/取消/跳过。日志：`/tmp/stage3-full-final-20261001.log`。

第5项是在总任务继续整合production-workflow期间的文件快照，不替代最终整合验收。服务测试只对新的外部账本/归档依赖作内存隔离，保留原source/stale/直接POST安全断言；一次真实可空handoff兼容缺陷由总任务修复后通过。

## 来源一致性校验

`core/skills/**`与`core/references/**`共21文件逐字一致。按排序相对路径、NUL、文件正文、NUL串联的SHA-256均为：

`3b3d11e75a0e1e128904d11b6b010c9322fb1b7272d9f1915f41e380a964e213`

下列源版生产模块与3008逐字相同（SHA-256）：

| 文件（相对runtime/storyboard-v4） | SHA-256 |
| --- | --- |
| core/accepted-continuity.mjs | 49eb1aebcf480c59bb213db4c3a944aad1d41ac876e2da74ec5216a5646bf589 |
| core/author-call-groups.mjs | 11d351a0c7c1b422403f106e88b3c1715ba6d1f29488d1ac15f256f6722e328e |
| core/execution-batches.mjs | 325bf2ae35377cdc0c87a2e5c41666c9ab0bc1789be044153baee1bd3f2bb44d |
| core/event-unit-packing.mjs | cd9ccbce3eacf934c61ea7c7d8d565e76805df3018062d8c67271f2eafc75590 |
| core/output-schema.mjs | 1381275118d650e9f92b313ccabac1dbb4534f6856625e34c9afc32a0e10f93c |
| core/quality.mjs | a63b0e9fd1d37baba560b80ded001b660739cc57d7e32048e5195708ac5d8804 |
| core/selection.mjs | 26fcbf0b78b8d8707f581a766ee4f4e10c2ab87b3655481182442f301e3f0183 |
| core/visual-style.mjs | 6dbdc6841f5f44fb189da8319ebaaf0311a0b0f179312cd783720e773ec55b1b |
| core/lossless-input.mjs | 8db1789bfc147ebb98b3988f6d0c1f763ed8f7fb80bb81a571489b8486c5246a |
| core/references/common-contract.md | 70fe3df9ad40b0669ded084c5dde59893a4bf90daad451b1bca5641dfcca63be |

## 变化文件清单（相对runtime/storyboard-v4）

生产文件：

- `coordinator.mjs`, `input.mjs`
- `core/core.mjs`, `core/pipeline.mjs`, `core/runner.mjs`, `core/source.mjs`
- `core/accepted-continuity.mjs`, `core/author-call-groups.mjs`, `core/execution-batches.mjs`, `core/event-unit-packing.mjs`
- `core/lossless-input.mjs`, `core/output-schema.mjs`, `core/quality.mjs`, `core/schema-references.mjs`, `core/selection.mjs`, `core/visual-style.mjs`
- `core/references/common-contract.md`与cards下`danger-rescue.md`, `editing-integrity.md`, `expressive-emphasis.md`, `joy-acceptance.md`
- `core/skills/{acting-blocking-methods,camera-emotion-methods,episode-emotion-planner,episode-finishing-editor,fantasy-expression-methods,lighting-space-methods,sound-rhythm-methods,source-context-preparer,unit-performance-director}/SKILL.md`

测试与合成fixture：

- `author-call-group-coordinator.test.mjs`, `coordinator.test.mjs`, `current-rules-recovery.test.mjs`, `execution-batch-coordinator.test.mjs`, `failed-attempt-resume.test.mjs`, `input-upstream.test.mjs`, `input.test.mjs`, `service.test.mjs`, `stop-resume.test.mjs`
- core下：`accepted-continuity.test.mjs`, `author-call-group-test-fixtures.mjs`, `author-call-groups.test.mjs`, `core.test.mjs`, `event-unit-packing.test.mjs`, `execution-batch-test-fixtures.mjs`, `execution-batches.test.mjs`, `fact-projection.test.mjs`, `legacy-test-fixtures.mjs`, `lossless-input.test.mjs`, `output-schema.test.mjs`, `paid-response-recovery.test.mjs`, `pipeline.test.mjs`, `production-context-projection.test.mjs`, `runner-diagnostics.test.mjs`, `runner-error-diagnostics.test.mjs`, `runner-terminal.test.mjs`, `runner-timeouts.test.mjs`, `runtime.test.mjs`, `schema-projection.test.mjs`, `schema-references.test.mjs`, `seedance-export.test.mjs`, `source-expression-methods.test.mjs`, `source-formats.test.mjs`, `source-projection.test.mjs`, `source-selection.test.mjs`, `unit-direction-export.test.mjs`, `unit-direction-protocol.test.mjs`, `visual-style.test.mjs`。

既有`http.mjs`相对源版的超时提示差异保留，未作为迁移改写；其余既有3008-only模块保留。

## 总任务后续集成核对

模型注入接点为`createCoordinator({modelRunner})`：全局/同集槽位及同步`shouldDispatch`已通过后调用。包装应保留`runId/attemptId/directory/signal/shouldDispatch`，不在此另立账本。

只读审查已向总任务提交的跨集新层问题，不是上述迁移模块回归结论：硬来源basis遗漏seriesKnowledge/contextRows/entryFacts、guidance被生产反馈升级SOURCE、旧plan阻断需求无法消解、plan反馈需求schema的packageIds范围、隐式接续下游修复与无进展判定冲突、统一预算的已知用量恢复对账，以及实际尾态回执须绑定真正尾包。总任务已在修复，最终结果另行验证；本报告不预先宣称这些问题已完成。

总任务明确：本轮共享预算要求未知用量暂停新付费调用，因此run层“接受未知风险”不能解除共享预算停止线；这是批准边界，不应静默绕过。免费恢复得到已知用量时应追加对账证据，不覆写原始UNKNOWN。
