import type { FidelityDecision } from './fidelity-import';

/** Batch boundaries are not scene boundaries. Only explicitly identical adjacent ownership joins. */
export function coalesceFidelityDecisions(_sourceText: string, decisions: readonly FidelityDecision[]): FidelityDecision[] {
  const result: FidelityDecision[] = [];
  for (const decision of [...decisions].sort((a,b)=>a.start-b.start)) {
    const previous=result.at(-1);
    if (previous && previous.end===decision.start && previous.kind===decision.kind
      && previous.episodeNumber===decision.episodeNumber && previous.sceneNumber===decision.sceneNumber
      && (decision.kind==='context' || decision.episodeNumber!==undefined && decision.sceneNumber!==undefined)) {
      previous.end=decision.end;
      if(previous.note!==decision.note)previous.note+='；'+decision.note;
    } else result.push({...decision});
  }
  return result;
}
