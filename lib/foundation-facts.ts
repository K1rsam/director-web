/** Source excerpts are evidence, never model-authored replacements or inferred current states. */
import { createHash } from 'node:crypto';
import type { SourceIndex } from './project-foundation-contracts';
import type { FoundationSourceContext } from './foundation-source';
import type { ProductionCatalog } from './foundation-production-contracts';
import { expandRelevantNames } from './foundation-dependency-selector';
import { deriveStandardScriptLines, type PreparedStandardEpisode, type StandardScriptSyntax } from './standard-script-plan';
import {parseEpisodeNumber} from './episode-presentation';
import {prepareEpisodeScript,type ScriptPerformanceOptions} from './standard-script-reception';
import {selectEpisodeEvidence} from '../runtime/episode-evidence.mjs';

export type FoundationFact = {
  id: string; subjects: string[]; kind: 'IDENTITY' | 'RELATION' | 'STATE' | 'SETTING' | 'UTTERANCE' | 'CONTEXT' | 'FORMAT'; statement: string;
  evidence: { domain: 'EPISODE' | 'CONTEXT'; episode?: number; sectionKey?: string; start: number; end: number };
  claim: 'SOURCE' | 'CHARACTER_CLAIM'; applicability: 'GLOBAL' | 'SUBJECT' | 'UNRESOLVED'; validity: { status: 'EXPLICIT' | 'UNKNOWN'; start?: number; end?: number };
  contextUse?: {kind:'EPISODE_OUTLINE';episode:number;heading:{quote:string;start:number;end:number}};
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CONTEXT_LABEL = /^\s*(?:规则|世界(?:观)?规则|世界观设定|世界设定|设定|作者资料|作者说明|作者备注|背景资料|背景设定|人物设定|人物小传|连续性备注|导演处理|情绪备注)\s*[:：]/u;
const EXPLICIT_RULE_LABEL = /^\s*(?:规则|世界(?:观)?规则|世界观设定|世界设定)\s*[:：]/u;
// Whole-line format markers only: an episode number followed by narrative text
// remains evidence, including anonymous background and episode-zero prose.
const PURE_EPISODE_HEADING = /^(?:#{1,6}\s*)?(?:(?:第\s*)?(?:[0-9０-９]+|[零〇一二两三四五六七八九十百千]+)\s*集|(?:episode\s+|ep\.?\s*)(?:[0-9０-９]+|zero|one|two|three|four|five|six|seven|eight|nine|ten))\s*[:：｜|－—-]*\s*$/i;
const CONTEXT_SECTION_HEADING = /^(?:#{1,6}\s*)?(?:第\s*[0零〇]\s*集[\s｜|:：-]*)?(?:作者资料|人物小传|人物设定|世界观设定|背景资料|附录|故事梗概|(?:[0-9０-９零〇一二两三四五六七八九十百千]+\s*集\s*)?段纲)[\s:：｜|]*$/;
const sectionHeading = (text: string) => {
  const value = text.replace(/^#{1,6}\s*/, '').trim();
  const wrapped = value.match(/^(?:【([^【】]+)】|\[([^\[\]]+)\]|（([^（）]+)）|\(([^()]+)\))$/);
  return CONTEXT_SECTION_HEADING.test(wrapped ? wrapped.slice(1).find(part => part !== undefined)!.trim() : value);
};
/** A title is formatting only with explicit title-field evidence elsewhere in
 * the same source section; never infer it from a short first narrative line. */
const declaredSourceTitles = (text: string) => new Set([...text.matchAll(/^\s*(?:剧名|剧本名称|剧本名|作品名称|上线备用剧名|备用剧名)\s*[:：]\s*([^\r\n]+)$/gm)].flatMap(match => {
  const value=match[1].trim(), quoted=[...value.matchAll(/《([^《》\r\n]+)》/g)].map(item=>item[1]);
  return quoted.length ? quoted : [value];
}).filter(title=>title.length<=60&&!/[：:△▲。！？!?“”「」]/.test(title)));
export function isFoundationSourceFormatLine(text: string, start: number, end: number): boolean {
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>text.length)return false;
  const line=[...text.matchAll(/[^\r\n]+(?:\r\n|\r|\n)?/g)].find(match=>match.index===start&&start+match[0].length===end);
  if(!line)return false;
  const statement=line[0].trim(),first=text.search(/\S/);
  return PURE_EPISODE_HEADING.test(statement)||sectionHeading(statement)||start<=first&&first<end&&declaredSourceTitles(text).has(statement);
}
/** Includes every nonempty source line, regardless of whether an image asset exists. */
export function buildFoundationFacts(index: SourceIndex, context: FoundationSourceContext, catalog: ProductionCatalog | null, options: { standard?: boolean; resolutions?:Record<number,PreparedStandardEpisode>; postColonCue?:boolean;syntax?:StandardScriptSyntax }&ScriptPerformanceOptions = {}) {
  const sourceTexts = [...context.background.map(s => s.text), ...index.episodes.map(e => e.content)];
  const prepared = new Map(options.standard ? index.episodes.map(episode => [episode.number, prepareEpisodeScript(episode,catalog,options.resolutions?.[episode.number], { postColonCue: options.postColonCue,syntax:options.syntax,inlinePerformance:options.inlinePerformance,inlinePerformanceVersion:options.inlinePerformanceVersion })]) : []);
  const typedRows = new Map([...prepared].map(([number, episode]) => [number, new Map(deriveStandardScriptLines(episode).map(row => [episode.index.units[row.line - 1].start, row]))]));
  const names = [...new Set([...(catalog?.assets ?? []).flatMap(a => [a.name, ...(options.standard ? [a.name.split(/[|｜]/)[0]] : []), ...a.aliases]),
    ...(options.standard ? [...prepared.values()].flatMap(episode => deriveStandardScriptLines(episode).flatMap(row => row.speakers ?? (row.speaker ? [row.speaker] : [])))
      : sourceTexts.flatMap(text => [...text.matchAll(/(?:^|[\r\n])\s*([^：:\r\n]{1,20}?)(?:[（(](?:OS|VO|旁白|画外音)[）)])?\s*[：:]/gi)].map(m => m[1].trim())))])].filter(Boolean);
  const facts: FoundationFact[] = [];
  const scan = (text: string, origin: Pick<FoundationFact['evidence'], 'domain' | 'episode' | 'sectionKey'>) => {
    const titles=origin.domain==='CONTEXT'?declaredSourceTitles(text):new Set<string>();
    const firstNonempty=text.search(/\S/);
    let outlineHeading: {quote:string;start:number;end:number}|null=null;
    for (const match of text.matchAll(/[^\r\n]+(?:\r\n|\r|\n)?/g)) {
      const statement = match[0], start = match.index, end = start + statement.length;
      if (!statement.trim()) continue;
      if(origin.domain==='CONTEXT'){
        if(/^\s*(?:#{1,6}\s*)?(?:分集概括|分集梗概|分集大纲|分集段纲|(?:\d+集)?段纲)\s*[:：]?\s*$/u.test(statement))outlineHeading={quote:statement,start,end};
        else if(/^\s*(?:故事大纲|故事梗概|人物小传|人物设定|角色小传|世界观设定|背景资料)\s*[:：]?\s*$/u.test(statement)
          ||/^\s*(?:#{1,6}\s*)?[^：:\n]{1,30}[:：]\s*$/u.test(statement)||/^\s*#{1,6}\s+/u.test(statement))outlineHeading=null;
      }
      const outlineLabel=outlineHeading?statement.match(/^\s*(?:第\s*)?([0-9０-９零〇一二两三四五六七八九十百千]+)\s*(?:集\s*[:：]?|[.．、])\s*\S/u)?.[1]:undefined;
      const outlineNumber=outlineLabel?parseEpisodeNumber(outlineLabel):null;
      const contextUse=outlineNumber!==null&&outlineNumber>0?{kind:'EPISODE_OUTLINE' as const,episode:outlineNumber,heading:outlineHeading!}:undefined;
      const typed = origin.domain === 'EPISODE' ? typedRows.get(origin.episode!)?.get(start) : undefined;
      const speaker = origin.domain === 'CONTEXT' && CONTEXT_LABEL.test(statement) ? undefined : options.standard && origin.domain === 'EPISODE' ? typed?.speaker ?? typed?.speakers?.[0] : statement.match(/^\s*([^：:\r\n]{1,30}?)(?:[（(](?:OS|VO|旁白|画外音)[）)])?\s*[：:]/i)?.[1]?.trim();
      const subjects = [...new Set([...names.filter(name => statement.includes(name)), ...(typed?.speakers ?? (speaker ? [speaker] : []))])];
      const formatHeading = typed?.target === 'STRUCTURE' || origin.domain === 'CONTEXT' && (PURE_EPISODE_HEADING.test(statement.trim()) || sectionHeading(statement.trim()) || start<=firstNonempty && firstNonempty<end && titles.has(statement.trim()));
      // Modal words inside dialogue cannot promote a character claim to a world rule.
      // A global label is an explicit source declaration, not a keyword inference.
      const globalRule = !formatHeading && !speaker && origin.domain === 'CONTEXT' && EXPLICIT_RULE_LABEL.test(statement);
      const kind = formatHeading ? 'FORMAT' : typed?.target === 'ANNOTATION' || typed?.target === 'UNRESOLVED' ? 'CONTEXT' : globalRule ? 'SETTING' : speaker ? 'UTTERANCE' : /受伤|伤口|绷带|骨折|换上|换下|脱下|穿着|痊愈|恢复|交给|递给|归还/.test(statement) ? 'STATE'
        : /父亲|母亲|兄弟|姐妹|夫妻|师父|师徒|父子|母子/.test(statement) ? 'RELATION' : origin.domain === 'CONTEXT' ? 'CONTEXT' : 'SETTING';
      const evidence = { ...origin, start, end };
      facts.push({ id: digest([index.version, context.version, evidence]), subjects, kind, statement, evidence,
        claim: speaker ? 'CHARACTER_CLAIM' : 'SOURCE', applicability: globalRule ? 'GLOBAL' : subjects.length ? 'SUBJECT' : 'UNRESOLVED', validity: { status: 'UNKNOWN' },...(contextUse?{contextUse}:{}) });
    }
  };
  for (const section of context.background) scan(section.text, { domain: 'CONTEXT', sectionKey: section.key });
  for (const episode of index.episodes) scan(episode.content, { domain: 'EPISODE', episode: episode.number });
  return { schema: 'FOUNDATION_FACTS_V1' as const, sourceVersion: index.version, sourceContextVersion: context.version, facts,
    // This is a retrieval graph only: same-name assets remain distinct catalog identities.
    identityNameGroups: (catalog?.assets??[]).map(a=>[a.name,...a.aliases].filter(Boolean)) };
}
export type FoundationFacts = ReturnType<typeof buildFoundationFacts>;
export function selectFoundationFacts(store: FoundationFacts, index: SourceIndex, scope: number[], options: {
  historyMode?: 'full' | 'episode'; requestedEvidence?: FoundationFact['evidence'][];
} = {}) {
  const { facts: _allFacts, identityNameGroups: _identityNameGroups, ...storeMetadata } = store;
  const text = index.episodes.filter(e => scope.includes(e.number)).map(e => e.content).join('\n');
  const local = store.facts.filter(f => f.evidence.domain === 'EPISODE' && scope.includes(f.evidence.episode!));
  const subjects = expandRelevantNames(local.flatMap(f => f.subjects),store.identityNameGroups??[]);
  const relevant = (fact: FoundationFact) => fact.subjects.some(name => subjects.has(name) || name.length > 1 && text.includes(name));
  const withinOutline = (f: FoundationFact) => options.historyMode !== 'episode' || !f.contextUse || scope.includes(f.contextUse.episode);
  const background = store.facts.filter(f => f.evidence.domain === 'CONTEXT' && f.kind !== 'FORMAT' && withinOutline(f) && (f.applicability === 'GLOBAL' || relevant(f)));
  const unlinkedBackground = store.facts.filter(f=>f.evidence.domain==='CONTEXT'&&f.kind!=='FORMAT'&&withinOutline(f)&&f.applicability==='UNRESOLVED');
  // Bounded candidates remain unlinked evidence, never global or current-state facts.
  let candidateChars = 0;
  const backgroundCandidates = unlinkedBackground.filter(fact => {
    if (candidateChars + fact.statement.length > 12000) return false;
    candidateChars += fact.statement.length; return true;
  });
  // Never collapse to latest state: chronology, flashbacks and unresolved releases need original evidence.
  // Unattributed states remain in the source fact store; do not broadcast them as global facts.
  const historical = store.facts.filter(f => f.evidence?.domain === 'EPISODE' && f.evidence.episode! < Math.min(...scope));
  const backed = (fact: FoundationFact) => {
    const source = index.episodes.find(e => e.number === fact.evidence.episode)?.content, { start, end } = fact.evidence;
    return source !== undefined && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= source.length && fact.statement === source.slice(start, end);
  };
  const historicalStates = historical.filter(f => f.kind === 'STATE' && backed(f) && relevant(f));
  // Legacy includes every subject-linked sentence. Episode supply recalls source
  // actions and state/claim signals, with neighbouring release/counterclaim evidence;
  // proximity is not an identity, knowledge or continuity assertion.
  const episodeSelection = options.historyMode === 'episode' ? selectEpisodeEvidence(historical.filter(backed), {scope, relevant, requestedEvidence: options.requestedEvidence}) : null;
  const anchors = historical.filter(f => f.kind !== 'FORMAT' && backed(f) && (episodeSelection ? episodeSelection.anchors.has(f.id) : relevant(f)));
  const anchorIds = new Set(anchors.map(f => f.id)), neighbourAnchors = episodeSelection?.neighbours ?? new Map<string, string[]>();
  if (!episodeSelection) for (const [position, fact] of historical.entries()) if (anchorIds.has(fact.id)) {
    for (const neighbour of [historical[position - 1], historical[position + 1]]) if (neighbour && neighbour.evidence.episode === fact.evidence.episode && neighbour.kind !== 'FORMAT' && backed(neighbour)) {
      neighbourAnchors.set(neighbour.id, [...(neighbourAnchors.get(neighbour.id) ?? []), fact.id]);
    }
  }
  const historicalEvidenceCandidates = historical.filter(f => anchorIds.has(f.id) || neighbourAnchors.has(f.id)).map(f => ({ ...structuredClone(f),
    candidateUse: 'HISTORICAL_EVIDENCE_ONLY' as const, currentApplicability: 'UNKNOWN' as const,
    retrieval: { mode: anchorIds.has(f.id) ? 'SUBJECT_MENTION' as const : 'SOURCE_NEIGHBOUR' as const, anchorFactIds: anchorIds.has(f.id) ? [f.id] : neighbourAnchors.get(f.id)! } }));
  const seenSpeakers = new Set<string>();
  const needed = local.filter(fact => {
    if (fact.kind !== 'UTTERANCE') return ['STATE', 'RELATION', 'IDENTITY'].includes(fact.kind);
    const key = fact.subjects.join('\0'); if (seenSpeakers.has(key)) return false; seenSpeakers.add(key); return true;
  });
  return { ...storeMetadata, schema: store.schema, sourceVersion: store.sourceVersion, sourceContextVersion: store.sourceContextVersion,
    // Current source is already sent once; references avoid a second screenplay copy.
    current: needed.map(({ statement: _statement, ...fact }) => fact), background, backgroundCandidates, historicalStates, historicalEvidenceCandidates,
    historicalEvidenceRejected: historical.filter(f => !backed(f)).length,
    backgroundCandidatesOmitted: unlinkedBackground.length - backgroundCandidates.length,
    unlinkedBackgroundCount: unlinkedBackground.length,
    unlinkedBackground: unlinkedBackground.map(({statement: _statement,...fact})=>fact),
    sourceFactIndex: local.map(({statement: _statement,...fact})=>fact),
    rules: (episodeSelection ? 'episode-evidence-v1：本集正文完整提供；历史只先供前集线索、状态/身份/关系/知情及反证候选，不重放全部同名旧对白。需要具体旧事件时按集号和完整源范围补读，不凭省略推断不存在。' : '') + '原文切片是证据；台词永远只是角色主张，不因必须、不能等词升级世界规则。historicalEvidenceCandidates提供身份、关系、知情、状态与解除反证的原句候选；名字匹配和邻句只用于检索，不证明相同身份、角色知情、故事时间或永久延续。历史状态须核对本集适用性，未给解除依据不等于永远持续。backgroundCandidates是尚未关联的作者资料候选，先判断与本集身份及时间的关系，不可当作全局规则或当前状态；剧情梗概中的未来事件不提前应用。未提供的候选仍可按sectionKey/episode与源位置回查，不声称已语义穷尽。' };
}
