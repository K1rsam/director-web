import {projectRetrievalFacts} from './fact-projection.mjs';
import {STANDARD_EPISODE_PROTOCOL} from './standard-source.mjs';
import {EPISODE_EVIDENCE_VERSION} from '../../episode-evidence.mjs';

export const PRODUCTION_CONTEXT_VERSION='production-context-v5';
export const PRODUCTION_CONTEXT_VERSIONS=['production-context-v2','production-context-v3','production-context-v4',PRODUCTION_CONTEXT_VERSION];
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const groups=['current','background','backgroundCandidates','historicalStates','unlinkedBackground','sourceFactIndex'];
const factFields=['id','evidence','subjects','kind','claim','applicability','validity','statement','contextRef','contextRefs','contextEvidence','contextUse'];
const rootFields=['schema','sourceVersion','sourceContextVersion',...groups,'backgroundCandidatesOmitted','unlinkedBackgroundCount','rules'];
const historicalRootFields=[...rootFields,'historicalEvidenceCandidates','historicalEvidenceRejected'];
const episodeEvidence=['domain','episode','start','end'],contextEvidence=['domain','sectionKey','start','end'];
const exactKeys=(value,keys)=>record(value)&&Object.keys(value).every(key=>keys.includes(key));
const knownRange=value=>record(value)&&Number.isSafeInteger(value.start)&&Number.isSafeInteger(value.end)&&value.start>=0&&value.end>=value.start;
const knownEvidence=value=>knownRange(value)&&(value.domain==='EPISODE'
 ?exactKeys(value,episodeEvidence)&&Number.isSafeInteger(value.episode)&&value.episode>=0
 :value.domain==='CONTEXT'&&exactKeys(value,contextEvidence)&&typeof value.sectionKey==='string');
const knownContextEvidence=value=>exactKeys(value,['origin','offsetUnit','verifiedAgainst','excerptRange','coordinateRule'])
 &&knownEvidence(value.origin)&&value.offsetUnit==='UTF16'&&value.verifiedAgainst==='PREVIOUS_EXCERPT'&&typeof value.coordinateRule==='string'
 &&exactKeys(value.excerptRange,['start','end'])&&knownRange(value.excerptRange);
export const knownFact=f=>exactKeys(f,factFields)&&knownEvidence(f.evidence)
 &&exactKeys(f.validity,['status','start','end'])&&['UNKNOWN','EXPLICIT'].includes(f.validity.status)
 &&['start','end'].every(key=>!Object.hasOwn(f.validity,key)||Number.isSafeInteger(f.validity[key]))
 &&typeof f.id==='string'&&Array.isArray(f.subjects)&&f.subjects.every(s=>typeof s==='string')
 &&['IDENTITY','RELATION','STATE','SETTING','UTTERANCE','CONTEXT','FORMAT'].includes(f.kind)&&['SOURCE','CHARACTER_CLAIM'].includes(f.claim)&&['GLOBAL','SUBJECT','UNRESOLVED'].includes(f.applicability)
 &&(!Object.hasOwn(f,'statement')||typeof f.statement==='string')
 &&(!Object.hasOwn(f,'contextRef')||typeof f.contextRef==='string')&&(!Object.hasOwn(f,'contextRefs')||Array.isArray(f.contextRefs)&&f.contextRefs.every(ref=>typeof ref==='string'))
 &&!(Object.hasOwn(f,'contextRef')&&Object.hasOwn(f,'contextRefs'))
 &&(!Object.hasOwn(f,'contextEvidence')||knownContextEvidence(f.contextEvidence))
 &&(!Object.hasOwn(f,'contextUse')||exactKeys(f.contextUse,['kind','episode','heading'])&&f.contextUse.kind==='EPISODE_OUTLINE'&&Number.isSafeInteger(f.contextUse.episode)&&f.contextUse.episode>0&&exactKeys(f.contextUse.heading,['quote','start','end'])&&knownRange(f.contextUse.heading)&&typeof f.contextUse.heading.quote==='string'&&f.contextUse.heading.end-f.contextUse.heading.start===f.contextUse.heading.quote.length);
