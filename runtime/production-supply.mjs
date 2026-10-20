// New requests opt in. Frozen paid requests retain their original input contract.
export const PRODUCTION_SUPPLY_VERSION='production-supply-v1';
import {knownFact,knownHistorical} from './storyboard-v4/core/production-context-projection.mjs';
import {EPISODE_EVIDENCE_VERSION,EPISODE_HISTORY_POLICY_VERSION,selectEpisodeEvidence} from './episode-evidence.mjs';
import {STANDARD_EPISODE_PROTOCOL} from './storyboard-v4/core/standard-source.mjs';
const record=x=>x&&typeof x==='object'&&!Array.isArray(x);
const groups=['current','background','backgroundCandidates','historicalStates','historicalEvidenceCandidates','unlinkedBackground','sourceFactIndex'];
const factRefs=f=>[...(typeof f.contextRef==='string'?[f.contextRef]:[]),...(Array.isArray(f.contextRefs)?f.contextRefs:[])];
export function sourceRange(source,row){
 const unit=source.standardPackage?.evidence?.[row.line-1];
 return unit&&unit.text===row.text&&Number.isSafeInteger(unit.start)?{start:unit.start,end:unit.start+row.text.length}:null;
}
const overlaps=(a,b)=>a.start<b.end&&b.start<a.end;
/** Planner reads relevant episode evidence once. Authors consume its explicit evidence
 * selections, state/release evidence, global direction and their own scene, not its whole library. */
