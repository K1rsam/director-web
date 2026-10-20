import {digest} from './storyboard-v4/core/shared.mjs';
import {PRODUCTION_SUPPLY_VERSION,sourceRange} from './production-supply.mjs';

/** The canonical script and approved direction are hard inputs; asset supplements are not. */
export function splitProductionMaterials(prepared){
 const source=structuredClone(prepared.source),context=source.context||{};
 const cards=context.assetProductionCards||[],designs=context.modelDesigns||[];
 const materials=[...cards.map(card=>{const {candidateDesign,candidateDesigns,...base}=card;return {id:`asset:${card.assetKey}`,kind:'ASSET_PRODUCTION_CARD',value:base};}),
  ...designs.filter(d=>!cards.some(c=>c.assetKey===d.assetKey)).map(design=>({id:`asset:${design.assetKey}`,kind:'ADOPTED_DESIGN',value:design}))]
  .map(m=>({...m,version:digest(m.value)}));
 const scopedCandidates=new Map();
 for(const card of cards)for(const candidate of card.candidateDesigns??(card.candidateDesign?[card.candidateDesign]:[]))for(const need of candidate.needs){
  const value={...candidate,needs:[need]},id=`candidate:${card.assetKey}:${digest({scope:candidate.scope,needs:[need.needRef]}).slice(0,16)}`;
  scopedCandidates.set(id,{id,kind:'ASSET_MATERIAL_CANDIDATE',assetKey:card.assetKey,packageIds:[...new Set(need.packageIds)],value:structuredClone(value),version:digest(value)});
 }
 materials.push(...scopedCandidates.values());
 delete context.assetProductionCards;delete context.modelDesigns;
 // Changing audit counters or filling an unrelated design never changes the hard source basis.
 const sourceBasisVersion=digest({key:source.key,sourceRows:source.sourceRows,dialogue:source.dialogue,
  standardPackage:source.standardPackage??null,visualStyle:prepared.visualStyle,
  direction:context.seriesDirection??null,seriesKnowledge:context.seriesKnowledge??[],entryFacts:source.entryFacts??[],confirmedDecisions:context.confirmedDecisions??[]});
 const contextEvidence=Object.fromEntries((source.contextRows||[]).map(row=>[row.id,digest({text:row.text,kind:row.kind,evidenceRole:row.evidenceRole})]));
 return {...prepared,source,sourceBasisVersion,contextEvidence,materials};
}

export function sourceEvidenceCompatible(saved,current){
 // Added evidence can be consumed by a later new task. Previously supplied source
 // evidence cannot silently disappear or change underneath an existing request.
 return Object.entries(saved||{}).every(([id,hash])=>current?.[id]===hash);
}

