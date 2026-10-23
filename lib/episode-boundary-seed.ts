import {createHash} from 'node:crypto';
import { assertSourceVersion, buildSourceIndex, type SourceIndex } from './project-foundation-contracts';
import type { PreparedStandardEpisode, StandardScriptSyntax } from './standard-script-plan';
import {prepareEpisodeScript,scriptPerformanceVersion,type ScriptPerformanceOptions} from './standard-script-reception';
import type { LightScene } from './light-foundation-supply';

export type BoundaryNode = { id: string; target: string; kind: string; sourceUnitIds: string[]; sourceRange: { start: number; end: number }; startLine: number; endLine: number };
export type BoundarySourceEvidence = {
  episode: number; sceneKey: string | null; location: string | null; timeOfDay: string | null; interiorExterior: string | null;
  selectionKind: 'SAVED_SCENE' | 'STANDARD_SCENE' | 'TAIL_NODES' | 'OPENING_NODES' | 'WHOLE_EPISODE_FALLBACK' | 'FULL_EPISODE_EXPANSION' | 'EMPTY_SOURCE';
  sourceRange: { start: number; end: number }; startLine: number | null; endLine: number | null; text: string;
  sourceTextHash: string; sourceLength: number;
  nodes: BoundaryNode[]; clipped: boolean; budgetExceeded: boolean; diagnostics: PreparedStandardEpisode['diagnostics'];
};
export type BoundarySeedOptions = { resolutions?: Record<number, PreparedStandardEpisode>; knownSpeakers?: string[]; syntax?: StandardScriptSyntax; softBudget?: number }&ScriptPerformanceOptions;

