/** Source excerpts are evidence, never model-authored replacements or inferred current states. */
import { createHash } from 'node:crypto';
import type { SourceIndex } from './project-foundation-contracts';
import type { FoundationSourceContext } from './foundation-source';
import type { ProductionCatalog } from './foundation-production-contracts';
import { expandRelevantNames } from './foundation-dependency-selector';

export type FoundationFact = {
  id: string; subjects: string[]; kind: 'IDENTITY' | 'RELATION' | 'STATE' | 'SETTING' | 'UTTERANCE' | 'CONTEXT' | 'FORMAT'; statement: string;
  evidence: { domain: 'EPISODE' | 'CONTEXT'; episode?: number; sectionKey?: string; start: number; end: number };
  claim: 'SOURCE' | 'CHARACTER_CLAIM'; applicability: 'GLOBAL' | 'SUBJECT' | 'UNRESOLVED'; validity: { status: 'EXPLICIT' | 'UNKNOWN'; start?: number; end?: number };
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Includes every nonempty source line, regardless of whether an image asset exists. */
export function buildFoundationFacts(index: SourceIndex, context: FoundationSourceContext, catalog: ProductionCatalog | null) {
  const sourceTexts = [...context.background.map(s => s.text), ...index.episodes.map(e => e.content)];
  const names = [...new Set([...(catalog?.assets ?? []).flatMap(a => [a.name, ...a.aliases]), ...sourceTexts.flatMap(text => [...text.matchAll(/(?:^|[\r\n])\s*([^：:\r\n]{1,20}?)(?:[（(](?:OS|VO|旁白|画外音)[）)])?\s*[：:]/gi)].map(m => m[1].trim()))])].filter(Boolean);
  const facts: FoundationFact[] = [];
  const scan = (text: string, origin: Pick<FoundationFact['evidence'], 'domain' | 'episode' | 'sectionKey'>) => {
    for (const match of text.matchAll(/[^\r\n]+(?:\r\n|\r|\n)?/g)) {
      const statement = match[0], start = match.index, end = start + statement.length;
      if (!statement.trim()) continue;
      const speaker = statement.match(/^\s*([^：:\r\n]{1,30}?)(?:[（(](?:OS|VO|旁白|画外音)[）)])?\s*[：:]/i)?.[1]?.trim();
      const subjects = [...new Set([...names.filter(name => statement.includes(name)), ...(speaker ? [speaker] : [])])];
      const formatHeading = origin.domain === 'CONTEXT' && /^(?:#{1,6}\s*)?(?:第\s*[0零〇]\s*集[\s｜|:：-]*)?(?:作者资料|人物小传|人物设定|世界观设定|背景资料|附录)[\s:：｜|]*$/.test(statement.trim());
      const globalRule = !formatHeading && origin.domain === 'CONTEXT' && /世界|规则|设定|所有|任何|不得|禁止|只有|必须|每逢|每当|无法|不能|永远/.test(statement);
      const kind = formatHeading ? 'FORMAT' : globalRule ? 'SETTING' : speaker ? 'UTTERANCE' : /受伤|伤口|绷带|骨折|换上|换下|脱下|穿着|痊愈|恢复|交给|递给|归还/.test(statement) ? 'STATE'
        : /父亲|母亲|兄弟|姐妹|夫妻|师父|师徒|父子|母子/.test(statement) ? 'RELATION' : origin.domain === 'CONTEXT' ? 'CONTEXT' : 'SETTING';
      const evidence = { ...origin, start, end };
      facts.push({ id: digest([index.version, context.version, evidence]), subjects, kind, statement, evidence,
        claim: speaker && !globalRule ? 'CHARACTER_CLAIM' : 'SOURCE', applicability: globalRule ? 'GLOBAL' : subjects.length ? 'SUBJECT' : 'UNRESOLVED', validity: { status: 'UNKNOWN' } });
    }
  };
  for (const section of context.background) scan(section.text, { domain: 'CONTEXT', sectionKey: section.key });
  for (const episode of index.episodes) scan(episode.content, { domain: 'EPISODE', episode: episode.number });
  return { schema: 'FOUNDATION_FACTS_V1' as const, sourceVersion: index.version, sourceContextVersion: context.version, facts,
    // This is a retrieval graph only: same-name assets remain distinct catalog identities.
    identityNameGroups: (catalog?.assets??[]).map(a=>[a.name,...a.aliases].filter(Boolean)) };
}
export type FoundationFacts = ReturnType<typeof buildFoundationFacts>;
export function selectFoundationFacts(store: FoundationFacts, index: SourceIndex, scope: number[]) {
  const text = index.episodes.filter(e => scope.includes(e.number)).map(e => e.content).join('\n');
  const local = store.facts.filter(f => f.evidence.domain === 'EPISODE' && scope.includes(f.evidence.episode!));
  const subjects = expandRelevantNames(local.flatMap(f => f.subjects),store.identityNameGroups??[]);
  const relevant = (fact: FoundationFact) => fact.subjects.some(name => subjects.has(name) || name.length > 1 && text.includes(name));
  const background = store.facts.filter(f => f.evidence.domain === 'CONTEXT' && f.kind !== 'FORMAT' && (f.applicability === 'GLOBAL' || relevant(f)));
  const unlinkedBackground = store.facts.filter(f=>f.evidence.domain==='CONTEXT'&&f.kind!=='FORMAT'&&f.applicability==='UNRESOLVED');
  // Bounded candidates remain unlinked evidence, never global or current-state facts.
  let candidateChars = 0;
  const backgroundCandidates = unlinkedBackground.filter(fact => {
    if (candidateChars + fact.statement.length > 12000) return false;
    candidateChars += fact.statement.length; return true;
  });
  // Never collapse to latest state: chronology, flashbacks and unresolved releases need original evidence.
  // Unattributed states remain in the source fact store; do not broadcast them as global facts.
  const historicalStates = store.facts.filter(f => f.kind === 'STATE' && f.evidence.domain === 'EPISODE' && f.evidence.episode! < Math.min(...scope) && relevant(f));
  const seenSpeakers = new Set<string>();
  const needed = local.filter(fact => {
    if (fact.kind !== 'UTTERANCE') return ['STATE', 'RELATION', 'IDENTITY'].includes(fact.kind);
    const key = fact.subjects.join('\0'); if (seenSpeakers.has(key)) return false; seenSpeakers.add(key); return true;
  });
  return { schema: store.schema, sourceVersion: store.sourceVersion, sourceContextVersion: store.sourceContextVersion,
    // Current source is already sent once; references avoid a second screenplay copy.
    current: needed.map(({ statement: _statement, ...fact }) => fact), background, backgroundCandidates, historicalStates,
    backgroundCandidatesOmitted: unlinkedBackground.length - backgroundCandidates.length,
    unlinkedBackgroundCount: unlinkedBackground.length,
    unlinkedBackground: unlinkedBackground.map(({statement: _statement,...fact})=>fact),
    sourceFactIndex: local.map(({statement: _statement,...fact})=>fact),
    rules: '原文切片是证据；台词是角色主张；历史状态须核对本集适用性，未给解除依据不等于永远持续。backgroundCandidates是尚未关联的作者资料候选，先判断与本集身份及时间的关系，不可当作全局规则或当前状态；剧情梗概中的未来事件不提前应用。未提供的候选仍可按sectionKey回查，不声称已语义穷尽。' };
}
