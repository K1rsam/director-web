import { prepareStandardEpisode, deriveStandardScriptLines, type PreparedStandardEpisode, type StandardScriptSyntax } from './standard-script-plan';
import type { ProductionCatalog } from './foundation-production-contracts';
import type { SourceIndex, FoundationIssue } from './project-foundation-contracts';
import {compileStandardScript,standardScriptPlanVersion} from './standard-script';

export type ScriptInputProtocol = 'upstream-material-v2' | 'standard-episode-v1' | 'legacy';
export const UPSTREAM_MATERIAL_PROTOCOL = 'upstream-material-v2' as const;
export const STANDARD_EPISODE_PROTOCOL = 'standard-episode-v1' as const;
export function knownScriptSpeakers(catalog: ProductionCatalog | null) {
  return (catalog?.assets ?? []).filter(a => ['CH', 'GROUP', 'BEAST'].includes(a.type)).flatMap(a => [a.name.split(/[|｜]/)[0], ...a.aliases]);
}
export function prepareEpisodeReception(episode: {number: number; content: string}, catalog: ProductionCatalog | null, resolution?: PreparedStandardEpisode, options: {postColonCue?: boolean;syntax?:StandardScriptSyntax;inlinePerformance?:boolean} = {}) {
  let prepared = resolution ?? prepareStandardEpisode(episode.content, `episode-${episode.number}`, {knownSpeakers: knownScriptSpeakers(catalog), postColonCue: options.postColonCue,syntax:options.syntax,inlinePerformance:options.inlinePerformance});
  // Frozen requests retain the prior delivery grammar, including explicit saved decisions.
  if(resolution&&options.inlinePerformance===false&&prepared.plan.schemaVersion==='STANDARD_SCRIPT_PLAN_V4'&&prepared.compiled){
    const plan={...prepared.plan,schemaVersion:standardScriptPlanVersion(prepared.index,prepared.plan.entries,{inlinePerformance:false})};
    prepared={...prepared,plan,compiled:compileStandardScript(prepared.index,plan)};
  }
  if(prepared.index.text!==episode.content||prepared.index.sourceId!==`episode-${episode.number}`)throw new Error('解析决定与当前集原文不匹配。');
  const diagnostics = [...prepared.diagnostics];
  if (!diagnostics.length && !prepared.compiled?.package.script.entries.some(e => e.target === 'BODY')) diagnostics.push({line: 1, code: 'EMPTY_BODY', message: '只有标题或资料，没有可制作正文。'});
  return {standardScript: diagnostics.length ? null : prepared.compiled?.package ?? null,
    scriptReception: {version: STANDARD_EPISODE_PROTOCOL, ready: diagnostics.length === 0, diagnostics}};
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