export function scopeProductionSource(source,{fullSource=source,stage='plan',plan=null,episodeEvidenceVersion=null,historyPolicy=null}={}){
 const next=structuredClone(source),context=next.context;
 if(!record(context)||context.independentFragment)return next;
 const episode=Number(/^episode-(\d+)$/.exec(fullSource.standardPackage?.binding?.sourceId??'')?.[1]??context.episodeNumber);
 const selected=new Set(plan?.workPackages?.flatMap(w=>w.contextRefs)||[]);
 for(const f of next.entryFacts||[])for(const ref of f.sourceRefs||[])selected.add(ref);
 const currentRanges=next.sourceRows.map(row=>sourceRange(fullSource,row)).filter(Boolean);
 const eventScenes=new Set(plan?.events?.map(e=>e.sceneKey)||[]);
 const mappedEvents=context.scenes?.some(s=>eventScenes.has(s.sceneKey));
 if(stage!=='plan'&&Array.isArray(context.scenes))context.scenes=context.scenes.filter(scene=>{
  if(!record(scene)||!scene.sceneKey||eventScenes.has(scene.sceneKey))return true;
  if(!record(scene.sourceRange))return !mappedEvents;
  return !currentRanges.length||currentRanges.some(range=>overlaps(range,scene.sourceRange));
 });
 const sceneKeys=new Set(context.scenes?.map(s=>s.sceneKey)||[]);
 const localText=next.sourceRows.map(row=>row.text).join('');
 // Empty/unknown appearance ranges remain open; a missing range is not absence.
 if(stage!=='plan'&&Array.isArray(next.assets)&&sceneKeys.size)next.assets=next.assets.filter(a=>!Array.isArray(a.sceneRefs)||!a.sceneRefs.length||a.sceneRefs.some(ref=>sceneKeys.has(ref.sceneKey))
  ||[a.name,...(a.aliases||[])].some(name=>typeof name==='string'&&localText.includes(name.split(/[|｜]/)[0])));
 const names=new Set(next.dialogue.map(q=>q.speaker));
 for(const asset of next.assets||[])for(const name of [asset.name,...(asset.aliases||[])])if(typeof name==='string')names.add(name.split(/[|｜]/)[0]);
 for(const w of plan?.workPackages||[])for(const name of (w.emotionContract?.subject||'').split(/[、，,\/]/))if(name)names.add(name);
 const facts=context.retrievalFacts;
 const keys=['schema','sourceVersion','sourceContextVersion',...groups,'historicalEvidenceRejected','backgroundCandidatesOmitted','unlinkedBackgroundCount','rules'];
 const safe=record(facts)&&facts.schema==='FOUNDATION_FACTS_V1'&&Object.keys(facts).every(k=>keys.includes(k))&&groups.every(k=>!Object.hasOwn(facts,k)||Array.isArray(facts[k])&&facts[k].every(k==='historicalEvidenceCandidates'?knownHistorical:knownFact));
 if(!safe)return next; // Unknown evidence/links stay conservative and complete.
 const matches=f=>!f.subjects.length||f.subjects.some(name=>names.has(name));
 const origins=[...next.sourceRows,...next.contextRows.filter(row=>selected.has(row.id))].flatMap(row=>row.provenance?.origin?[row.provenance.origin]:[]);
 const read=f=>factRefs(f).some(ref=>selected.has(ref))||origins.some(origin=>origin.domain===f.evidence.domain&&origin.episode===f.evidence.episode&&origin.sectionKey===f.evidence.sectionKey&&overlaps(origin,f.evidence));
 const keepHistorical=f=>read(f)||['STATE','IDENTITY','RELATION'].includes(f.kind)&&matches(f);
 const history=facts.historicalEvidenceCandidates||[];
 const episodeSelection=episodeEvidenceVersion===EPISODE_EVIDENCE_VERSION&&Number.isSafeInteger(episode)
  ?selectEpisodeEvidence(history,{scope:[episode],relevant:matches,requestedEvidence:history.filter(read).map(f=>f.evidence),historyPolicy}):null;
 const focused=historyPolicy===EPISODE_HISTORY_POLICY_VERSION&&Boolean(episodeSelection);
 const kept=new Set(history.filter(f=>episodeSelection&&f.evidence.domain==='EPISODE'
  ?episodeSelection.kept.has(f.id):keepHistorical(f)).map(f=>f.id));
 // Keep release/counterclaim neighbours and their anchor links intact; no latest-state collapse.
 let previousSize;
 do{
  previousSize=kept.size;
  if(!focused)for(const f of history)if(kept.has(f.id)||(!episodeSelection&&f.retrieval.mode==='SOURCE_NEIGHBOUR'&&f.retrieval.anchorFactIds.some(id=>kept.has(id)))){kept.add(f.id);for(const id of f.retrieval.anchorFactIds)kept.add(id);}
 }while(kept.size!==previousSize);
 const allRefs=new Set(groups.flatMap(k=>(facts[k]||[]).flatMap(factRefs)));
 for(const group of groups){
  if(!Array.isArray(facts[group]))continue;
  facts[group]=facts[group].filter(f=>{
   if(f.contextUse?.kind==='EPISODE_OUTLINE'&&Number.isSafeInteger(episode)&&f.contextUse.episode!==episode)return false;
   if(group==='historicalEvidenceCandidates'&&episodeSelection)return kept.has(f.id)&&(!Number.isSafeInteger(f.evidence.episode)||f.evidence.episode<episode);
   if(stage==='plan')return true;
   if(['current','sourceFactIndex'].includes(group))return !currentRanges.length||f.evidence.domain!=='EPISODE'||f.evidence.episode!==episode||currentRanges.some(range=>overlaps(range,f.evidence))||read(f);
   if(group==='historicalEvidenceCandidates')return kept.has(f.id);
   if(group==='historicalStates')return keepHistorical(f);
   return f.applicability==='GLOBAL'||matches(f)||read(f);
  });
  // New request-local retrieval edges must not close over the old broad recall
  // graph and reintroduce every omitted sentence. Source IDs/claims stay intact.
  if(focused&&group==='historicalEvidenceCandidates')facts[group]=facts[group].map(f=>({...f,retrieval:episodeSelection.anchors.has(f.id)
   ?{mode:'SUBJECT_MENTION',anchorFactIds:[f.id]}:{mode:'SOURCE_NEIGHBOUR',anchorFactIds:episodeSelection.neighbours.get(f.id)}}));
  for(const f of facts[group])for(const ref of factRefs(f))selected.add(ref);
 }
 const historyOrigins=[...(facts.historicalStates||[]),...(facts.historicalEvidenceCandidates||[])].map(f=>f.evidence);
 // Canonical standard annotations are required by source proof, independent of historical retrieval.
 const standardNotes=new Set(next.sourceProtocol===STANDARD_EPISODE_PROTOCOL?(next.standardPackage?.annotations||[]).map(note=>`${next.key}:${note.id}`):[]);
 next.contextRows=next.contextRows.filter(row=>{
  if(selected.has(row.id)||standardNotes.has(row.id))return true;
  if(allRefs.has(row.id))return false;
  if(stage==='plan'&&!episodeSelection)return true;
  const currentRange=sourceRange(fullSource,row);
  if(currentRange&&row.evidenceRole==='guidance'&&context.scenes?.every(s=>s.sourceRange))return context.scenes.some(s=>overlaps(currentRange,s.sourceRange));
  const origin=row.provenance?.origin;
  if(!origin)return true; // Explicit/legacy unknown context must not be guessed away.
  return historyOrigins.some(e=>e.domain===origin.domain&&e.episode===origin.episode&&e.sectionKey===origin.sectionKey&&overlaps(e,origin));
 });
 // Scene-bound annotations are readable even when not selected by a model.
 if(stage!=='plan')for(const row of fullSource.sourceRows){
  const range=sourceRange(fullSource,row);
  if(row.evidenceRole==='guidance'&&range&&context.scenes?.some(s=>s.sourceRange&&overlaps(range,s.sourceRange))&&!next.sourceRows.some(s=>s.id===row.id)&&!next.contextRows.some(s=>s.id===row.id))next.contextRows.push(structuredClone(row));
 }
 return next;
}