export const knownHistorical=f=>{
 if(!record(f))return false;
 const {candidateUse,currentApplicability,retrieval,...base}=f;
 return knownFact(base)&&candidateUse==='HISTORICAL_EVIDENCE_ONLY'&&currentApplicability==='UNKNOWN'
  &&exactKeys(retrieval,['mode','anchorFactIds'])&&['SUBJECT_MENTION','SOURCE_NEIGHBOUR'].includes(retrieval.mode)
  &&Array.isArray(retrieval.anchorFactIds)&&retrieval.anchorFactIds.length>0&&retrieval.anchorFactIds.every(id=>typeof id==='string'&&id.length>0);
};

/** Wire-only, reversible table: no evidence is selected, summarized or promoted. */
export function projectHistoricalCandidates(facts){
 const candidates=facts?.historicalEvidenceCandidates;
 if(!record(facts)||facts.schema!=='FOUNDATION_FACTS_V1'
  ||!exactKeys(facts,[...historicalRootFields,'format','columns','interpretation','rows','groups'])
  ||Object.hasOwn(facts,'format')&&facts.format!=='STORYBOARD_FACT_TABLE_V1'
  ||['sourceVersion','sourceContextVersion','rules'].some(key=>Object.hasOwn(facts,key)&&typeof facts[key]!=='string')
  ||!Array.isArray(candidates)||!candidates.length||!candidates.every(knownHistorical))return facts;
 const fields=[...new Set(candidates.flatMap(f=>Object.keys(f)))],shared={},columns=[];
 for(const key of fields){
  const first=candidates[0][key];
  if(candidates.every(f=>Object.hasOwn(f,key)&&JSON.stringify(f[key])===JSON.stringify(first)))shared[key]=structuredClone(first);
  else columns.push(key);
 }
 const table={format:'HISTORICAL_EVIDENCE_TABLE_V4',columns,shared,
  interpretation:'每行按columns读取，再并入shared；null只表示该字段缺省。所有行仍是历史证据候选，UNKNOWN不等于当前事实；保留逐条来源、角色说法、有效期和检索锚点，不自动继承。',
  rows:candidates.map(f=>columns.map(key=>Object.hasOwn(f,key)?structuredClone(f[key]):null))};
 if(JSON.stringify(table).length>=JSON.stringify(candidates).length)return facts;
 return {...facts,historicalEvidenceCandidates:table};
}
const blank=row=>typeof row.text==='string'&&!row.text.trim();
const removableBlanks=source=>{const factRefs=new Set(source.entryFacts.flatMap(f=>f.sourceRefs));return new Set([...source.sourceRows,...source.contextRows].filter(row=>blank(row)&&!factRefs.has(row.id)).map(row=>row.id));};

