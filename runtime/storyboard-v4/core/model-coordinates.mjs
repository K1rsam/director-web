import {digest,fail} from './shared.mjs';

export const MODEL_COORDINATE_VERSION='model-coordinates-v1';
const machineKeys=new Set(['id','rowId','lineId','eventId','packageId','packageIds','candidateId','candidateIds','unitId','unitIds','shotId','shotIds','retainedUnitIds','replaces','dependsOn','selectedIds','selectedFantasyIds','provisionalUnitIds','usedMaterialIds','sourceRefs','contextRefs','anchorRefs','contextRef','sourceIds','sourceUnitIds','anchorFactIds','entryFactIds','sectionKey','sourceTextHash','sourceVersion','sourceContextVersion','versionId','baseDraftHash']);
const proseKeys=new Set(['text','quote','cue','speaker','statement','rawText','description','proposal','suggestedProposal','userLockedProposal']);
const responseKeys=new Set([...machineKeys,'target','coordinate']);
const factColumns=['id','evidence','subjects','kind','claim','applicability','validity','statement?','extra?'];
const nodeKeys=['id','target','kind','sourceUnitIds','sourceRange','startLine','endLine'];
const HINT='【无损机器编号】R加四位数字是本请求内稳定编号的等值短名，输出坐标严格使用schema中的编号；系统按本次保存映射恢复原编号，不改原句、证据、主张或制作范围。正文不写机器编号。{"$boundaryNodes":{"columns":[...],"rows":[...]}}逐列对应原承接节点对象，保留顺序及全部字段，不是摘要。{"$jsonOf":"#/路径"}表示该路径对象的完整JSON文本，仅省去格式空白及重复序列化；原始回包仍保留。';
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const validTree=v=>v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v)
 ||Array.isArray(v)&&Object.keys(v).length===v.length&&v.every(validTree)
 ||record(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Object.entries(v).every(([k,x])=>!['$boundaryNodes','$jsonOf','__proto__'].includes(k)&&validTree(x));

// Removing only JSON token-separating whitespace also rejects duplicate keys,
// alternate escapes and any other raw/parsed difference. String whitespace stays literal.
function withoutJSONWhitespace(raw){
 let compact='',quoted=false,escaped=false;
 for(const char of raw){
  if(quoted){compact+=char;if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}
  else if(char==='"'){quoted=true;compact+=char;}
  else if(!/[ \t\r\n]/.test(char))compact+=char;
 }
 return compact;
}

/** Model-only spelling change. Canonical source, semantic payload and saved old requests stay intact. */
export function projectModelCoordinates(input,schema,{includeContinuityNodes=false}={}){
 const unchanged={input,schema,coordinates:null,hint:''};
 if(!validTree(input)||!validTree(schema)||/R\d{4}/.test(JSON.stringify(input)))return unchanged;
 const duplicatePlan=record(input.previousDraft?.previousPlan)&&typeof input.previousDraft.rawText==='string'
  &&withoutJSONWhitespace(input.previousDraft.rawText)===JSON.stringify(input.previousDraft.previousPlan);
 const unknownRaw=(v,pointer='#')=>{
  if(!v||typeof v!=='object')return false;
  return Object.entries(v).some(([key,value])=>key==='rawText'&&typeof value==='string'
   ?!(pointer==='#/previousDraft'&&duplicatePlan):unknownRaw(value,pointer+'/'+key));
 };
 // Raw-only and nested repair strings have no addressable parsed object. Keep
 // canonical IDs throughout that request instead of mixing opaque namespaces.
 if(unknownRaw(input))return unchanged;
 const protectedText=new Set();
 const table=v=>record(v)&&['STORYBOARD_FACT_TABLE_V1','PRODUCTION_FACT_TABLE_V2'].includes(v.format)
  &&Array.isArray(v.columns)&&JSON.stringify(v.columns)===JSON.stringify(v.format==='STORYBOARD_FACT_TABLE_V1'?factColumns:factColumns.slice(1))
  &&Array.isArray(v.rows)&&v.rows.every(row=>Array.isArray(row)&&row.length>=v.columns.length-2&&row.length<=v.columns.length);
 const columnKey=k=>k.endsWith('?')?k.slice(0,-1):k;
 const protect=(v,key)=>{
  if(proseKeys.has(key)){if(typeof v==='string')protectedText.add(v);return;}
  if(table(v))for(const row of v.rows)row.forEach((x,i)=>protect(x,columnKey(v.columns[i])));
  if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))protect(x,k);
 };
 protect(input);
 // These identifiers are also the mandated prefix of new creative objects. Keep
 // their spelling stable rather than trying to rewrite arbitrary generated suffixes.
 for(const w of input.plan?.workPackages??[])if(typeof w?.id==='string')protectedText.add(w.id);
 for(const value of [input.executionBatch?.id,input.executionBatch?.batch?.id])if(typeof value==='string')protectedText.add(value);
 const originals=new Set(),add=value=>{
  if(typeof value==='string'&&value.length>=28&&/^[A-Za-z0-9_:./-]+$/.test(value)&&!protectedText.has(value))originals.add(value);
 };
 const collect=(v,key)=>{
  if(proseKeys.has(key))return;
  if(machineKeys.has(key)){if(Array.isArray(v))v.forEach(add);else add(v);}
  if(table(v))for(const row of v.rows)row.forEach((x,i)=>collect(x,columnKey(v.columns[i])));
  if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))collect(x,k);
 };
 collect(input);
 if(originals.size>9999)return unchanged;
 const aliases=Object.fromEntries([...originals].map((value,i)=>[`R${String(i+1).padStart(4,'0')}`,value]));
 const toAlias=new Map(Object.entries(aliases).map(([short,full])=>[full,short]));
 const encode=(v,key,modelSchema=false)=>{
  if(!modelSchema&&proseKeys.has(key))return v;
  if(typeof v==='string')return modelSchema||responseKeys.has(key)?toAlias.get(v)??v:v;
  if(!v||typeof v!=='object')return v;
  if(!modelSchema&&table(v))return {...Object.fromEntries(Object.entries(v).filter(([k])=>k!=='rows').map(([k,x])=>[k,encode(x,k)])),rows:v.rows.map(row=>row.map((x,i)=>encode(x,columnKey(v.columns[i]))))};
  return Array.isArray(v)?v.map(x=>encode(x,key,modelSchema)):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x,k,modelSchema)]));
 };
 const next=encode(input),nextSchema=encode(schema,undefined,true);
 if(duplicatePlan){
  const reference={$jsonOf:'#/previousDraft/previousPlan'};
  if(JSON.stringify(reference).length<JSON.stringify(input.previousDraft.rawText).length)next.previousDraft.rawText=reference;
 }
 const evidenceTables=['previousSource','currentOpening'].map(key=>next.episodeBoundary?.seed?.[key]);
 if(includeContinuityNodes)evidenceTables.push(next.source?.context?.continuity?.previousSource);
 for(const evidence of evidenceTables){
  const nodes=evidence?.nodes;
  if(!Array.isArray(nodes)||!nodes.length||!nodes.every(n=>record(n)&&Object.keys(n).length===nodeKeys.length&&nodeKeys.every(k=>Object.hasOwn(n,k))
   &&typeof n.id==='string'&&typeof n.target==='string'&&typeof n.kind==='string'&&Array.isArray(n.sourceUnitIds)&&n.sourceUnitIds.every(x=>typeof x==='string')
   &&record(n.sourceRange)&&Object.keys(n.sourceRange).length===2&&['start','end'].every(k=>Number.isSafeInteger(n.sourceRange[k]))&&Number.isSafeInteger(n.startLine)&&Number.isSafeInteger(n.endLine)))continue;
  const table={$boundaryNodes:{columns:nodeKeys,rows:nodes.map(n=>nodeKeys.map(k=>n[k]))}};
  if(JSON.stringify(table).length<JSON.stringify(nodes).length)evidence.nodes=table;
 }
 if(JSON.stringify(next).length+JSON.stringify(nextSchema).length+HINT.length>=JSON.stringify(input).length+JSON.stringify(schema).length)return unchanged;
 const coordinates=originals.size?{version:MODEL_COORDINATE_VERSION,aliases,hash:digest({version:MODEL_COORDINATE_VERSION,aliases})}:null;
 return {input:next,schema:nextSchema,coordinates,hint:HINT};
}

/** Decode only reference-bearing output fields. Never change dialogue or other creative strings. */
export function restoreModelCoordinates(output,coordinates){
 if(!coordinates)return output;
 const {version,aliases,hash}=coordinates;
 if(version!==MODEL_COORDINATE_VERSION||!record(aliases)||!Object.entries(aliases).every(([k,v])=>/^R\d{4}$/.test(k)&&typeof v==='string'&&v.length>=28)
  ||new Set(Object.values(aliases)).size!==Object.keys(aliases).length||hash!==digest({version,aliases}))fail('MODEL_COORDINATES','本次编号映射不完整，保留原始回包，不猜测来源。');
 const original=value=>Object.hasOwn(aliases,value)?aliases[value]:value;
 const decode=(v,key)=>{
  if(responseKeys.has(key)){
   if(typeof v==='string')return original(v);
   if(Array.isArray(v))return v.map(x=>typeof x==='string'?original(x):decode(x));
  }
  if(!v||typeof v!=='object')return v;
  return Array.isArray(v)?v.map(x=>decode(x)):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x,k)]));
 };
 return decode(output);
}
