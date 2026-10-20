import {STANDARD_EPISODE_PROTOCOL} from './storyboard-v4/core/standard-source.mjs';

const record=x=>x&&typeof x==='object'&&!Array.isArray(x);
const known=(x,keys)=>record(x)&&Object.keys(x).every(k=>keys.includes(k));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const range=x=>known(x,['start','end'])&&Number.isSafeInteger(x.start)&&Number.isSafeInteger(x.end)&&x.start>=0&&x.end>x.start;

// This is a model-only read pack. Canonical sources, material versions and frozen
// requests remain intact. Unknown shapes and evidence without exact proof stay.
function visibleEvidence(source,sent){
 const pkg=source?.standardPackage,match=/^episode-(0|[1-9]\d*)$/.exec(pkg?.binding?.sourceId??'');
 if(source?.sourceProtocol!==STANDARD_EPISODE_PROTOCOL||!match||!Array.isArray(pkg.evidence))return null;
 const original=new Map([...source.sourceRows,...source.contextRows].map(r=>[r.id,r])),visible=new Map(),units=new Map(pkg.evidence.map((u,i)=>[u.id,{...u,line:i+1}]));
 for(const table of ['sourceRows','contextRows'])for(const row of sent?.[table]??[]){
  const canonical=original.get(row.id),u=canonical&&pkg.evidence[canonical.line-1];
  if(!u||row.text!==canonical.text||row.kind!==canonical.kind)continue;
  // A validated multiline dialogue can be one readable row over several
  // physical evidence units (including its separators). Prove exact assembly,
  // rather than mistakenly treating its continuation as absent from the input.
  const covered=[];let assembled='';
  for(let index=canonical.line-1;index<pkg.evidence.length;index++){
   const unit=pkg.evidence[index];
   if(assembled.length+unit.text.length>row.text.length)break;
   covered.push(unit);assembled+=unit.text;if(assembled.length===row.text.length)break;
  }
  if(assembled!==row.text||covered.some((unit,i)=>unit.end-unit.start!==unit.text.length||i&&covered[i-1].end!==unit.start))continue;
  if(covered.length>1){
   const first=pkg.fidelity?.assignments?.find(a=>a.unitId===u.id);
   if(!first||!covered.every(unit=>pkg.fidelity.assignments.some(a=>a.unitId===unit.id&&a.target===first.target&&a.targetId===first.targetId)))continue;
  }
  for(const unit of covered)visible.set(unit.id,{row:canonical,table,unit});
 }
 return {pkg,episode:Number(match[1]),text:pkg.evidence.map(u=>u.text).join(''),visible,units};
}
function readableIndex(f,card,evidence){
 if(!evidence||!known(f,['id','claim','quote','association','evidence'])||typeof f.id!=='string'||!f.id||typeof f.quote!=='string'||!f.quote
  ||!['ASSET_NAME','SCENE_ACTION'].includes(f.association)||!['SOURCE','CHARACTER_CLAIM'].includes(f.claim)
  ||!known(f.evidence,['domain','episode','start','end'])||f.evidence.domain!=='EPISODE'||f.evidence.episode!==evidence.episode||card.applicable?.episode!==evidence.episode
  ||!range({start:f.evidence.start,end:f.evidence.end})||evidence.text.slice(f.evidence.start,f.evidence.end)!==f.quote||f.evidence.end-f.evidence.start!==f.quote.length)return false;
 const nodes=evidence.pkg.script?.entries??[];
 return nodes.some(node=>{
  if(node.target!=='BODY'||!(f.claim==='SOURCE'?node.kind==='ACTION':['DIALOGUE','DIALOGUE_GROUP'].includes(node.kind)))return false;
  const units=node.sourceUnitIds?.map(id=>evidence.units.get(id));
  if(!units?.length||!units.every(Boolean)||units[0].start>f.evidence.start||units.at(-1).end<f.evidence.end)return false;
  // Every covered physical row must actually be readable in this request, with
  // the same authority. Merely owning the complete standard package is not proof.
  return units.filter(u=>u.start<f.evidence.end&&u.end>f.evidence.start).every(u=>{
   const read=evidence.visible.get(u.id);
   return read?.table==='sourceRows'&&read.row.evidenceRole!=='guidance'&&read.row.kind===(f.claim==='SOURCE'?'action':'dialogue');
  });
 });
}
function referencedIds(source,snapshot,consumers){
 const strings=new Set();
 const visit=value=>{
  if(typeof value==='string'){strings.add(value);return;}
  if(Array.isArray(value)){for(const v of value)visit(v);return;}
  if(!record(value))return;
  for(const [key,v] of Object.entries(value)){
   // The index's own declaration is not a consumer reference; all other
   // strings/unknown structures stay conservative, including cross-card links.
   strings.add(key);
   if(key==='sourceFacts'&&Array.isArray(v)){
    for(const f of v){
     if(record(f)){for(const [k,x] of Object.entries(f))if(k!=='id')visit(x);}
     else visit(f);
    }
   }else visit(v);
  }
 };
 visit(source);visit(snapshot);visit(consumers);return strings;
}
function redundantOpening(boundary,e){
 const seed=boundary?.seed,o=seed?.currentOpening;
 if(!e||!known(boundary,['version','versionId','seed','selected','actual','agreements','mode','chainMode'])||boundary.version!=='episode-boundary-v1'
  ||seed?.schema!=='EPISODE_BOUNDARY_SEED_V1'||!known(seed,['schema','sourceVersion','fromEpisode','toEpisode','adjacentEpisode','previousSource','currentOpening','evidence','story','unknowns','policy'])
  ||seed.fromEpisode!==null||seed.previousSource!==null||boundary.actual!==null||boundary.selected!==null||!Array.isArray(boundary.agreements)||boundary.agreements.length
  ||seed.toEpisode!==e.episode||!known(o,['episode','sceneKey','location','timeOfDay','interiorExterior','selectionKind','sourceRange','startLine','endLine','text','sourceTextHash','sourceLength','nodes','clipped','budgetExceeded','diagnostics'])
  ||o.episode!==e.episode||!range(o.sourceRange)||o.sourceRange.end>e.text.length||e.text.slice(o.sourceRange.start,o.sourceRange.end)!==o.text
  ||!Array.isArray(o.diagnostics)||o.diagnostics.length||!Array.isArray(o.nodes)||!o.nodes.length||!o.nodes.every(record)||new Set(o.nodes.map(n=>n.id)).size!==o.nodes.length)return false;
 for(const node of o.nodes){
  if(!known(node,['id','target','kind','sourceUnitIds','sourceRange','startLine','endLine'])||!range(node.sourceRange)||!Array.isArray(node.sourceUnitIds)||!node.sourceUnitIds.length)return false;
  const units=node.sourceUnitIds.map(id=>e.units.get(id));
  if(!units.every(Boolean)||units[0].start!==node.sourceRange.start||units.at(-1).end!==node.sourceRange.end||units[0].line!==node.startLine||units.at(-1).line!==node.endLine)return false;
  if(!units.every(u=>{
   const v=e.visible.get(u.id),assignment=e.pkg.fidelity?.assignments?.find(a=>a.unitId===u.id);
   return v&&assignment?.targetId===node.id&&v.row.standard?.target===node.target&&v.row.standard?.kind===node.kind;
  }))return false;
 }
 // Blank layout may be omitted; every substantive original row in the opening
 // must still be sent. No partial execution batch loses unseen opening text.
 if(!e.pkg.evidence.filter(u=>u.start<o.sourceRange.end&&u.end>o.sourceRange.start&&u.text.trim()).every(u=>e.visible.has(u.id)))return false;
 const nodeIds=o.nodes.map(n=>n.id);
 return Array.isArray(seed.evidence)&&seed.evidence.every(item=>known(item,['role','episode','start','end','startLine','endLine','nodeIds'])&&item.role==='CURRENT_OPENING'&&item.episode===e.episode&&item.start===o.sourceRange.start&&item.end===o.sourceRange.end&&item.startLine===o.startLine&&item.endLine===o.endLine&&same(item.nodeIds,nodeIds));
}
export function projectProductionReadPack(snapshot,source,sent,consumers=null){
 const result={snapshot,removedQuoteIndices:0,omittedOpening:false};
 if(!snapshot||!Array.isArray(snapshot.materials))return result;
 const evidence=visibleEvidence(source,sent);if(!evidence)return result;
 const next=structuredClone(snapshot),linked=referencedIds(source,snapshot,consumers),references=[...linked];
 for(const material of next.materials){
  if(material?.kind!=='ASSET_PRODUCTION_CARD'||material.value?.schema!=='ASSET_PRODUCTION_CARD_V1'||!Array.isArray(material.value.sourceFacts))continue;
  material.value.sourceFacts=material.value.sourceFacts.filter(f=>{
   if(linked.has(f?.id)||typeof f?.id==='string'&&references.some(s=>s.includes(f.id))||!readableIndex(f,material.value,evidence))return true;
   result.removedQuoteIndices++;return false;
  });
 }
 const o=next.episodeBoundary?.seed?.currentOpening;
 const metadata=['sceneKey','location','timeOfDay','interiorExterior'];
 const scenes=Array.isArray(sent.context?.scenes)?sent.context.scenes:[];
 const sameScene=!o||metadata.every(k=>o[k]==null)||scenes.some(s=>record(s)&&metadata.every(k=>o[k]==null||s[k]===o[k]));
 if(sameScene&&redundantOpening(next.episodeBoundary,evidence)){
  next.episodeBoundary.seed.currentOpening=null;next.episodeBoundary.seed.evidence=[];result.omittedOpening=true;
 }
 return {...result,snapshot:next};
}