function projectFacts(facts,source,contextRows,historical=false){
 // Unknown shapes can contain their own id links or evidence semantics. Keep the old lossless projection.
 if(!record(facts)||facts.schema!=='FOUNDATION_FACTS_V1'||!exactKeys(facts,historical?historicalRootFields:rootFields)
  ||['sourceVersion','sourceContextVersion','rules'].some(key=>Object.hasOwn(facts,key)&&typeof facts[key]!=='string')
  ||['backgroundCandidatesOmitted','unlinkedBackgroundCount'].some(key=>Object.hasOwn(facts,key)&&(!Number.isSafeInteger(facts[key])||facts[key]<0))
  ||groups.some(key=>Object.hasOwn(facts,key)&&(!Array.isArray(facts[key])||!facts[key].every(knownFact)))
  ||historical&&Object.hasOwn(facts,'historicalEvidenceCandidates')&&(!Array.isArray(facts.historicalEvidenceCandidates)||!facts.historicalEvidenceCandidates.every(knownHistorical))
  ||historical&&Object.hasOwn(facts,'historicalEvidenceRejected')&&(!Number.isSafeInteger(facts.historicalEvidenceRejected)||facts.historicalEvidenceRejected<0))return projectRetrievalFacts(facts);
 const next=structuredClone(facts),pkg=source.standardPackage;
 // Candidate metadata stays intact; new tasks may quote the same bound readable source once.
 // Preserve addressable IDs; a linked index is not redundant even when its text is present.
 const candidates=historical?facts.historicalEvidenceCandidates??[]:[],linkedIds=new Set(candidates.flatMap(f=>f.retrieval.anchorFactIds));
 // A verified complete package proves coordinates, but only rows sent in this request prove redundancy.
 const episode=source.sourceProtocol===STANDARD_EPISODE_PROTOCOL&&/^episode-(0|[1-9]\d*)$/.exec(pkg?.binding?.sourceId??'');
 const text=episode&&Array.isArray(pkg.evidence)?pkg.evidence.map(unit=>unit.text).join(''):null;
 const sentRanges=text===null?[]:source.sourceRows.filter(row=>!blank(row)).flatMap(row=>{
  const start=pkg.evidence[row.line-1]?.start,end=start+row.text.length;
  return Number.isSafeInteger(start)&&text.slice(start,end)===row.text?[[start,end]]:[];
 });
 const mechanical=f=>exactKeys(f,['id','evidence','subjects','kind','claim','applicability','validity','statement'])
  &&f.validity.status==='UNKNOWN'&&Object.keys(f.validity).length===1&&f.evidence.domain==='EPISODE'
  &&text!==null&&f.evidence.episode===Number(episode[1])&&Number.isSafeInteger(f.evidence.start)&&Number.isSafeInteger(f.evidence.end)
  &&f.evidence.start>=0&&f.evidence.end>f.evidence.start&&f.evidence.end<=text.length
  &&sentRanges.some(([start,end])=>start<=f.evidence.start&&end>=f.evidence.end)
  &&(f.statement===undefined||f.statement===text.slice(f.evidence.start,f.evidence.end));
 const rows=new Map(contextRows.map(row=>[row.id,row.text]));
 const originalRows=new Map(source.contextRows.map(row=>[row.id,row]));
 const boundHistoricalQuote=f=>{
  if(source.context?.episodeEvidenceVersion!==EPISODE_EVIDENCE_VERSION||typeof f.statement!=='string'||f.evidence.domain!=='EPISODE')return false;
  const refs=typeof f.contextRef==='string'?[f.contextRef]:Array.isArray(f.contextRefs)?f.contextRefs:[];
  if(!refs.length||refs.some(ref=>!rows.has(ref))||refs.map(ref=>rows.get(ref)).join('')!==f.statement)return false;
  let offset=f.evidence.start;
  for(const ref of refs){
   const provenance=originalRows.get(ref)?.provenance,origin=provenance?.origin;
   if(provenance?.offsetUnit!=='UTF16'||!knownEvidence(origin)||origin.domain!=='EPISODE'
    ||origin.episode!==f.evidence.episode||origin.start!==offset||origin.end-origin.start!==rows.get(ref).length)return false;
   offset=origin.end;
  }
  return offset===f.evidence.end;
 };
 for(const group of groups){
  if(!Array.isArray(next[group]))continue;
  next[group]=next[group].filter(f=>!(['current','sourceFactIndex'].includes(group)&&!linkedIds.has(f.id)&&mechanical(f))).map(f=>{
   const refs=typeof f.contextRef==='string'?[f.contextRef]:Array.isArray(f.contextRefs)?f.contextRefs:[];
   if(typeof f.statement==='string'&&refs.length&&refs.every(ref=>typeof ref==='string'&&rows.has(ref))&&refs.map(ref=>rows.get(ref)).join('')===f.statement){const {statement,...rest}=f;return rest;}
   return f;
  });
  if(!next[group].length)delete next[group];
 }
 if(historical&&Array.isArray(next.historicalEvidenceCandidates))next.historicalEvidenceCandidates=next.historicalEvidenceCandidates.map(f=>{
  if(!boundHistoricalQuote(f))return f;
  const {statement,...fact}=f;return fact;
 });
 delete next.sourceVersion;delete next.sourceContextVersion;
 for(const key of ['backgroundCandidatesOmitted','unlinkedBackgroundCount'])if(next[key]===0)delete next[key];
 const projected=projectRetrievalFacts(next);
 if(candidates.length)return projected;
 if(projected?.format==='STORYBOARD_FACT_TABLE_V1'){
  const {schema,...table}=projected;
  return {...table,format:'PRODUCTION_FACT_TABLE_V2',columns:table.columns.slice(1),rows:table.rows.map(row=>row.slice(1))};
 }
 for(const group of groups)if(Array.isArray(next[group]))next[group]=next[group].map(({id,...fact})=>fact);
 return next;
}