const sourceTextHash=(text:string)=>createHash('sha256').update(text).digest('hex');
function sourceEvidence(index: SourceIndex, number: number, scenes: LightScene[], side: 'previous' | 'current', options: BoundarySeedOptions, fullEpisode=false): BoundarySourceEvidence {
  const episode = index.episodes.find(e => e.number === number)!;
  const prepared = prepareEpisodeScript(episode,null,options.resolutions?.[number],{knownSpeakers:options.knownSpeakers,syntax:options.syntax,inlinePerformance:options.inlinePerformance,inlinePerformanceVersion:options.inlinePerformanceVersion,sourceRegroupVersion:options.sourceRegroupVersion});
  if (prepared.index.text !== episode.content || prepared.index.sourceId !== `episode-${number}`) throw new Error('边界解析决定与当前集原文不匹配。');
  const units = prepared.index.units, unitMap = new Map(units.map((unit, i) => [unit.id, { unit, line: i + 1 }])), byUnit = new Map(prepared.plan.entries.flatMap(entry => entry.unitIds.map(id => [id, entry] as const)));
  const seen = new Set<string>(), nodes: BoundaryNode[] = [];
  for (const [i, unit] of units.entries()) {
    const entry = byUnit.get(unit.id), id = entry?.id ?? `unresolved-${unit.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const members = entry ? entry.unitIds.map(id => unitMap.get(id)!.unit).sort((a, b) => a.start - b.start) : [unit];
    const start = members[0]?.start ?? unit.start, end = members.at(-1)?.end ?? unit.end;
    nodes.push({ id, target:entry?.target==='BODY'&&entry.kind==='SOURCE_REGROUP'?'ANNOTATION':entry?.target ?? 'UNRESOLVED', kind: entry ? entry.target === 'EXCLUDE' ? entry.category : entry.kind : 'UNRESOLVED',
      sourceUnitIds: members.map(u => u.id), sourceRange: { start, end }, startLine: i + 1, endLine: unitMap.get(members.at(-1)!.id)!.line });
  }
  const stored = scenes.filter(s => s.episode === number).sort((a, b) => a.sourceRange.start - b.sourceRange.start);
  const candidate = side === 'previous' ? stored.at(-1) : stored[0];
  const validScene = candidate && Number.isSafeInteger(candidate.sourceRange.start) && Number.isSafeInteger(candidate.sourceRange.end)
    && candidate.sourceRange.start >= 0 && candidate.sourceRange.start < candidate.sourceRange.end && candidate.sourceRange.end <= episode.content.length
    && !(side === 'previous' ? episode.content.slice(candidate.sourceRange.end) : episode.content.slice(0, candidate.sourceRange.start)).trim()
    && !nodes.some(n => n.sourceRange.start < candidate.sourceRange.start && n.sourceRange.end > candidate.sourceRange.start || n.sourceRange.start < candidate.sourceRange.end && n.sourceRange.end > candidate.sourceRange.end) ? candidate : undefined;
  const headings = nodes.filter(n => n.target === 'STRUCTURE' && n.kind === 'SCENE_HEADING');
  const heading = side === 'previous' ? headings.at(-1) : headings[0];
  let start = fullEpisode ? 0 : validScene?.sourceRange.start ?? heading?.sourceRange.start ?? 0;
  let end = fullEpisode ? episode.content.length : validScene?.sourceRange.end ?? (side === 'current' && headings[1] ? headings[1].sourceRange.start : episode.content.length);
  const originalStart = start, originalEnd = end;
  let selected = nodes.filter(n => n.sourceRange.start >= start && n.sourceRange.end <= end);
  const bodies = selected.filter(n => n.target === 'BODY' || n.target === 'UNRESOLVED');
  const required = side === 'previous' ? bodies.at(-1) : bodies[0];
  const budget = options.softBudget ?? 2400;
  let nonemptyNodes = selected.filter(n => episode.content.slice(n.sourceRange.start, n.sourceRange.end).trim()).length;
  // The budget is soft: a multiline dialogue/action node is indivisible, even if oversized.
  while (nonemptyNodes > 1 && end - start > budget) {
    if (required && (side === 'previous' ? selected[0] : selected.at(-1)) === required) break;
    const removed = side === 'previous' ? selected.shift()! : selected.pop()!;
    if (episode.content.slice(removed.sourceRange.start, removed.sourceRange.end).trim()) nonemptyNodes--;
    if (side === 'previous') start = selected[0].sourceRange.start;
    else end = selected.at(-1)!.sourceRange.end;
  }
  const clipped = start !== originalStart || end !== originalEnd;
  const text = episode.content.slice(start, end);
  const selectionKind = !text.trim() ? 'EMPTY_SOURCE' : fullEpisode ? 'FULL_EPISODE_EXPANSION' : clipped ? side === 'previous' ? 'TAIL_NODES' : 'OPENING_NODES'
    : validScene ? 'SAVED_SCENE' : heading ? 'STANDARD_SCENE' : 'WHOLE_EPISODE_FALLBACK';
  // Only explicit heading syntax provides a scene key; an unlabelled whole episode is not a scene.
  const sceneKey = fullEpisode ? null : validScene?.sceneKey ?? (heading ? /^(\d+\s*-\s*\d+)/u.exec(episode.content.slice(heading.sourceRange.start).trimStart())?.[1].replace(/\s/g, '') ?? null : null);
  return { episode: number, sceneKey, location: validScene?.location ?? null, timeOfDay: validScene?.timeOfDay ?? null, interiorExterior: validScene?.interiorExterior ?? null,
    selectionKind, sourceRange: { start, end }, startLine: selected[0]?.startLine ?? null, endLine: selected.at(-1)?.endLine ?? null, text,sourceTextHash:sourceTextHash(episode.content),sourceLength:episode.content.length,
    nodes: selected, clipped, budgetExceeded: text.length > budget, diagnostics: structuredClone(prepared.diagnostics) };
}

/** Mechanical boundary receipt only. Story order and current states require evidence-aware review. */
export function buildEpisodeBoundarySeed(index: SourceIndex, scenes: LightScene[], toEpisode: number, options: BoundarySeedOptions = {}) {
  scriptPerformanceVersion(options);
  assertSourceVersion(index, index.version);
  if (!index.episodes.some(e => e.number === toEpisode)) throw new Error('边界目标集不存在。');
  const previous = index.episodes.filter(e => e.number < toEpisode).at(-1);
  const previousSource = previous ? sourceEvidence(index, previous.number, scenes, 'previous', options) : null;
  const currentOpening = sourceEvidence(index, toEpisode, scenes, 'current', options);
  const evidence = [previousSource && { role: 'PREVIOUS_SOURCE' as const, source: previousSource }, { role: 'CURRENT_OPENING' as const, source: currentOpening }]
    .filter((item): item is NonNullable<typeof item> => Boolean(item)).map(({ role, source }) => ({ role, episode: source.episode, ...source.sourceRange, startLine: source.startLine, endLine: source.endLine, nodeIds: source.nodes.map(n => n.id) }));
  const declaration = (label: string) => {
    if (!currentOpening.sceneKey) return 'UNKNOWN';
    const firstBodyStart = currentOpening.nodes.find(n => n.target === 'BODY' || n.target === 'UNRESOLVED')?.sourceRange.start ?? currentOpening.sourceRange.end;
    const values = currentOpening.nodes.filter(n => n.target === 'STRUCTURE' && n.kind === 'SCENE_METADATA' && n.sourceRange.end <= firstBodyStart).flatMap(n => {
      const value = new RegExp(`^\\s*${label}\\s*[:：]\\s*([^\\r\\n]+)`).exec(index.episodes.find(e => e.number === toEpisode)!.content.slice(n.sourceRange.start, n.sourceRange.end))?.[1].trim();
      return value ? [value] : [];
    });
    return new Set(values).size === 1 ? values[0] : 'UNKNOWN';
  };
  const story = { timeLayer: declaration('时间层'), realityDomain: 'UNKNOWN' };
  const unknowns = ['开场状态与前集事件是否连续须审阅原文；本包不生成 initialStates。', 'realityDomain 未有可靠结构化声明，不由梦、回忆、醒来等关键词断言。'];
  if (story.timeLayer === 'UNKNOWN') unknowns.push('timeLayer 未有单一可靠的本集开场结构声明。');
  if (!previous) unknowns.push('没有更早集的来源；不补造前情。');
  if (previous && previous.number + 1 !== toEpisode) unknowns.push('前源与目标集不相邻，中间来源缺失。');
  for (const source of [previousSource, currentOpening]) if (source) {
    if (!source.sceneKey) unknowns.push(`第${source.episode}集未定位场界，${source.selectionKind}不冒充完整场。`);
    if (source.clipped) unknowns.push(`第${source.episode}集仅供完整节点选段，未供部分可按sourceVersion与源坐标补读。`);
    if (source.diagnostics.length) unknowns.push(`第${source.episode}集结构尚有未决诊断，原文节点保留，不能视为语义确认。`);
  }
  return { schema: 'EPISODE_BOUNDARY_SEED_V1' as const, sourceVersion: index.version, fromEpisode: previous?.number ?? null, toEpisode,
    adjacentEpisode: previous ? previous.number + 1 === toEpisode : null, previousSource, currentOpening, evidence, story, unknowns,
    policy: '来源位置与完整节点仅为证据；集号相邻不证明故事直连，目录状态不证明本集开场状态。按需补读完整原文后再判断时间、现实域、知情和状态解除。' };
}
export type EpisodeBoundarySeed = ReturnType<typeof buildEpisodeBoundarySeed>;

/** Keep evidence already supplied to this run; resolving a need must not shrink its basis. */
export function retainExpandedEpisodeBoundarySeed(seed:EpisodeBoundarySeed,prior?:EpisodeBoundarySeed|null,options:BoundarySeedOptions={}):EpisodeBoundarySeed{
  scriptPerformanceVersion(options);
  const current=seed.previousSource,old=prior?.previousSource;
  if(!current||!old||old.selectionKind!=='FULL_EPISODE_EXPANSION'||prior?.fromEpisode!==seed.fromEpisode||prior.toEpisode!==seed.toEpisode
    ||old.sourceTextHash!==current.sourceTextHash||old.sourceLength!==current.sourceLength)return structuredClone(seed);
  return expandEpisodeBoundarySeed(seed,old.text,options);
}

/** Free evidence expansion. No semantic inference, source rewrite, budget clipping or current-opening mutation. */
export function expandEpisodeBoundarySeed(seed:EpisodeBoundarySeed,previousEpisodeText:string,options:BoundarySeedOptions={}):EpisodeBoundarySeed{
  scriptPerformanceVersion(options);
  const previous=seed.previousSource;
  const reject=(message:string):never=>{throw Object.assign(new Error(message),{code:'BOUNDARY_SOURCE_STALE',requestOutcome:'NOT_SENT'});};
  if(seed.schema!=='EPISODE_BOUNDARY_SEED_V1'||!seed.sourceVersion||seed.fromEpisode===null||!previous||previous.episode!==seed.fromEpisode)reject('边界记录没有可验证的前集原文绑定。');
  if(typeof previousEpisodeText!=='string'||!previous!.sourceTextHash||previous!.sourceTextHash!==sourceTextHash(previousEpisodeText)||previous!.sourceLength!==previousEpisodeText.length)reject('前集完整原文哈希不符或旧种子没有哈希；请按当前源版本重新读取边界，不补接不同原稿。');
  const range=previous!.sourceRange;
  if(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<range.start||range.end>previousEpisodeText.length||previous!.text!==previousEpisodeText.slice(range.start,range.end))reject('前集已有选段与原文坐标不符，未扩展不可信记录。');
  if(previous!.selectionKind==='FULL_EPISODE_EXPANSION'&&range.start===0&&range.end===previousEpisodeText.length&&!previous!.clipped)return structuredClone(seed);
  const index=buildSourceIndex([{number:seed.fromEpisode!,title:null,content:previousEpisodeText}]);
  const expanded=sourceEvidence(index,seed.fromEpisode!,[],'previous',{...options,softBudget:Number.POSITIVE_INFINITY},true);
  const result=structuredClone(seed);result.previousSource=expanded;
  result.evidence=result.evidence.map(item=>item.role==='PREVIOUS_SOURCE'?{role:'PREVIOUS_SOURCE',episode:expanded.episode,...expanded.sourceRange,startLine:expanded.startLine,endLine:expanded.endLine,nodeIds:expanded.nodes.map(n=>n.id)}:item);
  const oldClippedNote=`第${previous!.episode}集仅供完整节点选段，未供部分可按sourceVersion与源坐标补读。`;
  result.unknowns=[...result.unknowns.filter(note=>note!==oldClippedNote),`第${expanded.episode}集已按完整原文节点补读，FULL_EPISODE_EXPANSION不是末场定位；故事直连、现实域及初态仍须据证判断。`];
  if(expanded.diagnostics.length)result.unknowns.push('扩读的标准解析仍有未决诊断；保留完整原文，不把解析结果冒称语义确认。');
  return result;
}