export function selectProductionMaterials(materials,stage,plan,packageIds=[],activeNeeds=[],source=null,supplyVersion=null){
 // The episode projection already excludes future/out-of-scope identities. Once the planner
 // declares actual use, later jobs receive that subset plus explicit unmet material needs.
 let selected=(materials||[]).filter(m=>m.kind!=='ASSET_MATERIAL_CANDIDATE'||m.packageIds.some(id=>packageIds.includes(id)));
 if(stage!=='plan'&&source?.context?.episodeEvidenceVersion==='episode-evidence-v1')selected=selected.filter(m=>m.kind!=='SOURCE_EVIDENCE'
  ||!Array.isArray(m.packageIds)||!m.packageIds.length||m.packageIds.some(id=>packageIds.includes(id)));
 const receipt=plan?.productionFeedback;
 if(stage!=='plan'&&receipt){
  const scopedNeeds=[...(receipt.needs||[]),...activeNeeds].filter(n=>!n.packageIds?.length||n.packageIds.some(id=>packageIds.includes(id)));
  const needs=scopedNeeds.filter(n=>n.stage===2);
  const historyNeeds=source?.context?.episodeEvidenceVersion==='episode-evidence-v1'?scopedNeeds.filter(n=>n.stage===1&&n.target.startsWith('HISTORY_SOURCE:')):[];
  const ids=new Set([...(receipt.usedMaterialIds||[]),...needs.map(n=>`asset:${n.target}`),...historyNeeds.map(n=>`history:${n.target}`)]);
  for(const candidate of selected.filter(m=>m.kind==='ASSET_MATERIAL_CANDIDATE'&&ids.has(m.id)))ids.add(`asset:${candidate.assetKey}`);
  selected=selected.filter(m=>m.kind==='ASSET_MATERIAL_CANDIDATE'
   ?m.packageIds.some(id=>packageIds.includes(id))&&(ids.has(m.id)||ids.has(`asset:${m.assetKey}`))
   :ids.has(m.id));
 }
 if(supplyVersion===PRODUCTION_SUPPLY_VERSION&&source){
  const needs=[...(receipt?.needs||[]),...activeNeeds].filter(n=>n.stage===2&&(!n.packageIds?.length||n.packageIds.some(id=>packageIds.includes(id))));
  const needed=new Set(needs.map(n=>`asset:${n.target}`)),scenes=new Set(source.context?.scenes?.map(s=>s.sceneKey)||[]);
  const referenced=new Set((source.assets||[]).flatMap(a=>[a.key,...(a.variants||[]).map(v=>v.key)]).filter(Boolean).map(key=>`asset:${key}`));
  selected=selected.filter(m=>stage==='plan'||needed.has(m.id)||referenced.has(m.id)||m.kind!=='ASSET_PRODUCTION_CARD'||m.value?.schema!=='ASSET_PRODUCTION_CARD_V1'||!Array.isArray(m.value.applicable?.sceneKeys)||!m.value.applicable.sceneKeys.length||!scenes.size||m.value.applicable.sceneKeys.some(id=>scenes.has(id)));
  selected=selected.map(m=>projectMaterialForConsumer(m,source));
 }
 return structuredClone(selected);
}
function mechanicalIndex(f,card,source){
 const e=f?.evidence,pkg=source?.standardPackage;
 const text=Array.isArray(pkg?.evidence)?pkg.evidence.map(row=>row.text).join(''):null;
 if(!f||Object.keys(f).some(k=>!['id','claim','quote','association','evidence'].includes(k))||typeof f.id!=='string'||!f.id||typeof f.quote!=='string'||!f.quote
  ||!['ASSET_NAME','SCENE_ACTION'].includes(f.association)||!['SOURCE','CHARACTER_CLAIM'].includes(f.claim)||!e||Object.keys(e).some(k=>!['domain','episode','start','end'].includes(k))
  ||e.domain!=='EPISODE'||e.episode!==card.applicable?.episode||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end-e.start!==f.quote.length||text===null||text.slice(e.start,e.end)!==f.quote)return false;
 // Prove the existing standard node's authority, not merely that the words occur somewhere.
 const units=new Map(pkg.evidence.map(unit=>[unit.id,unit]));
 return pkg.script?.entries?.some(node=>{
  const selected=node.sourceUnitIds?.map(id=>units.get(id));
  return selected?.length&&selected.every(Boolean)&&selected[0].start<=e.start&&selected.at(-1).end>=e.end&&node.target==='BODY'
   &&(f.claim==='SOURCE'?node.kind==='ACTION':['DIALOGUE','DIALOGUE_GROUP'].includes(node.kind));
 })===true;
}
export function projectMaterialForConsumer(material,source){
 if(material?.kind!=='ASSET_PRODUCTION_CARD'||material.value?.schema!=='ASSET_PRODUCTION_CARD_V1'||!Array.isArray(material.value.sourceFacts))return structuredClone(material);
 const value=structuredClone(material.value);
 value.sourceFacts=value.sourceFacts.filter(f=>!mechanicalIndex(f,value,source)||[...source.sourceRows,...source.contextRows].some(row=>{
  const range=sourceRange(source,row);return range&&range.start<f.evidence.end&&f.evidence.start<range.end;
 }));
 return {...structuredClone(material),value,version:digest(value)};
}
function alreadyReadQuoteIndex(old,next,source){
 if(old?.kind!=='ASSET_PRODUCTION_CARD'||next?.kind!==old.kind||old.value?.schema!=='ASSET_PRODUCTION_CARD_V1'||next.value?.schema!==old.value.schema)return false;
 const {sourceFacts:before,...oldCard}=old.value,{sourceFacts:after,...nextCard}=next.value;
 if(!Array.isArray(before)||!Array.isArray(after)||digest(oldCard)!==digest(nextCard)||!Array.isArray(source?.sourceRows))return false;
 const facts=new Map(after.map(f=>[f?.id,f]));
 if(facts.size!==after.length||before.some(f=>!facts.has(f?.id)||digest(facts.get(f.id))!==digest(f)))return false;
 const oldIds=new Set(before.map(f=>f.id));
 return after.filter(f=>!oldIds.has(f?.id)).every(f=>{
  const e=f?.evidence;
  if(!f||Object.keys(f).some(k=>!['id','claim','quote','association','evidence'].includes(k))||typeof f.id!=='string'||!f.id
   ||typeof f.quote!=='string'||!f.quote||!['ASSET_NAME','SCENE_ACTION'].includes(f.association)||!['SOURCE','CHARACTER_CLAIM'].includes(f.claim)
   ||!e||Object.keys(e).some(k=>!['domain','episode','start','end'].includes(k))||e.domain!=='EPISODE'||e.episode!==next.value.applicable?.episode
   ||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end-e.start!==f.quote.length)return false;
  // Only full, actually sent script rows with the same authority qualify. Not
  // newly supplied design, future/off-scope quotes, context or extracted facts.
  return source.sourceRows.some(row=>row.text===f.quote&&row.kind===(f.claim==='SOURCE'?'action':'dialogue'));
 });
}
export function changedConsumedMaterials(oldSnapshot,current,usedIds,readSource=null,supplyVersion=null){
 if(supplyVersion===PRODUCTION_SUPPLY_VERSION&&readSource){
  oldSnapshot=(oldSnapshot||[]).map(m=>projectMaterialForConsumer(m,readSource));current=(current||[]).map(m=>projectMaterialForConsumer(m,readSource));
  // Current-episode source read as explicit entry context is equally readable.
  // Previous-episode, guidance and unverified context still cannot prove this.
  readSource={...readSource,sourceRows:[...readSource.sourceRows,...readSource.contextRows.filter(row=>sourceRange(readSource,row)&&['action','dialogue'].includes(row.kind)&&row.evidenceRole!=='guidance')]};
 }
 const old=new Map((oldSnapshot||[]).map(m=>[m.id,m])),next=new Map((current||[]).map(m=>[m.id,m]));
 return (usedIds||[]).filter(id=>old.get(id)?.version!==next.get(id)?.version&&!alreadyReadQuoteIndex(old.get(id),next.get(id),readSource));
}
export function materialChangeCoordinates(oldSnapshot,current,usedIds,readSource=null,supplyVersion=null){
 const changed=changedConsumedMaterials(oldSnapshot,current,usedIds,readSource,supplyVersion);
 const project=m=>supplyVersion===PRODUCTION_SUPPLY_VERSION&&readSource?projectMaterialForConsumer(m,readSource):m;
 const old=new Map((oldSnapshot||[]).map(m=>[m.id,project(m)])),next=new Map((current||[]).map(m=>[m.id,project(m)]));
 const fields=(a,b,path)=>{
  if(digest(a??null)===digest(b??null))return [];
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b))return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(key=>fields(a[key],b[key],`${path}.${key}`));
  return [path];
 };
 return changed.flatMap(id=>{
  const before=old.get(id),after=next.get(id),paths=[...(before?.kind!==after?.kind?['kind']:[]),...fields(before?.value,after?.value,'value')];
  return (paths.length?paths:['version']).map(field=>`${id}/${field}`);
 });
}
