# 3008 上游证据交接补充 · 2026-10-01

范围：机械取源、事实候选和资产用途投影。保留当前工作树；没有提交、推送、真实模型调用或生产库写入。这里的通过仅指离线程序与隔离数据库证据，不是语义模型、图片、视频或用户验收。

## 1. 边界包与旧读取兼容

新增 `lib/episode-boundary-seed.ts`，公开 `buildEpisodeBoundarySeed`、`EpisodeBoundarySeed`、`BoundarySourceEvidence`。`buildLightEpisodePackets` 每集附带 `packet.episodeBoundary`，不增加模型调用。

接口示意（字段值需来自当前原文，下面不是剧情事实）：

```ts
{
  schema: 'EPISODE_BOUNDARY_SEED_V1',
  sourceVersion: string, fromEpisode: number | null, toEpisode: number,
  adjacentEpisode: boolean | null,
  previousSource: BoundarySourceEvidence | null,
  currentOpening: BoundarySourceEvidence,
  evidence: [{ role: 'PREVIOUS_SOURCE' | 'CURRENT_OPENING', episode: number,
    start: number, end: number, startLine: number | null,
    endLine: number | null, nodeIds: string[] }],
  story: { timeLayer: string, realityDomain: 'UNKNOWN' },
  unknowns: string[], policy: string
}
```

`BoundarySourceEvidence` 保留 `episode / sceneKey / sourceRange / startLine / endLine / text / nodes / diagnostics`；源范围为集内 UTF-16、左闭右开。`nodes` 含标准节点 ID、类别、全部 sourceUnitIds、完整范围和行号，跨行对白不拆断。`text` 是该范围原文逐字切片。

取源顺序：已保存且边界合法的首/末场 → 标准结构的首/末场 → 完整开头/尾部节点或标明 `WHOLE_EPISODE_FALLBACK` 的整集。无场号不补场号，不将整集标为末场。`selectionKind` 区分 `SAVED_SCENE / STANDARD_SCENE / TAIL_NODES / OPENING_NODES / WHOLE_EPISODE_FALLBACK / EMPTY_SOURCE`。

2400 字符仅是软预算：可移走完整节点，但不截单行/跨行对白，也不能只留标题或末尾导演备注、丢掉首/末正文节点。单个完整节点超限时保留全文且 `budgetExceeded=true`；`clipped` 只表示整段前后确有省略。省略区域可用版本与原始坐标补读。

`adjacentEpisode` 只说集号相邻，不断言故事直连。`story.timeLayer` 只复制开场正文前、明确场界内且唯一的“时间层：”结构声明；较后声明不能倒推开场。其余为 `UNKNOWN`。当前没有可靠现实域结构协议，因此 `realityDomain` 为 `UNKNOWN`，不凭梦、回忆、醒来等关键词断言。不产出 `initialStates`。

旧 `boundaryContext` 继续存在并得到完整证据文本。其 `previousSource.sceneKey` 仍只代表已保存场次；缺失/旧定位损坏时维持 null，旧 reader 因此保留 PARTIAL。新 seed 可同时保留标准原文恢复出的真实场号，不把成功取源冒充数据库定位已修复。`priorStates` 保持原有稳定身份/两端场次约束，未增加状态继承。

## 2. 历史候选而非当前真值

`packet.facts.historicalStates` 保留兼容；新增 `historicalEvidenceCandidates`：

```ts
{
  ...originalFact,
  candidateUse: 'HISTORICAL_EVIDENCE_ONLY',
  currentApplicability: 'UNKNOWN',
  retrieval: { mode: 'SUBJECT_MENTION' | 'SOURCE_NEIGHBOUR', anchorFactIds: string[] }
}
```

检索包含相关主体的所有原句，而不只限 STATE；因此可携带身份、关系、知情、台词主张和解除反证。额外保留同集前后各一条原句作为邻句候选；距离不证明代词归属或连续状态，也不声称已穷尽远距离反证。未命中的内容仍在原始事实库/原文，不删除。

每条历史候选必须能用 episode/start/end 逐字还原；不匹配的记录不供给，并记入 `historicalEvidenceRejected`。保留候选自身、evidence 和事实包根部的未知元数据。

角色台词始终 `CHARACTER_CLAIM`，不因“必须、不能、永远”等词转成 SOURCE/GLOBAL。只有明确“规则：/世界规则：/世界观设定：”来源标签属于全局声明；普通关键词不建立全局规则。`kind` 的旧检索分类不是本集状态裁决；当前适用性依然 UNKNOWN。

## 3. 未定位材料不再等于全剧出场

`projectProductionCatalog` 的 `assets` 和嵌套 `variants` 只包含实际集号匹配项。空 `usageEpisodes / episodes` 的定义另放 `materialCandidates`，同字段随 packet 传递：

```ts
{
  ...completeOriginalDefinition,
  key: string, baseKey: string, baseName?: string,
  name: string, type: string, kind: 'BASE' | 'VARIANT', episodes: [],
  use: 'CANDIDATE_ONLY', reason: 'UNLOCATED_USAGE', preparation?: Preparation
}
```

候选保留定义、未知字段、备注、来源和 fromKey。已有 DERIVE 递归照常建立 `materialDependencies`，用途仍为 `MATERIAL_SOURCE_ONLY`。同一未定位定义可兼具候选与派生依赖证据，但不进入本集 assets/scene.assetKeys；下游应按 key 合并用途而非改成出场。

## 4. 回归证据

使用 `runtime-3008/node/bin/node`（Node 24）和已有 tsx。初始六项核心反例均先失败，再最小修复通过：缺末场空文本、长单行硬截、无场号空文本、台词升级规则、缺历史候选、未定位出场污染。补边界又先捕获预算丢正文、未知根元数据丢失、较后时间声明冒充开场三个故障。

`scripts/verify-upstream-evidence.ts` 当前 11 项通过，包括 CRLF、多行对白、超限节点、版本/坐标、显式未知、候选源校验和元数据保留。

受影响旧验证通过：`verify-five-step-facts-fragments`、`verify-foundation-dependency-selector`、`verify-stage1-reception`、`verify-foundation-model-input`、`verify-foundation-production-contracts`、`verify-foundation-continuity-supply`、`verify-foundation-asset-classification`、`verify-light-foundation-contracts`、`verify-foundation-asset-catalog`、`verify-light-handoff`、`verify-scoped-choice-handoff`、`verify-foundation-catalog-repair`、`verify-post-colon-cues`、`verify-foundation-production-v3`、`verify-facts-format-headings`。

其中数据库用例自身建立临时目录/独立 SQLite，随后清理；交接读取验证还比较运行记录、资产和快照计数，未产生模型调用。旧硬截与未定位变体出场断言已改为新语义；后置括号测试仅补新纯函数依赖。

项目级 typecheck 由根代理在各工人改动收敛后统一报告；本交接不把其他并行文件的中间错误写成最终结论。未运行真实模型、浏览器成品或生产构建。
