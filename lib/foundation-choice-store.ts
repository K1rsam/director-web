import { storedApplicationScope, uncoveredApplicationScope, readApplicationScope, readChoiceEvidence, scopeEpisodes, type ApplicationScope, type ChoiceEvidenceRef } from './foundation-application-scope';
/** Required human decisions share the existing confirmation table; provider evidence stays immutable. */
import { parsePresentationEpisodeNumbers, presentationDecisionKey, resolvePresentationContractScope, PRESENTATION_SCOPE_MODES } from "@/lib/presentation-contracts";
import { createHash } from "node:crypto";
import type { PresentationContract, Prisma, PrismaClient } from "@prisma/client";
import { buildSourceIndex, type FoundationStageCode } from "@/lib/project-foundation-contracts";
import { mergeHumanChoices, normalizeDecisionKey, type HumanChoice } from "@/lib/foundation-human-choices";

type Db = Prisma.TransactionClient;
const VERSION = "FOUNDATION_HUMAN_CHOICE_V1";
type Metadata = { applicationScope?: ApplicationScope; evidenceRefs?: ChoiceEvidenceRef[]; receivingUses?: string[]; schema: typeof VERSION; sourceVersion: string; decisionKey: string; episodes: number[]; sourceStages: FoundationStageCode[]; reason: string; recommended: string; recommendationReason: string };
export type FoundationChoiceView = { applicationScope?: ApplicationScope; evidenceRefs?: ChoiceEvidenceRef[]; receivingUses?: string[]; sourceVersion?: string; id: string; category: string; question: string; options: string[]; evidence: string | null; userAnswer: string | null; episodes: number[]; sourceStages: FoundationStageCode[]; reason: string | null; recommended: string | null; recommendationReason: string | null; revision: string; round: number; decidedAt: Date | null };
export type FoundationChoiceRegistry = { applicationScope?: ApplicationScope; options?: string[]; decisionKey: string; status: "PENDING" | "CONFIRMED"; question: string; episodes: number[]; answer?: string }[];
export class FoundationChoiceError extends Error {
  constructor(public readonly notice: "decision-changed" | "decision-running" | "decision-required" | "decision-invalid", message = "确认事项已更新，请刷新后重新确认。") { super(message); this.name = "FoundationChoiceError"; }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function metadata(row: PresentationContract): Metadata | null {
  try {
    const value = JSON.parse(row.note ?? "null");
    return value?.schema === VERSION && typeof value.sourceVersion === "string" && typeof value.decisionKey === "string"
      && Array.isArray(value.episodes) && Array.isArray(value.sourceStages) ? value as Metadata : null;
  } catch { return null; }
}
function options(row: PresentationContract): string[] {
  try { const value: unknown = JSON.parse(row.options); return Array.isArray(value) && value.every(item => typeof item === "string") ? value : []; }
  catch { return []; }
}
const keyOf = (row: PresentationContract) => metadata(row)?.decisionKey ?? presentationDecisionKey({ category: row.category, question: row.question, rule_key: row.ruleKey });
const revisionOf = (row: PresentationContract, sourceVersion: string) => digest({ row, sourceVersion });
/** The document task owns the project even between individual provider calls. */
export async function assertNoActiveFoundationDelivery(db: Db, projectId: string) {
  const row = await db.sceneSnapshot.findFirst({ where: { id: `foundation-delivery-${projectId}`, projectId } });
  let task: { schema?: string; status?: string } = {};
  try { task = JSON.parse(row?.content ?? '{}'); } catch { throw new FoundationChoiceError('decision-running', '资料任务状态暂时无法核实，未修改项目。'); }
  if (task?.schema === 'FOUNDATION_DELIVERY_TASK_V1' && ['QUEUED', 'RUNNING'].includes(task.status ?? '')) throw new FoundationChoiceError('decision-running', '资料任务正在整理，请等待完成或先停止。');
}
type SourceEpisode = { id: string; number: number };
export type FoundationChoiceScope = { decisionKey: string; ruleKey: string | null; episodes: number[]; scopeMode: string; scopeResolved: boolean; applicationScope: ApplicationScope };
/** Empty means global only when explicitly resolved; unknown legacy anchors never widen consent. */
export function foundationChoiceCondition(row: PresentationContract, sourceEpisodes: readonly SourceEpisode[] = []): FoundationChoiceScope {
  const anchor = sourceEpisodes.find(item => item.id === row.episodeId)?.number;
  const applicationScope = storedApplicationScope(row, anchor);
  return { decisionKey: keyOf(row), ruleKey: row.ruleKey, applicationScope, episodes: scopeEpisodes(applicationScope), scopeMode: applicationScope.kind === 'GLOBAL' ? 'ALL_EPISODES' : applicationScope.kind, scopeResolved: applicationScope.kind !== 'UNRESOLVED' };
}
export async function loadFoundationChoices(db: Db, projectId: string, sourceVersion: string, includeSuggestions = false): Promise<{ pending: FoundationChoiceView[]; confirmed: FoundationChoiceView[]; registry: FoundationChoiceRegistry }> {
  const rows = await db.presentationContract.findMany({ where: { projectId, status: { in: ["PENDING", "CONFIRMED", ...(includeSuggestions ? ['SUGGESTED'] : [])] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const episodes = await db.episode.findMany({ where: { projectId }, select: { id: true, number: true } });
  const visible = rows.filter(row => !metadata(row) || metadata(row)!.sourceVersion === sourceVersion);
  const view = (row: PresentationContract): FoundationChoiceView => {
    const meta = metadata(row), scope = foundationChoiceCondition(row, episodes);
    return { applicationScope: scope.applicationScope, evidenceRefs: meta?.evidenceRefs ?? [], receivingUses: meta?.receivingUses ?? [], sourceVersion: meta?.sourceVersion, id: row.id, category: row.category, question: row.question, options: options(row), evidence: row.evidence, userAnswer: row.userAnswer,
      episodes: scope.episodes, sourceStages: meta?.sourceStages ?? [], reason: scope.scopeResolved ? meta?.reason ?? null : "适用范围无法确认，当前答案未供给到任何集；请在范围编辑中明确指定适用集或全剧。",
      recommended: meta?.recommended ?? null, recommendationReason: meta?.recommendationReason ?? null, revision: revisionOf(row, sourceVersion), round: row.round, decidedAt: row.decidedAt };
  };
  return { pending: visible.filter(row => row.status === "PENDING" || row.status === 'SUGGESTED').map(view), confirmed: visible.filter(row => row.status === "CONFIRMED").map(view),
    registry: visible.filter(row => row.status !== "CONFIRMED" || foundationChoiceCondition(row, episodes).scopeResolved).map(row => ({ decisionKey: keyOf(row), status: row.status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING', question: row.question, episodes: view(row).episodes, applicationScope: view(row).applicationScope, options: options(row), ...(row.status === "CONFIRMED" ? { answer: row.userAnswer ?? "" } : {}) })) };
}
export async function assertNoFoundationChoices(db: Db, projectId: string, sourceVersion: string) {
  if ((await loadFoundationChoices(db, projectId, sourceVersion)).pending.length) throw new FoundationChoiceError("decision-required", "请先完成上方必要确认；当前资料和调用记录已保留。");
}
/** null means covered. An empty proposal is global; finite old consent never silently becomes global. */
function uncoveredScope(proposed: readonly number[], confirmed: readonly (readonly number[])[], allEpisodes: readonly number[]): number[] | null {
  if (confirmed.some(scope => !scope.length)) return null;
  if (!confirmed.length) return [...new Set(proposed)].sort((a, b) => a - b);
  const covered = new Set(confirmed.flat());
  const remaining = [...new Set(proposed.length ? proposed : allEpisodes)].filter(number => !covered.has(number)).sort((a, b) => a - b);
  return remaining.length ? remaining : null;
}
/** Same-key decisions can have different scoped answers; include uncovered proposals from preceding chunks. */
export function appendFoundationChoiceRegistry(registry: FoundationChoiceRegistry, choices: readonly HumanChoice[], allEpisodes: readonly number[]): FoundationChoiceRegistry {
  const result = structuredClone(registry);
  for (const choice of mergeHumanChoices([choices])) {
    const proposed = readApplicationScope(choice.applicationScope, choice.episodes);
    const compatible = result.filter(item=>normalizeDecisionKey(item.decisionKey) === normalizeDecisionKey(choice.decisionKey) && (!item.options || JSON.stringify(item.options) === JSON.stringify(choice.options)));
    const applicationScope = uncoveredApplicationScope(proposed,compatible.filter(item=>item.status === 'CONFIRMED').map(item=>readApplicationScope(item.applicationScope,item.episodes)),allEpisodes);
    if (!applicationScope) continue;
    const matching = result.filter(item => normalizeDecisionKey(item.decisionKey) === normalizeDecisionKey(choice.decisionKey)
      && JSON.stringify(item.options) === JSON.stringify(choice.options)
      && JSON.stringify(readApplicationScope(item.applicationScope, item.episodes)) === JSON.stringify(applicationScope));
    if (!matching.length) result.push({ decisionKey: choice.decisionKey, status: 'PENDING', question: choice.question, episodes: scopeEpisodes(applicationScope), applicationScope, options: [...choice.options] });
  }
  return result;
}
/** Call inside the candidate publication transaction, after assertCurrent. */
export async function syncFoundationChoices(db: Db, projectId: string, sourceVersion: string, stage: FoundationStageCode, choices: readonly HumanChoice[]) {
  if (!choices.length) return;
  const rows = await db.presentationContract.findMany({ where: { projectId } });
  const sourceEpisodes = await db.episode.findMany({ where: { projectId }, select: { id: true, number: true } });
  for (const choice of mergeHumanChoices([choices])) {
    const decisionKey = normalizeDecisionKey(choice.decisionKey);
    const compatible = rows.filter(row=>normalizeDecisionKey(keyOf(row)) === decisionKey && JSON.stringify(options(row)) === JSON.stringify(choice.options) && (!metadata(row) || metadata(row)?.sourceVersion === sourceVersion));
    const proposedScope = uncoveredApplicationScope(readApplicationScope(choice.applicationScope, choice.episodes),compatible.filter(row=>row.status === 'CONFIRMED').map(row=>foundationChoiceCondition(row,sourceEpisodes).applicationScope),sourceEpisodes.map(ep=>ep.number));
    if (!proposedScope) continue;
    const matching = rows.filter(row => normalizeDecisionKey(keyOf(row)) === decisionKey && JSON.stringify(options(row)) === JSON.stringify(choice.options) && JSON.stringify(foundationChoiceCondition(row, sourceEpisodes).applicationScope) === JSON.stringify(proposedScope));
    if (scopeEpisodes(proposedScope).some(n => !sourceEpisodes.some(ep=>ep.number === n))) throw new Error('问题适用集不在当前来源中。');
    if (proposedScope.kind === 'SCENES') for (const ref of proposedScope.scenes) {
      if (!await db.scriptScene.findFirst({ where: { episode: { projectId, number: ref.episode }, sceneKey: ref.sceneKey }, select: { id: true } })) throw new Error('问题适用场次不存在。');
    }
    for (const ref of readChoiceEvidence(choice.evidenceRefs, sourceVersion)) {
      const ep = await db.episode.findFirst({ where: { projectId, number: ref.episode }, select: { content: true } });
      if (!ep || ref.endLine && ref.endLine > ep.content.split(/(?<=\n)/).length) throw new Error('问题证据原文位置不存在。');
      if (ref.sceneKey && !await db.scriptScene.findFirst({ where: { episode: { projectId, number: ref.episode }, sceneKey: ref.sceneKey }, select: { id: true } })) throw new Error('问题证据场次不存在。');
      if (ref.nodeId) throw new Error('当前问题协议请使用已验证的场次和原文行号，不接收未核实的节点编号。');
    }
    const confirmed = matching.filter(row => row.status === "CONFIRMED" && (!metadata(row) || metadata(row)?.sourceVersion === sourceVersion));
    const scopes = confirmed.flatMap(row => {
      const scope = foundationChoiceCondition(row, sourceEpisodes);
      return scope.scopeResolved ? [scope.episodes] : [];
    });
    const episodes = proposedScope.kind === "UNRESOLVED" ? [] : confirmed.length ? null : scopeEpisodes(proposedScope);
    if (episodes === null) continue;
    // Author suggestions retain the same identity when Q1 asks for a human decision.
    const isOpen = (row: PresentationContract) => row.status === "PENDING" || row.status === "SUGGESTED";
    const old = matching.find(row => isOpen(row) && metadata(row)?.sourceVersion === sourceVersion)
      ?? matching.find(row => isOpen(row));
    // Legacy questions keep their hand-written note and original options; matching is by supplied registry key only.
    if (old && !metadata(old)) continue;
    const sameSource = old && metadata(old)?.sourceVersion === sourceVersion;
    const previous = sameSource ? metadata(old!) : null;
    const reason = confirmed.length ? `${choice.reason}\n本题仅确认本卡列出的新增适用范围；原已确认范围和答案保持不变。` : choice.reason;
    const meta: Metadata = { schema: VERSION, sourceVersion, decisionKey, applicationScope: proposedScope, evidenceRefs: readChoiceEvidence(choice.evidenceRefs, sourceVersion), receivingUses: choice.receivingUses ?? [],
      episodes: previous ? (!previous.episodes.length || !episodes.length ? [] : [...new Set([...previous.episodes, ...episodes])].sort((a, b) => a - b)) : episodes,
      sourceStages: [...new Set([...(previous?.sourceStages ?? []), stage])], reason: previous?.reason ?? reason,
      recommended: previous?.recommended ?? choice.recommended, recommendationReason: previous?.recommendationReason ?? choice.recommendationReason };
    const evidence = [...new Set([...(sameSource && old?.evidence ? old.evidence.split("\n") : []), ...choice.evidence.split("\n")])].join("\n");
    if (old) {
      const data = { evidence, note: JSON.stringify(meta),
        status: stage === 'Q1' || !sameSource ? 'PENDING' : old.status,
        ...(sameSource ? {} : { category: choice.kind, question: choice.question, options: JSON.stringify(choice.options), round: old.round + 1 }) };
      const updated = await db.presentationContract.updateMany({ where: { id: old.id, projectId, status: old.status, updatedAt: old.updatedAt }, data });
      if (updated.count !== 1) throw new FoundationChoiceError('decision-changed');
      const refreshed = await db.presentationContract.findUniqueOrThrow({ where: { id: old.id } });
      rows[rows.findIndex(row => row.id === old.id)] = refreshed;
    } else {
      const created = await db.presentationContract.create({ data: { id: `foundation-choice-${digest([projectId, decisionKey, sourceVersion, proposedScope, choice.options])}`, projectId, category: choice.kind,
        question: choice.question, options: JSON.stringify(choice.options), evidence, note: JSON.stringify(meta), status: "PENDING" } });
      // Different proposed scope kinds can subtract confirmed consent to the same scope.
      rows.push(created);
    }
  }
}

/** Authentication is enforced by the action; this transaction also enforces project binding and optimistic concurrency. */
export async function confirmFoundationChoice(db: PrismaClient, args: { projectId: string; contractId: string; revision: string; optionIndex?: string; customAnswer?: string }) {
  try { await db.$transaction(tx => confirmFoundationChoiceInTransaction(tx, args)); } catch (error) {
    if (error instanceof FoundationChoiceError) throw error;
    if (typeof error === "object" && error && "code" in error && ["P2034", "P2028", "P1008"].includes(String(error.code))) throw new FoundationChoiceError("decision-changed");
    throw error;
  }
}

/** The delivery controller uses this in the same transaction as queuing the scoped continuation. */
export async function confirmFoundationChoiceInTransaction(tx: Db, args: { projectId: string; contractId: string; revision: string; optionIndex?: string; customAnswer?: string }) {
    await assertNoActiveFoundationDelivery(tx, args.projectId);
    const project = await tx.project.findUnique({ where: { id: args.projectId }, include: { episodes: { orderBy: { number: "asc" } } } });
    const row = await tx.presentationContract.findFirst({ where: { id: args.contractId, projectId: args.projectId } });
    if (!project || !row || row.status !== "PENDING") throw new FoundationChoiceError("decision-changed");
    let sourceVersion: string;
    try { sourceVersion = buildSourceIndex(project.episodes).version; }
    catch { throw new FoundationChoiceError("decision-changed"); }
    if ((metadata(row) && metadata(row)!.sourceVersion !== sourceVersion) || args.revision !== revisionOf(row, sourceVersion)) throw new FoundationChoiceError("decision-changed");
    if (await tx.pipelineRun.findFirst({ where: { projectId: args.projectId, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } })) throw new FoundationChoiceError("decision-running", "岗位仍在执行，请停止或等待完成后确认。");
    let answer: string;
    if (args.optionIndex !== undefined && args.customAnswer === undefined && /^(0|[1-9]\d*)$/.test(args.optionIndex)) {
      answer = options(row)[Number(args.optionIndex)] ?? "";
    } else if (args.optionIndex === undefined && args.customAnswer !== undefined) answer = args.customAnswer.trim();
    else answer = "";
    if (!answer.trim() || /^(?:[A-Z][.、．]\s*)?(?:用户)?自定义(?:方案)?[.…]*$/i.test(answer.trim())) throw new FoundationChoiceError("decision-invalid", "请选择有效方案或填写自定义答案。");
    const result = await tx.presentationContract.updateMany({ where: { id: row.id, projectId: args.projectId, status: "PENDING", updatedAt: row.updatedAt, options: row.options, note: row.note },
      data: { userAnswer: answer, status: "CONFIRMED", decidedAt: new Date() } });
    if (result.count !== 1) throw new FoundationChoiceError("decision-changed");
}
