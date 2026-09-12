/** Pure Q1 review projections. Author text and consumer packets are never rewritten. */
import type { PipelineRun } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import {
  assembleSelections, assertSourceVersion, collectF2DataIssues, isRecord, mergeF1Outputs, requireF1Output,
  type F1Output, type F2Output, type FoundationIssue, type SourceIndex, type SourceRef
} from "@/lib/project-foundation-contracts";
import type { EpisodeFoundationDraft, FoundationCandidate } from "@/lib/foundation-state";

export type F1AuthorChunk = { scope: number[]; overview: string; sourceChars: number; oversized: boolean };
type BoundArgs = { projectId: string; index: SourceIndex; candidate: FoundationCandidate<F1Output>; run: Pick<PipelineRun, "id" | "projectId" | "stageCode" | "status" | "log" | "inputSummary"> };
type SupplyArgs = { index: SourceIndex; scope: number[]; f1: FoundationCandidate<F1Output>; f2: FoundationCandidate<F2Output>; authorChunks: F1AuthorChunk[]; packets: EpisodeFoundationDraft[] };
type ReferenceSource = SourceRef & { sourceVersion: string; content: string; usedBy: string[] };
type IssueOrigin = "F1.authorIssues" | "F2.authorIssues" | "F1.mechanicalIssues" | "F2.mechanicalIssues";
type UnscopedIssue = FoundationIssue & { origin: IssueOrigin; scopeReason: "NO_SOURCE_REFS" };

