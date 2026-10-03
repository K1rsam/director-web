// Frozen transport notation: changing its meaning requires a new snapshot version.
export const INPUT_PROJECTION_VERSION='lossless-input-v1';
export const INPUT_PROJECTION_HINT='【资料单跳等值引用】下方JSON中，{"$same":"#/路径"}表示本JSON对应路径处的完整原值（数字为0基数组下标），目标不含引用；{"$rowIds":[["sourceRows",起,止],...]}表示按段取source中对应行数组的id，0基且含末项，可同样使用contextRows。只替代已逐字核同的重复值，不是摘要；引用不改变制作/前情边界，输出仍填原始完整id。原文、对白声道、现稿及适用专业规则均照常审查。';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const strings=x=>Array.isArray(x)&&x.every(v=>typeof v==='string');
const json=x=>JSON.stringify(x);
const shorter=(original,replacement)=>json(replacement).length<json(original).length?replacement:original;
const refs=new Set(['sourceRefs','contextRefs','anchorRefs']);
const planLists=new Set(['workPackages','provisionalUnits','fantasyCandidates','events','beatContracts','eventSegments']);
const reserved=new Set(['$same','$rowIds']);
const emotionOK=x=>object(x)&&['subject','contextTone','audienceEffect','change','landing'].every(k=>typeof x[k]==='string')&&strings(x.retain);
function safeTree(value){
 if(!value||typeof value!=='object')return ['undefined','string','boolean'].includes(typeof value)||value===null||typeof value==='number'&&Number.isFinite(value);
 if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 return Object.entries(value).every(([key,item])=>!reserved.has(key)&&safeTree(item));
}
function validPlan(value){
 if(!value||typeof value!=='object')return true;
 return Object.entries(value).every(([key,item])=>
  key==='emotionContract'?emotionOK(item):refs.has(key)?strings(item):planLists.has(key)?Array.isArray(item)&&item.every(x=>object(x)&&validPlan(x)):validPlan(item));
}
function validInput(input){
 const source=input?.source;
 if(!object(input)||!object(source)||!['sourceRows','contextRows'].every(key=>Array.isArray(source[key])&&source[key].every(row=>object(row)&&typeof row.id==='string'&&typeof row.text==='string')))return false;
 const rows=[...source.sourceRows,...source.contextRows];
 if(new Set(rows.map(row=>row.id)).size!==rows.length)return false;
 if(!Array.isArray(source.dialogue)||!source.dialogue.every(q=>object(q)&&['id','rowId','speaker','quote','cue','kind','channel'].every(key=>typeof q[key]==='string')))return false;
 if(!Array.isArray(source.entryFacts)||!source.entryFacts.every(f=>object(f)&&strings(f.sourceRefs)))return false;
 if(input.plan!==null&&(!object(input.plan)||!['workPackages','provisionalUnits','fantasyCandidates'].every(key=>Array.isArray(input.plan[key]))||!validPlan(input.plan)))return false;
 if(input.plan?.packageOverview!==undefined&&(!object(input.plan.packageOverview)||!Array.isArray(input.plan.packageOverview.provisionalUnits)))return false;
 if(input.executionBatch!==undefined&&(!object(input.executionBatch)||!object(input.executionBatch.batch)||!strings(input.executionBatch.batch.sourceRefs)))return false;
 if(input.voiceReference!==null&&(!object(input.voiceReference)||!Array.isArray(input.voiceReference.rows)||!input.voiceReference.rows.every(row=>object(row)&&typeof row.id==='string'&&(row.quote===undefined||typeof row.quote==='string'))))return false;
 return safeTree(input);
}

export function projectModelInput(raw){
 const unchanged={input:raw,hint:''};
 // Unknown/abnormal shapes and literal notation markers are ordinary data, not compression instructions.
 if(!validInput(raw))return unchanged;
 const input=structuredClone(raw),source=input.source,positions=new Map();
 for(const catalog of ['sourceRows','contextRows'])source[catalog].forEach((row,index)=>positions.set(row.id,[catalog,index]));
 const rowIds=values=>{
  const spans=[];
  for(const id of values){
   const position=positions.get(id);if(!position)return values; // Includes intentionally omitted blank layout IDs.
   const [catalog,index]=position,last=spans.at(-1);
   if(last&&last[0]===catalog&&last[2]+1===index)last[2]=index;else spans.push([catalog,index,index]);
  }
  return spans.length?shorter(values,{$rowIds:spans}):values;
 };
 const emotions=new Map(),overview=input.plan?.packageOverview?.provisionalUnits;
 const planValue=(value,pointer)=>{
  // The full parent rough plan is the directly readable canonical target for local rough units.
  if(pointer==='#/plan/packageOverview')return value;
  if(Array.isArray(value))return value.map((item,index)=>{
   if(pointer==='#/plan/provisionalUnits'&&overview){
    const match=overview.findIndex(unit=>json(unit)===json(item));
    if(match>=0){const reference=shorter(item,{$same:`#/plan/packageOverview/provisionalUnits/${match}`});if(reference!==item)return reference;}
   }
   return planValue(item,`${pointer}/${index}`);
  });
  if(!object(value))return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>{
   const next=`${pointer}/${key.replaceAll('~','~0').replaceAll('/','~1')}`;
   if(refs.has(key))return [key,rowIds(item)];
   if(key==='emotionContract'){
    const encoded=json(item),canonical=emotions.get(encoded);
    if(canonical)return [key,shorter(item,{$same:canonical})];
    emotions.set(encoded,next);return [key,item]; // Never transform a reference target or its children.
   }
   // Unrecognized plan extensions are kept verbatim, even if they reuse familiar field names.
   return [key,planLists.has(key)?planValue(item,next):item];
  }));
 };
 if(input.plan)input.plan=planValue(input.plan,'#/plan');
 if(input.executionBatch)input.executionBatch.batch.sourceRefs=rowIds(input.executionBatch.batch.sourceRefs);

 // Raw source rows and the dialogue catalog remain verbatim and directly readable, including actor/cue/channel.
 const canonicalText=new Map();
 for(const catalog of ['sourceRows','contextRows'])source[catalog].forEach((row,index)=>{if(!canonicalText.has(row.text))canonicalText.set(row.text,`#/source/${catalog}/${index}/text`);});
 source.dialogue.forEach((q,index)=>{if(!canonicalText.has(q.quote))canonicalText.set(q.quote,`#/source/dialogue/${index}/quote`);});
 const textCopy=value=>{
  if(typeof value==='string'){const canonical=canonicalText.get(value);return canonical?shorter(value,{$same:canonical}):value;}
  if(Array.isArray(value))return value.map(textCopy);
  if(object(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,textCopy(item)]));
  return value;
 };
 source.context=textCopy(source.context);
 source.entryFacts=source.entryFacts.map(f=>({...f,sourceRefs:rowIds(f.sourceRefs),...(Object.hasOwn(f,'evidence')?{evidence:textCopy(f.evidence)}:{})}));
 if(input.voiceReference)input.voiceReference.rows=input.voiceReference.rows.map(row=>{
  const index=source.dialogue.findIndex(q=>q.id===row.id&&q.quote===row.quote);
  return index>=0?{...row,quote:shorter(row.quote,{$same:`#/source/dialogue/${index}/quote`})}:row;
 });
 // Never transform previousDraft or predecessor.unit: the finisher must inspect the entire delivered work.
 return json(input).length+INPUT_PROJECTION_HINT.length+1<json(raw).length?{input,hint:INPUT_PROJECTION_HINT}:unchanged;
}
