import { prepareStandardEpisode, deriveStandardScriptLines, type PreparedStandardEpisode, type StandardScriptSyntax } from './standard-script-plan';
import type { ProductionCatalog } from './foundation-production-contracts';
import type { SourceIndex, FoundationIssue } from './project-foundation-contracts';
import {compileStandardScript,standardScriptPlanVersion,StandardScriptError} from './standard-script';
import type {DialoguePlan,StandardScriptPlan} from './standard-script';
import {compactPerformanceHeadProjection,type InlinePerformanceVersion} from '../runtime/inline-performance.mjs';
import {isDeepStrictEqual} from 'node:util';

export type ScriptInputProtocol = 'upstream-material-v2' | 'standard-episode-v1' | 'legacy';
export const UPSTREAM_MATERIAL_PROTOCOL = 'upstream-material-v2' as const;
export const STANDARD_EPISODE_PROTOCOL = 'standard-episode-v1' as const;
export type ScriptPerformanceOptions={inlinePerformance?:boolean;inlinePerformanceVersion?:InlinePerformanceVersion;sourceRegroupVersion?:'source-regroup-v1'|null};
export function scriptPerformanceVersion(options:ScriptPerformanceOptions={}):InlinePerformanceVersion {
  const version=options.inlinePerformanceVersion===undefined?'inline-performance-v2':options.inlinePerformanceVersion;
  if(!['inline-performance-v1','inline-performance-v2'].includes(version))throw new StandardScriptError('UNSUPPORTED_PERFORMANCE_VERSION','options.inlinePerformanceVersion');
  return version;
}
export function knownScriptSpeakers(catalog: ProductionCatalog | null) {
  return (catalog?.assets ?? []).filter(a => ['CH', 'GROUP', 'BEAST'].includes(a.type)).flatMap(a => [a.name.split(/[|｜]/)[0], ...a.aliases]);
}
function confirmedSpeakerEntries(prepared:PreparedStandardEpisode):Set<string> {
  const value=prepared.speakerDecisions;
  if(value===undefined)return new Set();
  const reject=():never=>{throw new StandardScriptError('UNSUPPORTED_SPEAKER_DECISIONS','resolution.speakerDecisions');};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['version','sourceVersion','entries'].includes(key))
    ||value.version!=='script-speaker-decisions-v1'||value.sourceVersion!==prepared.index.sourceVersion||!Array.isArray(value.entries))reject();
  const ids=new Set<string>();
  for(const decision of value.entries){
    if(!decision||typeof decision!=='object'||Array.isArray(decision)||Object.keys(decision).some(key=>!['entryId','speaker','channel'].includes(key))||typeof decision.entryId!=='string'||ids.has(decision.entryId))reject();
    const entry=prepared.plan.entries.find(entry=>entry.id===decision.entryId);
    if(!entry||entry.target!=='BODY'||entry.kind!=='DIALOGUE'||!isDeepStrictEqual(decision.speaker,entry.speaker)||decision.channel!==entry.channel)reject();
    ids.add(decision.entryId);
  }
  return ids;
}
export function prepareEpisodeScript(episode: {number: number; content: string}, catalog: ProductionCatalog | null, resolution?: PreparedStandardEpisode, options: {knownSpeakers?:string[];postColonCue?: boolean;syntax?:StandardScriptSyntax}&ScriptPerformanceOptions = {}):PreparedStandardEpisode {
  const version=scriptPerformanceVersion(options);
  const syntaxOptions={knownSpeakers:knownScriptSpeakers(catalog),...options};
  let prepared = resolution ?? prepareStandardEpisode(episode.content, `episode-${episode.number}`,syntaxOptions);
  if(prepared.plan.schemaVersion==='STANDARD_SCRIPT_PLAN_V6'&&options.sourceRegroupVersion===null)throw new StandardScriptError('SOURCE_REGROUP_VERSION','旧任务未冻结来源重组能力，保留旧任务，不静默降级');
  if(prepared.index.text!==episode.content||prepared.index.sourceId!==`episode-${episode.number}`)throw new Error('解析决定与当前集原文不匹配。');
  const confirmed=confirmedSpeakerEntries(prepared);
  // Derive the requested delivery from a copy. Saved classifications, IDs and source spans stay authoritative.
  if(resolution&&prepared.compiled){
    const enabled=options.inlinePerformance!==false;
    const plan=structuredClone(prepared.plan);
    const confirmedVoices=new Set<DialoguePlan>(plan.entries.flatMap(entry=>entry.target==='BODY'&&entry.kind==='DIALOGUE'&&confirmed.has(entry.id)?[entry]:[]));
    const voices=(plan:StandardScriptPlan)=>plan.entries.flatMap(entry=>entry.target!=='BODY'?[]:entry.kind==='DIALOGUE'?[entry]:entry.kind==='DIALOGUE_GROUP'?entry.dialogues:entry.kind==='BODY_GROUP'?entry.children.filter(c=>c.kind==='DIALOGUE'):[]);
    if(enabled&&version==='inline-performance-v2'&&plan.schemaVersion!=='STANDARD_SCRIPT_PLAN_V5'||(!enabled||version==='inline-performance-v1')&&plan.schemaVersion==='STANDARD_SCRIPT_PLAN_V5'){
      const parsed=prepareStandardEpisode(episode.content,prepared.index.sourceId,syntaxOptions);
      const key=(voice:DialoguePlan)=>JSON.stringify([voice.speaker[0]?.start,voice.parts]);
      const candidates=new Map(voices(parsed.plan).map(voice=>[key(voice),voice]));
      for(const voice of voices(plan)){
        if(confirmedVoices.has(voice))continue;
        const candidate=candidates.get(key(voice));
        if(!candidate||candidate.channel!==voice.channel||JSON.stringify(candidate.layout)!==JSON.stringify(voice.layout))continue;
        const compact=(v:DialoguePlan)=>compactPerformanceHeadProjection(episode.content,v.speaker,v.cue,v.channelSource);
        if(!compact(voice)&&!compact(candidate))continue;
        voice.speaker=structuredClone(candidate.speaker);voice.cue=structuredClone(candidate.cue);voice.channelSource=structuredClone(candidate.channelSource);
      }
    }
    plan.schemaVersion=standardScriptPlanVersion(prepared.index,plan.entries,{inlinePerformance:enabled,inlinePerformanceVersion:version});
    if(JSON.stringify(plan)!==JSON.stringify(prepared.plan))prepared={...prepared,plan,compiled:compileStandardScript(prepared.index,plan)};
  }
  return prepared;
}
export function prepareEpisodeReception(episode: {number: number; content: string}, catalog: ProductionCatalog | null, resolution?: PreparedStandardEpisode, options: {postColonCue?: boolean;syntax?:StandardScriptSyntax}&ScriptPerformanceOptions = {}) {
  const prepared=prepareEpisodeScript(episode,catalog,resolution,options);
  const diagnostics = [...prepared.diagnostics];
  if (!diagnostics.length && !prepared.compiled?.package.script.entries.some(e => e.target === 'BODY')) diagnostics.push({line: 1, code: 'EMPTY_BODY', message: '只有标题或资料，没有可制作正文。'});
  return {standardScript: diagnostics.length ? null : prepared.compiled?.package ?? null,
    scriptReception: {version: STANDARD_EPISODE_PROTOCOL, ready: diagnostics.length === 0, diagnostics,...(prepared.plan.schemaVersion==='STANDARD_SCRIPT_PLAN_V6'?{sourceRegroupVersion:'source-regroup-v1' as const}:{})}};
}
export function collectScriptReceptionIssues(index: SourceIndex, catalog: ProductionCatalog | null, resolutions:Record<number,PreparedStandardEpisode> = {}): FoundationIssue[] {
  return index.episodes.flatMap(episode => prepareEpisodeReception(episode, catalog, resolutions[episode.number]).scriptReception.diagnostics.map(d => ({
    severity: 'BLOCKER' as const, owner: 'PROGRAM' as const, coordinate: `source.episodes.${episode.number}.script.L${d.line}`,
    problem: `第${episode.number}集第${d.line}行：${d.message}`, sourceRefs: [{episode: episode.number, startLine: d.line, endLine: d.line}]
  })));
}
/** Syntax only; the original numbered source is already present, so never echo text here. */
export function scriptStructureTable(index: SourceIndex, catalog: ProductionCatalog | null, scope: number[], resolutions:Record<number,PreparedStandardEpisode> = {}) {
  const rows = index.episodes.filter(e => scope.includes(e.number)).flatMap(episode => {
    const prepared = resolutions[episode.number] ?? prepareStandardEpisode(episode.content, `episode-${episode.number}`, {knownSpeakers: knownScriptSpeakers(catalog)});
    const lines = deriveStandardScriptLines(prepared), grouped = new Map<string, typeof lines>();
    for (const line of lines) if (line.target !== 'EXCLUDE') {
      const key = line.entryId ?? `unresolved-${line.line}`;
      grouped.set(key, [...(grouped.get(key) ?? []), line]);
    }
    return [...grouped.values()].filter(group => ['ANNOTATION', 'UNRESOLVED'].includes(group[0].target)
      || ['DIALOGUE_GROUP','BODY_GROUP'].includes(group[0].kind) || group[0].kind === 'DIALOGUE' && (group.length > 1 || group[0].channel !== 'SPEECH'))
      .map(group => [episode.number, group[0].line, group.at(-1)!.line, group[0].target, group[0].kind, group[0].speakers ?? group[0].speaker ?? null, group[0].channel ?? null]);
  });
  return {columns: ['episode', 'startLine', 'endLine', 'target', 'kind', 'speaker', 'channel'], rows,
    note: '仅列跨行对白、特殊声道、辅助或未决位置；未列行仍按原文读取，不表示遗漏。'};
}