function fail(message: string): never { throw new Error(`Q1资料装配失败：${message}`); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label}须为完整对象。`);
  return value;
}
function jsonRecord(value: string | null, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value ?? ""); } catch { fail(`${label}不是完整JSON证据。`); }
  return record(parsed, label);
}
function readScope(index: SourceIndex, value: unknown, label: string): number[] {
  if (!Array.isArray(value) || !value.length || value.some((number) => !Number.isSafeInteger(number)
    || !index.episodes.some((episode) => episode.number === number)) || new Set(value).size !== value.length) {
    fail(`${label}须为当前源版本内非空、不重复的集号范围。`);
  }
  return [...value] as number[];
}
function sameCoverage(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && left.every((number) => right.includes(number));
}
function sourceChars(index: SourceIndex, scope: readonly number[]): number {
  return index.episodes.filter((episode) => scope.includes(episode.number)).reduce((sum, episode) => sum + episode.content.length, 0);
}

export function requireBoundF1AuthorChunks({ projectId, index, candidate, run }: BoundArgs): F1AuthorChunk[] {
  assertSourceVersion(index, index.version);
  const fullScope = index.episodes.map((episode) => episode.number);
  if (run.projectId !== projectId || run.id !== candidate.runId || run.stageCode !== "F1" || run.status !== "SUCCEEDED"
    || candidate.schema !== "FOUNDATION_CANDIDATE_V1" || candidate.stageCode !== "F1") fail("F1原作者记录与项目、候选run或成功状态不匹配。");
  if (!sameCoverage(readScope(index, candidate.scope, "F1候选覆盖"), fullScope)) fail("F1作者候选没有完整覆盖当前源文。");
  const summary = jsonRecord(run.inputSummary, "F1执行输入摘要");
  const log = jsonRecord(run.log, "F1原作者执行日志");
  if (log.schema !== "FOUNDATION_RUN_EVIDENCE_V1" || log.runId !== run.id || log.stageCode !== "F1"
    || log.batchToken !== candidate.batchToken || summary.batchToken !== candidate.batchToken) fail("F1原作者日志不能绑定当前候选及执行批次。");
  if (candidate.sourceVersion !== index.version || log.sourceVersion !== candidate.sourceVersion || summary.sourceVersion !== candidate.sourceVersion
    || log.inputVersion !== candidate.inputVersion || summary.inputVersion !== candidate.inputVersion) fail("F1原作者源版本或共同输入版本不匹配。");
  if (!Array.isArray(log.calls) || !log.calls.length) fail("F1缺少原作者成功分片，不能猜测拆开overview。");
  const outputs: F1Output[] = [];
  const chunks = log.calls.map((value, position): F1AuthorChunk => {
    const call = record(value, `F1原作者分片${position + 1}`);
    if (call.sequence !== position + 1 || call.status !== "SUCCEEDED" || call.sourceVersion !== candidate.sourceVersion
      || call.inputVersion !== candidate.inputVersion) fail(`F1原作者分片${position + 1}顺序、成功状态或版本不匹配。`);
    const scope = readScope(index, call.scope, `F1原作者分片${position + 1}`);
    const chars = sourceChars(index, scope);
    if (call.sourceChars !== chars || typeof call.oversized !== "boolean") fail(`F1原作者分片${position + 1}原文长度或oversized记录不完整。`);
    const response = record(call.response, `F1原作者分片${position + 1}响应`);
    const output = requireF1Output(response.data, index, scope);
    outputs.push(output);
    return { scope, overview: output.overview, sourceChars: chars, oversized: call.oversized };
  });
  const merged = mergeF1Outputs(outputs, index, fullScope);
  if (!isDeepStrictEqual(merged, candidate.output)) fail("F1原作者分片合并结果与绑定候选不一致，不能替换或漏审overview。");
  return chunks;
}

function referenceCollector(index: SourceIndex, scope: Set<number>) {
  const refs = new Map<string, SourceRef & { usedBy: Set<string> }>();
  const sources = new Map(index.episodes.map((episode) => [episode.number, episode]));
  function validate(ref: SourceRef) {
    const source = sources.get(ref.episode);
    if (!Number.isSafeInteger(ref.episode) || !source || !Number.isSafeInteger(ref.startLine) || !Number.isSafeInteger(ref.endLine)
      || ref.startLine < 1 || ref.endLine < ref.startLine || ref.endLine > source.lineCount) fail("选中资料的来源引用无效或越界，不能伪造原文摘录。");
  }
  function add(ref: SourceRef, usedBy: string) {
    validate(ref);
    if (scope.has(ref.episode)) return;
    const key = `${ref.episode}:${ref.startLine}:${ref.endLine}`;
    const existing = refs.get(key);
    if (existing) existing.usedBy.add(usedBy);
    else refs.set(key, { episode: ref.episode, startLine: ref.startLine, endLine: ref.endLine, usedBy: new Set([usedBy]) });
  }
  function collect(): ReferenceSource[] {
    const merged: Array<SourceRef & { usedBy: Set<string> }> = [];
    const ordered = [...refs.values()].sort((a, b) => a.episode - b.episode || a.startLine - b.startLine || a.endLine - b.endLine);
    for (const ref of ordered) {
      const prior = merged.at(-1);
      if (prior?.episode === ref.episode && ref.startLine <= prior.endLine + 1) {
        prior.endLine = Math.max(prior.endLine, ref.endLine);
        ref.usedBy.forEach((use) => prior.usedBy.add(use));
      } else merged.push({ ...ref, usedBy: new Set(ref.usedBy) });
    }
    const excerpts = assembleSelections(index, merged.map((ref) => ({ episode: ref.episode, startLine: ref.startLine, endLine: ref.endLine, purpose: [...ref.usedBy].join("；") })), index.version);
    return excerpts.map(({ episode, startLine, endLine, sourceVersion, content }, position) => ({ episode, startLine, endLine, sourceVersion, content, usedBy: [...merged[position].usedBy] }));
  }
  return { validate, add, collect };
}

export function buildQ1ScopedSupply({ index, scope: requestedScope, f1, f2, authorChunks, packets }: SupplyArgs) {
  assertSourceVersion(index, index.version);
  const scope = readScope(index, requestedScope, "Q1本批覆盖");
  const scopeSet = new Set(scope);
  const fullScope = index.episodes.map((episode) => episode.number);
  if (f1.stageCode !== "F1" || f2.stageCode !== "F2" || f2.upstreamSnapshotIds.f1 !== f1.id) fail("Q1的F1/F2候选上游绑定不一致。");
  if (f1.sourceVersion !== index.version || f2.sourceVersion !== index.version || f1.inputVersion !== f2.inputVersion) fail("Q1候选源版本或共同输入版本不一致。");
  for (const candidate of [f1, f2]) {
    if (!sameCoverage(candidate.scope, fullScope) || !sameCoverage(candidate.output.coverage, fullScope)
      || !sameCoverage(candidate.output.episodes.map((episode) => episode.number), fullScope)) fail("Q1候选没有完整且唯一的源文覆盖。");
  }
  const authoredScopes = authorChunks.map((chunk) => readScope(index, chunk.scope, "F1原作者概述分片"));
  if (!sameCoverage(authoredScopes.flat(), fullScope) || authorChunks.some((chunk) => typeof chunk.overview !== "string" || !chunk.overview.trim()
    || chunk.sourceChars !== sourceChars(index, chunk.scope) || typeof chunk.oversized !== "boolean")
    || authorChunks.map((chunk) => chunk.overview).join("\n\n") !== f1.output.overview) fail("F1原作者overview分片与完整候选不一致或覆盖不完整。");
  const selectedChunks = authorChunks.filter((chunk) => {
    const selected = chunk.scope.some((episode) => scopeSet.has(episode));
    if (selected && chunk.scope.some((episode) => !scopeSet.has(episode))) fail("Q1范围只覆盖原作者概述分片的一部分；禁止随意截取或省略overview。");
    return selected;
  });
  const reference = referenceCollector(index, scopeSet);
  const unscopedIssues: UnscopedIssue[] = [];
  function selectIssues(issues: FoundationIssue[], origin: IssueOrigin): FoundationIssue[] {
    return issues.filter((issue, position) => {
      if (!Array.isArray(issue.sourceRefs)) fail(`${origin}缺少来源数组。`);
      issue.sourceRefs.forEach(reference.validate);
      if (!issue.sourceRefs.length) { unscopedIssues.push({ ...issue, origin, scopeReason: "NO_SOURCE_REFS" }); return false; }
      const selected = issue.sourceRefs.some((ref) => scopeSet.has(ref.episode));
      if (selected) issue.sourceRefs.forEach((ref) => reference.add(ref, `核对${origin}[${position}]：${issue.coordinate}`));
      return selected;
    });
  }
  const f1Issues = selectIssues(f1.output.issues, "F1.authorIssues");
  const f2Issues = selectIssues(f2.output.issues, "F2.authorIssues");
  const mechanicalIssues = [...selectIssues(f1.mechanicalIssues, "F1.mechanicalIssues"), ...selectIssues(f2.mechanicalIssues, "F2.mechanicalIssues")];
  const f1Episodes = f1.output.episodes.filter((episode) => scopeSet.has(episode.number));
  const f2Episodes = f2.output.episodes.filter((episode) => scopeSet.has(episode.number));
  const keys = new Set(f2Episodes.flatMap((episode) => episode.assetKeys));
  const referencedKeys = new Set(f2.output.episodes.flatMap((episode) => episode.assetKeys));
  const allKeys = new Set(f2.output.assets.map((asset) => asset.key));
  if (allKeys.size !== f2.output.assets.length || [...keys].some((key) => !allKeys.has(key))) fail("Q1本批身份key缺失或重复，不能静默删掉候选。");
  const assets = f2.output.assets.filter((asset) => keys.has(asset.key) || asset.appearances.some((appearance) => scopeSet.has(appearance.episode))
    || (!referencedKeys.has(asset.key) && !asset.appearances.length && asset.sourceRefs.some((ref) => scopeSet.has(ref.episode))))
    .map((asset) => ({ ...asset, appearances: asset.appearances.filter((appearance) => scopeSet.has(appearance.episode)) }));
  const episodePackets = packets.filter((packet) => scopeSet.has(packet.episode));
  if (!sameCoverage(episodePackets.map((packet) => packet.episode), scope)) fail("本批实际消费者资料包缺失或重复，覆盖不完整。");
  for (const packet of episodePackets) {
    const source = index.episodes.find((episode) => episode.number === packet.episode)!;
    if (packet.schema !== "EPISODE_FOUNDATION_V1" || packet.sourceVersion !== index.version || packet.inputVersion !== f1.inputVersion
      || packet.f1SnapshotId !== f1.id || packet.f2SnapshotId !== f2.id) fail("实际资料包与本批F1/F2候选或版本绑定不一致。");
    if (packet.source.sourceVersion !== index.version || packet.source.number !== packet.episode || packet.source.content !== source.content) fail("实际资料包的本集原文与当前源版本不一致。");
  }
  for (const episode of f1Episodes) for (const selection of episode.sourceSelections) reference.add(selection, `核对candidates.f1.output.episodes[${episode.number}].sourceSelections：${selection.purpose}`);
  for (const asset of assets) {
    const coordinate = `candidates.f2.output.assets[${asset.key}]`;
    asset.sourceRefs.forEach((ref) => reference.add(ref, `核对${coordinate}.sourceRefs后台身份依据`));
    asset.descriptionVariants?.forEach((variant, position) => variant.sourceRefs.forEach((ref) => reference.add(ref, `核对${coordinate}.descriptionVariants[${position}]的原描述`)));
    asset.appearances.forEach((appearance, position) => appearance.sourceRefs.forEach((ref) => reference.add(ref, `核对${coordinate}.appearances[${position}]的当集状态`)));
  }
  for (const episode of f2Episodes) for (const background of episode.backgroundRefs ?? []) {
    background.sourceRefs.forEach((ref) => reference.add(ref, `核对candidates.f2.output.episodes[${episode.number}].backgroundRefs[${background.key}]：${background.purpose}`));
  }
  for (const packet of episodePackets) {
    packet.sourceSelections.forEach((selection) => reference.add(selection, `核对episodePackets[${packet.episode}].sourceSelections：${selection.purpose}`));
    packet.backgroundRefs?.forEach((background) => background.sourceRefs.forEach((ref) => reference.add(ref, `核对episodePackets[${packet.episode}].backgroundRefs[${background.key}]：${background.purpose}`)));
    packet.identities.forEach((identity) => identity.appearances.forEach((appearance) => appearance.sourceRefs.forEach((ref) => reference.add(ref, `核对episodePackets[${packet.episode}].identities[${identity.key}]的当集状态`))));
  }
  const f1Output: F1Output = { ...f1.output, coverage: scope, overview: selectedChunks.map((chunk) => chunk.overview).join("\n\n"), episodes: f1Episodes, issues: f1Issues };
  const f2Output: F2Output = { ...f2.output, coverage: scope, assets, episodes: f2Episodes, issues: f2Issues };
  const dataIssues = collectF2DataIssues(f2Output);
  f2Output.dataIssues = dataIssues;
  return structuredClone({
    candidates: { f1: { snapshotId: f1.id, projection: "SCOPE_PROJECTION" as const, output: f1Output }, f2: { snapshotId: f2.id, projection: "SCOPE_PROJECTION" as const, output: f2Output } },
    episodePackets, mechanicalIssues, dataIssues, authorIssues: [...f1Issues, ...f2Issues], referenceSource: reference.collect(), unscopedIssues,
    reviewScopeNote: [
      "只审scope所列完整集及绑定候选的范围投影；referenceSource仅为核对所选资料、身份或问题而补的逐字原文摘录，不代表完整阅读其所在集，不扩大coverage，也不加入消费者episodePackets。unscopedIssues为原样保留的无来源锚点问题，尚未定位，不能当成本批原文已经核实的错误；须另行定位处理，不自动升级严重度或强制本批BLOCKER。",
      "全剧未使用的有源后台定义按sourceRefs归入对应scope审查，必要跨范围原文在referenceSource；它们不是当集出场，也不加入消费者episodePackets。",
      "sourceName是作者提交的当集使用工作标签或原称谓候选，原值与sourceRefs保留待审；sourceNameMatch由程序按普通状态的本集原文或BACKGROUND的显式原文摘录计算，只是字面匹配提示。LITERAL只表示限定原文中出现该字符串，不等于身份、共指或知情时点已证实，仍须审核。NON_LITERAL可为缩写、归纳或工作标签，不能仅据此判REPAIR、删除标签或升级严重度，不得把词面提示本身当作机械错误或dataIssues。",
      "nameBasis只说明包内显示名来源：SOURCE_WORDING为源词、WORKING_LABEL为作者工作标签、REGISTERED_IDENTITY为后台登记名，均不认证身份或当集可揭示性。须结合原标签、sourceRefs、编号原文及referenceSource，核对有据归纳、未来名、错绑定、state中的无源职务或身份断言、纯声源被误作实体道具等真实实质影响；发现实质错误照常提出有来源的问题及返修归属，不偷换原name/key/type或删除标签来假装问题已经消失。",
      "issues省略、null或[]只表示未申报，不等于作者已经自检完毕或不存在问题；Q1仍须按职责独立审核，不能仅据空清单放行，也不能只据词面标记判错。"
    ].join("\n")
  });
}