const replacedRules={
 retrievalFactsRule:'retrievalFacts是带来源的检索证据，不是已语义确认的入口事实；角色主张、历史状态与未关联背景须核对本集适用性，不直接转成entryFacts。',
 upstreamMaterialRule:'全剧方向与采用设计只约束表达和制作，不是剧情证据；原文事实、台词及揭示时点优先。references只提供参考说明，未读取图像像素；没有图片不冒充已完成素材。',
 contextEvidenceRule:'本集证据使用sourceRows及sourceRefs，不重复抄到contextRows；已有前场原句复用原contextRef。新增背景/历史contextRows保留精确原文和UTF16来源坐标；仅确实匹配前场原文的EPISODE内容可作来源依据，仍不自动继承当前状态。其余背景、历史片段和指导以guidance供理解/contextRefs引用，不能自证entryFacts。'
};
export function projectSourceRow(row,projectionVersion){
 const {id,text,kind}=row;
 return {id,text,kind,...(projectionVersion===PRODUCTION_CONTEXT_VERSION&&Object.hasOwn(row,'evidenceRole')?{evidenceRole:row.evidenceRole}:{})};
}
export function projectProductionSource(source,projectionVersion=PRODUCTION_CONTEXT_VERSION){
 const omitted=removableBlanks(source),rows=list=>list.filter(row=>!omitted.has(row.id)).map(row=>projectSourceRow(row,projectionVersion));
 const sourceRows=rows(source.sourceRows),contextRows=rows(source.contextRows);
 let context=source.context;
 if(record(context)){
  context={...context};
  for(const key of ['documentRevision','sourceVersion','sourceContextVersion'])if(context[key]===null||['string','number'].includes(typeof context[key]))delete context[key];
  for(const key of ['followUps','sourceWarnings','materialDependencies','confirmedDecisions','modelDesigns'])if(Array.isArray(context[key])&&!context[key].length)delete context[key];
  if(context.directorNotes==='')delete context.directorNotes;
  if(context.seriesDirection===null)delete context.seriesDirection;
  if(Array.isArray(context.modelDesigns))context.modelDesigns=context.modelDesigns.map(design=>{if(!record(design)||!Number.isSafeInteger(design.adoptionVersion))return design;const {adoptionVersion,...material}=design;return material;});
  if(Object.hasOwn(context,'retrievalFacts')){
   context.retrievalFacts=projectFacts(context.retrievalFacts,source,contextRows,['production-context-v3','production-context-v4',PRODUCTION_CONTEXT_VERSION].includes(projectionVersion));
   if(['production-context-v4',PRODUCTION_CONTEXT_VERSION].includes(projectionVersion))context.retrievalFacts=projectHistoricalCandidates(context.retrievalFacts);
  }
  for(const [key,value] of Object.entries(replacedRules))if(context[key]===value)delete context[key];
  if(!Object.hasOwn(context,'materialEvidenceRule'))context.materialEvidenceRule='原文事实、台词和揭示时点优先。全剧方向/采用设计只约束表达制作，参考说明不代表读过图像。事实表是检索线索，角色主张、历史和背景须核实适用性；guidance不能自证entryFacts。省略的机械索引查原文；省略statement仅当已给contextRef/contextRefs逐字承载它。';
 }
 return {key:source.key,title:source.title,context,sourceRows,contextRows,
  dialogue:source.dialogue.map(({id,rowId,speaker,quote,cue,kind,channel,performanceCues})=>({id,rowId,speaker,quote,cue,kind,channel,...(performanceCues?{performanceCues}:{})})),...(source.onscreenTexts?{onscreenTexts:source.onscreenTexts}:{}),entryFacts:source.entryFacts,assets:source.assets};
}

/** Only blank layout references disappear from the model view; canonical plans and package scope are unchanged. */
export function projectProductionPlan(plan,source){
 if(!plan)return plan;
 const blanks=removableBlanks(source);
 const item=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Array.isArray(value)&&['sourceRefs','contextRefs','anchorRefs'].includes(key)?value.filter(id=>!blanks.has(id)):Array.isArray(value)&&['beatContracts','eventSegments'].includes(key)?value.map(item):value]));
 return Object.fromEntries(Object.entries(plan).map(([key,value])=>[key,['workPackages','provisionalUnits','events','fantasyCandidates'].includes(key)&&Array.isArray(value)?value.map(item):value]));
}
