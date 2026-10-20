// Opt-in transport for the new production snapshot. Never rewrite a saved request.
export const PRODUCTION_TRANSPORT_VERSION='production-text-reuse-v1';
export const COMPACT_PRODUCTION_TRANSPORT_VERSION='production-compact-v2';
export const SHARED_PRODUCTION_TRANSPORT_VERSION='production-compact-v3';
export const LEAN_PRODUCTION_TRANSPORT_VERSION='production-lean-v4';
export const INTERNED_PRODUCTION_TRANSPORT_VERSION='production-shared-v5';
const HINT='【生产资料等值引用】{"$same":"#/路径"}是本JSON该路径的完整原值；{"$joinRows":["sourceRows或contextRows",起,止,"分隔符"]}是按0基含末项取该行表的text并用给定分隔符连接。目标原文均直接可读，无引用链。这只省去逐字相同的复本，不是摘要，不改变证据权重或制作范围。';
const SHARED_HINT='【生产资料等值引用】{"$same":"#/路径"}表示本JSON该路径的完整原值，引用按路径逐级等值展开；{"$joinRows":["sourceRows或contextRows",起,止,"分隔符"]}按0基含末项取行表text并用给定分隔符连接。相同sourceFacts只存一份，各资产ID、设计及适用范围独立；相同前集节点共用完整原值，不是缺料。这不是摘要，不改变证据权重、源坐标或制作范围。';
const json=JSON.stringify;
export function productionTransportSafe(value){
 if(!value||typeof value!=='object')return true;
 return Object.entries(value).every(([key,item])=>!['$same','$rowIds','$joinRows'].includes(key)&&productionTransportSafe(item));
}

export function projectProductionTransport(raw,{trustedReferences=false,version=PRODUCTION_TRANSPORT_VERSION}={}){
 const unchanged={input:raw,hint:''},source=raw?.source;
 if(!trustedReferences&&!productionTransportSafe(raw))return unchanged;
 if(!source||!['sourceRows','contextRows'].every(k=>Array.isArray(source[k])&&source[k].every(r=>r&&typeof r.text==='string')))return unchanged;
 const input=structuredClone(raw),literal=new Map();
 for(const table of ['sourceRows','contextRows'])source[table].forEach((r,i)=>{if(r.text&&!literal.has(r.text))literal.set(r.text,`#/source/${table}/${i}/text`);});
 const encode=value=>{
  if(typeof value!=='string'||!value)return value;
  const exact=literal.get(value);if(exact){const ref={$same:exact};return json(ref).length<json(value).length?ref:value;}
  for(const table of ['sourceRows','contextRows'])for(let start=0;start<source[table].length;start++){
   if(!value.startsWith(source[table][start].text))continue;
   for(const separator of [LEAN_PRODUCTION_TRANSPORT_VERSION,INTERNED_PRODUCTION_TRANSPORT_VERSION].includes(version)?['','\n','\r\n']:['\n','\r\n']){let joined='';
    for(let end=start;end<source[table].length;end++){
     joined+=(end===start?'':separator)+source[table][end].text;
     if(joined===value){const ref={$joinRows:[table,start,end,separator]};if(json(ref).length<json(value).length)return ref;break;}
     if(!value.startsWith(joined))break;
    }
   }
  }
  return value;
 };
 for(const key of ['previousSource','currentOpening']){
  const evidence=input.episodeBoundary?.seed?.[key];if(evidence&&typeof evidence.text==='string')evidence.text=encode(evidence.text);
 }
 for(const material of Array.isArray(input.productionMaterials)?input.productionMaterials:[]){
  for(const fact of Array.isArray(material?.value?.sourceFacts)?material.value.sourceFacts:[])if(fact&&typeof fact.quote==='string')fact.quote=encode(fact.quote);
 }
 const shared=[SHARED_PRODUCTION_TRANSPORT_VERSION,LEAN_PRODUCTION_TRANSPORT_VERSION,INTERNED_PRODUCTION_TRANSPORT_VERSION].includes(version);
 const beforeShared=shared?structuredClone(input):null;let reused=false;
 if(shared){
  const facts=new Map();
  (Array.isArray(input.productionMaterials)?input.productionMaterials:[]).forEach((material,index)=>{
   const value=material?.value?.sourceFacts;if(!Array.isArray(value)||!value.length)return;
   const key=json(value),existing=facts.get(key);
   if(existing){const ref={$same:existing};if(json(ref).length<key.length){material.value.sourceFacts=ref;reused=true;}}
   else facts.set(key,`#/productionMaterials/${index}/value/sourceFacts`);
  });
  const previous=input.source.context?.continuity?.previousSource,boundary=input.episodeBoundary?.seed?.previousSource;
  if(Array.isArray(previous?.nodes)&&previous.nodes.length&&Array.isArray(boundary?.nodes)&&json(previous.nodes)===json(boundary.nodes)){
   const ref={$same:'#/episodeBoundary/seed/previousSource/nodes'};
   if(json(ref).length<json(previous.nodes).length){previous.nodes=ref;reused=true;}
  }
 }
 if(version===INTERNED_PRODUCTION_TRANSPORT_VERSION){
  const table=input.source.context?.retrievalFacts?.historicalEvidenceCandidates;
  // Only repeated proof/heading metadata is interned. Every fact, statement,
  // claim, coordinate and row remains present, with the existing exact $same
  // grammar; never summarize candidates or cache an applicability decision.
  if(table?.format==='HISTORICAL_EVIDENCE_TABLE_V4'&&Object.keys(table).every(k=>['format','columns','shared','interpretation','rows'].includes(k))
   &&Array.isArray(table.columns)&&new Set(table.columns).size===table.columns.length&&Array.isArray(table.rows)&&table.rows.every(r=>Array.isArray(r)&&r.length===table.columns.length)){
   const literals=new Map();
   table.rows.forEach((row,i)=>table.columns.forEach((column,j)=>{
    if(!['contextEvidence','contextUse'].includes(column))return;
    const value=row[j];if(!value||typeof value!=='object'||Array.isArray(value))return;
    const allowed=column==='contextEvidence'?['origin','offsetUnit','verifiedAgainst','excerptRange','coordinateRule']:['kind','episode','heading'];
    if(Object.keys(value).some(k=>!allowed.includes(k)))return;
    const key=json(value);if(key.length<192)return;
    const prior=literals.get(key),ref=prior&&{$same:prior};
    if(ref&&json(ref).length<key.length){row[j]=ref;reused=true;}
    else literals.set(key,`#/source/context/retrievalFacts/historicalEvidenceCandidates/rows/${i}/${j}`);
   }));
  }
 }
 if(reused&&json(input).length+SHARED_HINT.length>=json(beforeShared).length+HINT.length)return json(beforeShared).length+HINT.length<json(raw).length?{input:beforeShared,hint:HINT}:unchanged;
 const hint=reused?SHARED_HINT:HINT;
 return json(input).length+hint.length<json(raw).length?{input,hint}:unchanged;
}
