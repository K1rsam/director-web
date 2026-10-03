import {parseScript,normalizeSource} from './core/source.mjs';
import {buildVisualStyle} from './core/visual-style.mjs';
import {digest,fail} from './core/shared.mjs';
import {resolveSelection} from './core/selection.mjs';
import {validateEpisodeSourceContext} from './source-context.mjs';
import {canRecheckCandidate,hasPendingSavedResponse} from './core/pipeline.mjs';
import {repairControl} from '../feedback-repair.mjs';
import {standardPackageSource,STANDARD_EPISODE_PROTOCOL} from './core/standard-source.mjs';
export {STANDARD_EPISODE_PROTOCOL};

export const UPSTREAM_MATERIAL_PROTOCOL='upstream-material-v2';
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const hasText=value=>typeof value==='string'&&value.trim().length>0;
const trackingFields=new Set(['documentRevision','sourceVersion','sourceContextVersion','revision','round','decidedAt','createdAt','updatedAt']);
// Only V2 material views omit audit counters; legacy source objects and receipt bytes are untouched.
function semanticMaterial(value){
 if(Array.isArray(value))return Array.from(value,semanticMaterial);
 if(record(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!trackingFields.has(key)).map(([key,item])=>[key,semanticMaterial(item)]));
 return value;
}
function localFacts(facts){
 if(!record(facts))return facts??null;
 const projected=semanticMaterial(facts);
 if(projected.schema==='FOUNDATION_FACTS_V1')for(const group of ['current','background','backgroundCandidates','historicalStates','sourceFactIndex','unlinkedBackground']){
  if(!Array.isArray(projected[group]))continue;
  projected[group]=projected[group].map(item=>{if(!record(item))return item;const {id,...fields}=item;return {id:`local-fact:${digest(fields)}`,...fields};});
 }
 return projected;
}
function productionEvidence(packet,episode,assetKeys,materialKeys,sourceRows){
 const upstream=packet.upstream,result={};
 if(upstream.assetProductionCards!==undefined){
  if(!Array.isArray(upstream.assetProductionCards))fail('UPSTREAM_PRODUCTION_CARD','制作资料卡必须为数组');
  const seen=new Set();
  result.assetProductionCards=Array.from(upstream.assetProductionCards,card=>{
   if(!record(card)||card.schema!=='ASSET_PRODUCTION_CARD_V1'||!hasText(card.assetKey)||seen.has(card.assetKey)||!hasText(card.name)||!hasText(card.type)
    ||!['ACTUAL_APPEARANCE','MATERIAL_SOURCE_ONLY','CANDIDATE_ONLY'].includes(card.use)
    ||!(card.use==='MATERIAL_SOURCE_ONLY'?materialKeys:assetKeys).has(card.assetKey)
    ||card.applicable?.episode!==episode.number||!Array.isArray(card.applicable?.sceneKeys)||!card.applicable.sceneKeys.every(hasText)
    ||!Array.isArray(card.sourceFacts)||!hasText(card.freeDesignScope)||!['TEXT_ONLY','REFERENCE_AVAILABLE'].includes(card.materialAvailability)
    ||card.imageEvidence!=='NO_PIXELS_READ'||!Array.isArray(card.references)||!Array.isArray(card.materialNeeds))fail('UPSTREAM_PRODUCTION_CARD','制作资料卡的身份、适用集或证据边界无效');
   seen.add(card.assetKey);const facts=new Set(),refs=new Set();
   const sourceFacts=Array.from(card.sourceFacts,fact=>{
    if(!record(fact)||!hasText(fact.id)||facts.has(fact.id)||!['SOURCE','CHARACTER_CLAIM'].includes(fact.claim)||!hasText(fact.quote)
     ||!['ASSET_NAME','SCENE_ACTION','VISUAL_FACT'].includes(fact.association)||!record(fact.evidence))fail('UPSTREAM_PRODUCTION_FACT','资料卡原文事实或主张级别无效');
    const e=fact.evidence;
    if(e.domain==='EPISODE'&&(e.episode!==episode.number||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||episode.content.slice(e.start,e.end)!==fact.quote)
     ||fact.association==='VISUAL_FACT'&&!episode.content.includes(fact.quote))fail('UPSTREAM_PRODUCTION_FACT','资料卡的本集引用与原文不一致');
    facts.add(fact.id);return structuredClone(fact);
   });
   const adopted=card.adoptedDesign;
   if(adopted!==null&&(!record(adopted)||adopted.provenance!=='ADOPTED_DESIGN_NOT_SOURCE_FACT'||!hasText(adopted.brief)
    ||adopted.version!==null&&(!Number.isSafeInteger(adopted.version)||adopted.version<1)))fail('UPSTREAM_PRODUCTION_CARD','采用设计必须与原文事实分开');
   let candidateDesign,candidateDesigns;
   if(card.candidateDesigns!==undefined&&!Array.isArray(card.candidateDesigns))fail('UPSTREAM_MATERIAL_CANDIDATE','局部材料候选列表无效');
   const candidateNeeds=new Set();
   const parseCandidate=c=>{
    const scope=c?.scope,bound=upstream.materialCandidateScope;
    const strings=value=>Array.isArray(value)&&value.length>0&&value.length<=200&&value.every(hasText)&&new Set(value).size===value.length;
    const sourceIds=new Set(sourceRows.map(row=>row.id));
    if(!record(c)||c.provenance!=='CANDIDATE_ONLY'||!hasText(c.version)||!hasText(c.brief)||[...c.brief].length>600||!record(scope)||!record(bound)
     ||!hasText(scope.workflowId)||!hasText(scope.runId)||scope.episodeNumber!==episode.number||scope.sourceVersion!==packet.sourceVersion
     ||['workflowId','runId','episodeNumber','sourceVersion'].some(field=>scope[field]!==bound[field])
     ||!Array.isArray(c.needs)||!c.needs.length||!Array.isArray(c.limitations)||!c.limitations.every(value=>typeof value==='string'&&value.length<=600))fail('UPSTREAM_MATERIAL_CANDIDATE','局部材料候选缺少本次任务与原文版本绑定');
    const needs=Array.from(c.needs,need=>{
     if(!record(need)||!hasText(need.needRef)||need.target!==card.assetKey||!hasText(need.purpose)||!strings(need.packageIds)||!strings(need.sourceRefs)||need.sourceRefs.some(id=>!sourceIds.has(id)))fail('UPSTREAM_MATERIAL_CANDIDATE','局部候选的需求、工作包或本集原文坐标无效');
     return {needRef:need.needRef,target:need.target,purpose:need.purpose,sourceRefs:[...need.sourceRefs],packageIds:[...need.packageIds]};
    });
    for(const need of needs){if(candidateNeeds.has(need.needRef))fail('UPSTREAM_MATERIAL_CANDIDATE','局部材料需求标识重复');candidateNeeds.add(need.needRef);}
    return {provenance:'CANDIDATE_ONLY',version:c.version,brief:c.brief,scope:{workflowId:scope.workflowId,runId:scope.runId,episodeNumber:scope.episodeNumber,sourceVersion:scope.sourceVersion},needs,limitations:[...c.limitations]};
   };
   // New arrays are authoritative; retaining a legacy singleton does not duplicate supply.
   if(card.candidateDesigns!==undefined)candidateDesigns=Array.from(card.candidateDesigns,parseCandidate);
   else if(card.candidateDesign!==undefined)candidateDesign=parseCandidate(card.candidateDesign);
   const references=Array.from(card.references,ref=>{if(!record(ref)||!hasText(ref.id)||refs.has(ref.id)||typeof ref.description!=='string'||typeof ref.available!=='boolean')fail('UPSTREAM_REFERENCE','制作参考说明无效');refs.add(ref.id);return {id:ref.id,description:ref.description,available:ref.available};});
   const materialNeeds=Array.from(card.materialNeeds,need=>{if(!record(need)||!['SOURCE_FUNCTION_EVIDENCE','DESIGN_REVIEW','REFERENCE_IMAGE'].includes(need.kind)||need.required!==false||!hasText(need.detail))fail('UPSTREAM_PRODUCTION_CARD','材料补足说明无效');return {kind:need.kind,required:false,detail:need.detail};});
   return {schema:card.schema,assetKey:card.assetKey,name:card.name,type:card.type,use:card.use,applicable:structuredClone(card.applicable),sourceFacts,
    adoptedDesign:adopted===null?null:{version:adopted.version,brief:adopted.brief,provenance:adopted.provenance},...(candidateDesigns?{candidateDesigns}:candidateDesign?{candidateDesign}:{}),freeDesignScope:card.freeDesignScope,materialAvailability:card.materialAvailability,imageEvidence:'NO_PIXELS_READ',references,materialNeeds};
  });
 }
 if(upstream.seriesKnowledge!==undefined){
  if(!Array.isArray(upstream.seriesKnowledge))fail('UPSTREAM_SERIES_KNOWLEDGE','全剧检索知识必须为数组');
  const seen=new Set();
  result.seriesKnowledge=upstream.seriesDirection?.status==='CONFIRMED'?Array.from(upstream.seriesKnowledge,item=>{
   const ref=item?.source;
   if(!record(item)||!hasText(item.id)||seen.has(item.id)||!['RELATIONSHIP','REVEAL','CHANGE'].includes(item.kind)||!['SOURCE','CHARACTER_CLAIM'].includes(item.claim)
    ||!hasText(item.statement)||!Array.isArray(item.subjects)||!item.subjects.every(hasText)||!record(ref)||!hasText(ref.evidenceId)||!hasText(ref.episodeId)||!hasText(ref.quote)
    ||!Number.isSafeInteger(ref.start)||!Number.isSafeInteger(ref.end)||ref.start<0||ref.end<=ref.start
    ||!['CURRENT_EPISODE_EVENT','PRIOR_EVIDENCE'].includes(item.timing)
    ||(item.timing==='CURRENT_EPISODE_EVENT')!==(ref.episodeId===episode.id)
    ||item.timing==='CURRENT_EPISODE_EVENT'&&episode.content.slice(ref.start,ref.end)!==ref.quote)fail('UPSTREAM_SERIES_KNOWLEDGE','全剧知识的来源、主张或揭示时点无效');
   seen.add(item.id);return {id:item.id,kind:item.kind,claim:item.claim,statement:item.statement,subjects:[...item.subjects],source:{evidenceId:ref.evidenceId,episodeId:ref.episodeId,quote:ref.quote,start:ref.start,end:ref.end},timing:item.timing};
  }):[];
 }
 if(Object.keys(result).length)result.productionEvidenceRule='assetProductionCards保留本集原文与采用设计的区别；未采用设计不删除原文事实，MATERIAL_SOURCE_ONLY不表示本集出场，缺图不阻断文字制作且未读取像素。采用设计优先；candidateDesign是CANDIDATE_ONLY局部候选，仅供本次need及工作包评估并回执，不是原文事实或全局采用，不自动填入entryFacts，也不推翻已锁定设计。seriesKnowledge只是带来源的关系、揭示与变化检索：当前事件只从本集原文引用位置起成立，历史证据不等于状态永久持续；角色主张不得升级为客观事实，不自动填入entryFacts。';
 return result;
}
function materialProjection(packet,episode,sourceRows){
 const upstream=packet?.upstream;
 if(!upstream)return {seriesDirection:null,modelDesigns:[]};
 if(upstream.version!=='EPISODE_UPSTREAM_V1')fail('UPSTREAM_PROTOCOL','未知的上游材料协议，未自动沿用旧资料');
 let seriesDirection=null;
 if(upstream.seriesDirection?.status==='CONFIRMED'){
  const brief=upstream.seriesDirection.projection?.brief;
  if(!hasText(brief)||[...brief].length>600)fail('UPSTREAM_DIRECTION','已确认全剧方向缺少有效简述');
  seriesDirection={brief};
 }
 const assetKeys=new Set((packet.assets||[]).flatMap(asset=>[asset.key,...(asset.variants||[]).map(variant=>variant.key)])),materialKeys=new Set((packet.materialDependencies||[]).map(item=>item.key)),keys=new Set([...assetKeys,...materialKeys]);
 if(!Array.isArray(upstream.modelDesigns))fail('UPSTREAM_DESIGN','缺少本集采用设计投影');
 const seen=new Set();
 const modelDesigns=Array.from(upstream.modelDesigns,design=>{
  if(!record(design)||!keys.has(design.assetKey)||seen.has(design.assetKey)||!Number.isSafeInteger(design.adoptionVersion)||design.adoptionVersion<1
   ||!hasText(design.brief)||[...design.brief].length>600||!['TEXT_ONLY','REFERENCE_AVAILABLE'].includes(design.materialAvailability)||!Array.isArray(design.references))fail('UPSTREAM_DESIGN','采用设计的身份、版本或简述无效');
  seen.add(design.assetKey);const refs=new Set();
  const references=Array.from(design.references,ref=>{
   if(!record(ref)||!hasText(ref.id)||refs.has(ref.id)||typeof ref.description!=='string'||typeof ref.available!=='boolean')fail('UPSTREAM_REFERENCE','采用设计的参考说明或可用状态无效');
   refs.add(ref.id);return {id:ref.id,description:ref.description,available:ref.available};
  });
  return {assetKey:design.assetKey,adoptionVersion:design.adoptionVersion,brief:design.brief,materialAvailability:design.materialAvailability,references};
 });
 return {seriesDirection,modelDesigns,...productionEvidence(packet,episode,assetKeys,materialKeys,sourceRows)};
}
// This V2-only projection never infers authority from punctuation or the words in a
// character's speech. The old excerpt and the typed boundary must agree at the same
// absolute UTF16 coordinates; matching words elsewhere are not a source binding.
function previousEvidenceRows(existingRows,packet,episode){
 const previous=packet?.boundaryContext?.previousSource,seed=packet?.episodeBoundary,evidence=seed?.previousSource;
 const rangeValid=(value)=>typeof value?.text==='string'&&Number.isSafeInteger(value.sourceRange?.start)&&Number.isSafeInteger(value.sourceRange?.end)
  &&value.sourceRange.start>=0&&value.sourceRange.end-value.sourceRange.start===value.text.length;
 let valid=rangeValid(previous)&&rangeValid(evidence)&&seed?.schema==='EPISODE_BOUNDARY_SEED_V1'&&hasText(seed.sourceVersion)
  &&seed.sourceVersion===packet?.sourceVersion&&seed.fromEpisode===previous.episode&&evidence.episode===previous.episode&&seed.toEpisode===episode.number
  &&Array.isArray(evidence.nodes)&&evidence.nodes.length>0;
 if(valid){
  const start=Math.max(previous.sourceRange.start,evidence.sourceRange.start),end=Math.min(previous.sourceRange.end,evidence.sourceRange.end);
  valid=end>start&&previous.text.slice(start-previous.sourceRange.start,end-previous.sourceRange.start)===evidence.text.slice(start-evidence.sourceRange.start,end-evidence.sourceRange.start);
 }
 const nodes=valid?[...evidence.nodes].sort((a,b)=>(a?.sourceRange?.start??-1)-(b?.sourceRange?.start??-1)):[];
 if(valid){
  const ids=new Set();
  valid=nodes.every((node,i)=>{
   const range=node?.sourceRange;
   if(!hasText(node?.id)||ids.has(node.id)||!Number.isSafeInteger(range?.start)||!Number.isSafeInteger(range?.end)
    ||range.start<evidence.sourceRange.start||range.end>evidence.sourceRange.end||range.end<=range.start||i&&nodes[i-1].sourceRange.end>range.start)return false;
   ids.add(node.id);return true;
  });
 }
 let offset=0;
 return existingRows.map(row=>{
  const start=offset,end=start+row.text.length,separator=previous?.text?.slice(end).match(/^(?:\r\n|\r|\n)/)?.[0]??'';
  offset=end+separator.length;
  const absoluteStart=(previous?.sourceRange?.start??0)+start,absoluteEnd=absoluteStart+row.text.length;
  const node=valid&&hasText(row.text)&&previous.text.slice(start,end)===row.text?nodes.find(node=>node.sourceRange.start<=absoluteStart&&node.sourceRange.end>=absoluteEnd):null;
  const kind=node?.target==='BODY'&&node.kind==='ACTION'?'action':node?.target==='BODY'&&['DIALOGUE','DIALOGUE_GROUP'].includes(node.kind)?'dialogue':'guidance';
  return {...row,kind,evidenceRole:kind==='action'?'source':'guidance',
   provenance:{offsetUnit:'UTF16',verifiedAgainst:node?'STANDARD_BOUNDARY_NODE':null,
    ...(rangeValid(previous)?{origin:{domain:'EPISODE',episode:previous.episode,start:absoluteStart,end:absoluteEnd}}:{}),
    ...(node?{nodeId:node.id,nodeKind:node.kind,nodeTarget:node.target}:{})}};
 });
}
function factContextRows(facts,episode,previous,existingRows){
 if(facts?.schema!=='FOUNDATION_FACTS_V1')return [];
 const rows=new Map(),existingById=new Map(existingRows.map(row=>[row.id,row]));
 const previousRanges=typeof previous?.text==='string'?[...previous.text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(match=>match[0].length)
  .map((match,i)=>({id:`previous-${previous.episode}:excerpt-${i+1}`,start:match.index,end:match.index+match[0].length,text:match[0].replace(/(?:\r\n|\r|\n)$/,'')})):[];
 for(const group of ['background','backgroundCandidates','historicalStates'])for(const fact of Array.isArray(facts[group])?facts[group]:[]){
  const e=fact?.evidence,statement=fact?.statement;
  if(!hasText(statement)||!record(e)||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end-e.start!==statement.length)continue;
  if(e.domain==='EPISODE'?!Number.isSafeInteger(e.episode)||e.episode<0:e.domain!=='CONTEXT'||!hasText(e.sectionKey))continue;
  if(e.domain==='EPISODE'&&e.episode===episode.number)continue; // Already present once in sourceRows, never create a second current transcript.
  const origin={domain:e.domain,...(e.domain==='EPISODE'?{episode:e.episode}:{sectionKey:e.sectionKey}),start:e.start,end:e.end};
  let verifiedAgainst=null,excerptRange=null,absoluteMatch=false;
  if(e.domain==='EPISODE'&&e.episode===previous?.episode&&typeof previous?.text==='string'){
   const range=previous.sourceRange,hasRange=Number.isSafeInteger(range?.start)&&Number.isSafeInteger(range?.end)&&range.start>=0&&range.end-range.start===previous.text.length;
   const start=hasRange?e.start-range.start:previous.text.indexOf(statement);
   if(start>=0&&start+statement.length<=previous.text.length&&previous.text.slice(start,start+statement.length)===statement){
    verifiedAgainst='PREVIOUS_EXCERPT';excerptRange={start,end:start+statement.length};absoluteMatch=hasRange;
   }
  }
  const reuse=excerptRange?previousRanges.filter(row=>row.start<excerptRange.end&&row.end>excerptRange.start):[];
  const reusable=reuse.length&&reuse.every(row=>existingById.get(row.id)?.text===row.text);
  const typedAction=absoluteMatch&&reusable&&reuse.every(row=>existingById.get(row.id)?.kind==='action'&&existingById.get(row.id)?.evidenceRole==='source');
  if(absoluteMatch&&reusable&&reuse.some(row=>existingById.get(row.id)?.kind==='dialogue'))fact.claim='CHARACTER_CLAIM';
  const guidance=!typedAction||fact.claim!=='SOURCE'||['CONTEXT','FORMAT'].includes(fact.kind)||fact.evidenceRole==='guidance';
  if(excerptRange){
   // A claim/annotation gets its own guidance row if reusing an action would give
   // that claim source authority. Never let a derived fact relabel typed raw text.
   if(reusable&&(!guidance||reuse.some(row=>existingById.get(row.id)?.evidenceRole==='guidance'))){
    Object.assign(fact,reuse.length===1?{contextRef:reuse[0].id}:{contextRefs:reuse.map(row=>row.id)});
    fact.contextEvidence={origin,offsetUnit:'UTF16',verifiedAgainst,excerptRange,coordinateRule:absoluteMatch?'origin与前场同一绝对坐标逐字匹配；只有已验证标准动作节点可作来源依据。':'仅excerptRange逐字匹配，未证明整集绝对坐标或节点类型，保留guidance。'};
    continue;
   }
  }
  const id=`upstream-evidence:${digest({origin,statement})}`,existing=rows.get(id);
  fact.contextRef=id;
  if(existing){if(guidance){existing.evidenceRole='guidance';existing.kind='guidance';}continue;}
  rows.set(id,{id,text:statement,kind:guidance?'guidance':'context',evidenceRole:guidance?'guidance':'source',
   provenance:{origin,offsetUnit:'UTF16',verifiedAgainst,...(excerptRange?{excerptRange}:{}),
    coordinateRule:verifiedAgainst==='PREVIOUS_EXCERPT'?'origin保留提供的整集坐标；仅excerptRange对所给前场原文作精确核对，未证明整集绝对位置。':'origin是原文UTF16坐标；未匹配当前原文的内容只作指导，不自证入口事实。'}});
 }
 return [...rows.values()];
}
function withUpstreamMaterials(base,packet,episode,project){
 const context=semanticMaterial(base.source.context),retrievalFacts=localFacts(packet?.facts);
 const existingRows=previousEvidenceRows(base.source.contextRows,packet,episode);
 const extraRows=factContextRows(retrievalFacts,episode,packet?.boundaryContext?.previousSource,existingRows);
 Object.assign(context,{retrievalFacts,...materialProjection(packet,episode,base.source.sourceRows),
  upstreamMaterialRule:'全剧方向与采用设计只约束表达和制作，不是剧情证据；原文事实、台词及揭示时点优先。references只提供参考说明，未读取图像像素；没有图片不冒充已完成素材。',
  contextEvidenceRule:'本集证据使用sourceRows及sourceRefs，不重复抄到contextRows；已有前场原句复用原contextRef。新增背景/历史contextRows保留精确原文和UTF16来源坐标；前情只有与同一绝对坐标逐字匹配的标准动作节点可作来源依据，仍不自动继承当前状态。对白含群体与分行对白、角色主张、备注及无类型依据的片段仅作guidance供理解/contextRefs引用，不能自证世界规则或entryFacts。'});
 const source=normalizeSource({...base.source,context,contextRows:[...existingRows,...extraRows],assets:semanticMaterial(base.source.assets)});
 const {directorNotes,sourceWarnings,...effectiveContext}=context;
 const sourceVersion=digest({inputProtocol:UPSTREAM_MATERIAL_PROTOCOL,content:episode.content,style:project.style,aspectRatio:project.aspectRatio,
  assets:source.assets,contextRows:source.contextRows,context:effectiveContext,...(source.standardPackage?{sourceProtocol:STANDARD_EPISODE_PROTOCOL,standardPackageId:source.standardPackage.packageId}:{})});
 return {...base,source,sourceVersion};
}

export function makeEpisodeInput({episode,project,handoff=null,notes='',independentSource=null,inputProtocol}){
 if(inputProtocol!==undefined&&!['legacy',STANDARD_EPISODE_PROTOCOL,UPSTREAM_MATERIAL_PROTOCOL].includes(inputProtocol))fail('SOURCE_PROTOCOL','未知正文输入协议');
 if(!episode?.id||!episode.content?.trim()||episode.projectId!==project?.id)fail('SOURCE_EMPTY','本集没有可用原文或项目归属不符');
 if(typeof notes!=='string'||notes.length>4000)fail('NOTES_LIMIT','导演要求最多4000字');
 const independent=independentSource?validateEpisodeSourceContext(independentSource,episode):null;
 const warnings=independent?['独立局部原剧本：前情单独提供；不继承本项目相邻集或旧资产，不含样稿分镜答案。']:[...(handoff?.reasons||[])];
 let packet=independent?{scenes:[{heading:independent.scene}]}:handoff?.packet;
 if(packet?.sourceText!==undefined&&packet.sourceText!==episode.content){if(packet.scriptReception)fail('STANDARD_SOURCE_BINDING','标准正文与当前原文不一致，请重新接收资料');warnings.push('交接资料与当前原文不一致，本次不沿用其中的旧资产与前情。');packet=null;}
 if(packet?.scriptReception){
  if(packet.scriptReception.version!==STANDARD_EPISODE_PROTOCOL)fail('SOURCE_PROTOCOL','未知正文接收协议');
  if(packet.scriptReception.ready!==true||!packet.standardScript)fail('SOURCE_DIAGNOSTICS',(packet.scriptReception.diagnostics||[]).map(d=>`第${d.line}行：${d.message}`).join('；')||'正文格式尚未通过接收检查');
 }
 warnings.push(...(packet?.warnings||[]));
 const previous=packet?.boundaryContext?.previousSource;
 const contextRows=independent?independent.contextRows:previous?.text?previous.text.split(/\r\n|\n|\r/).map((text,i)=>({id:`previous-${previous.episode}:excerpt-${i+1}`,text,kind:'context'})):[];
 const assets=packet?.assets||[];
 const continuity={previousSource:previous?{...previous,text:undefined}:null,priorStates:packet?.boundaryContext?.priorStates||[],gaps:packet?.boundaryContext?.gaps||[],rule:'前情与资产是有来源的线索，不无条件继承状态；以本集原文的最新变化为准。'};
 const context={projectStyle:project.style||null,aspectRatio:project.aspectRatio||'16:9',directorNotes:notes,scenes:packet?.scenes||[],continuity,followUps:packet?.followUps||[],sourceWarnings:[...new Set(warnings)],materialDependencies:packet?.materialDependencies||[],
  retrievalFacts:packet?.facts||null,confirmedDecisions:packet?.decisions||[],sourceContextVersion:packet?.sourceContextVersion??null,documentRevision:packet?.documentRevision??null,
  retrievalFactsRule:'retrievalFacts是带来源的检索证据，不是已语义确认的入口事实；角色主张、历史状态与未关联背景须核对本集适用性，不直接转成entryFacts。',
  ...(independent?{independentFragment:true,sourceOrigin:independent.origin,creationScope:'仅本集sourceRows是当前制作正文；contextRows只是此前已发生的原文依据，不补拍前情，不接续测试项目的相邻集。'}:{})};
 const parsed=packet?.scriptReception?normalizeSource(standardPackageSource(packet.standardScript,{key:episode.id,title:episode.title||`第${episode.number}集`,context,contextRows,sourceText:episode.content})):parseScript(episode.content,{key:episode.id,title:episode.title||`第${episode.number}集`,context,contextRows});
 const source=independent?normalizeSource({...parsed,entryFacts:independent.entryFacts}):parsed;
 source.assets=assets;
 const sourceVersion=digest({content:episode.content,style:project.style,aspectRatio:project.aspectRatio,assets,contextRows,scenes:context.scenes,continuity,followUps:context.followUps,materialDependencies:context.materialDependencies,retrievalFacts:context.retrievalFacts,confirmedDecisions:context.confirmedDecisions,sourceContextVersion:context.sourceContextVersion,documentRevision:context.documentRevision,...(independent?{independentSource:independent}:{}),...(packet?.scriptReception?{sourceProtocol:STANDARD_EPISODE_PROTOCOL,standardPackageId:packet.standardScript.packageId}:{})});
 const visualStyle=buildVisualStyle({style:project.style,aspectRatio:project.aspectRatio});
 const result={source,sourceVersion,visualStyle,warnings:[...new Set(warnings)],readiness:independent?'INDEPENDENT_FRAGMENT':handoff?.readiness||'SOURCE_ONLY'};
 return inputProtocol===UPSTREAM_MATERIAL_PROTOCOL&&!independent?withUpstreamMaterials(result,packet,episode,project):result;
}

function publicExecution(value){
 const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(Date.parse(v)).toISOString():null;
 const startedAt=time(value?.startedAt);
 if(!value||!['starting','waiting','generating','receiving','completed','failed'].includes(value.phase)||!startedAt)return undefined;
 const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
 const events=['thread.started','turn.started','turn.completed','turn.failed','item.started','item.updated','item.completed','error','other'];
 return {phase:value.phase,startedAt,lastEventAt:time(value.lastEventAt),lastProgressAt:time(value.lastProgressAt),eventCount:count(value.eventCount),timeoutKind:['startup','idle','total'].includes(value.timeoutKind)?value.timeoutKind:null,
  limits:Object.fromEntries(['startupMs','idleMs','totalMs'].map(k=>[k,count(value.limits?.[k])])),
  workload:{stage:['plan','author','finish'].includes(value.workload?.stage)?value.workload.stage:'unknown',promptChars:count(value.workload?.promptChars),unitCount:count(value.workload?.unitCount)},
  lastEventType:events.includes(value.lastEventType)?value.lastEventType:null};
}
export function publicRun(d,{active=false,sourceStale=false,cancellations=[],executions=[],scheduling,preparation={ready:true}}={}){
 const operations=d.operations||[],candidates=d.candidates||[];
 const executionByAttempt=new Map(executions.map(item=>[item.attemptId,publicExecution(item.execution)]));
 const preparationError=preparation.ready===false?{code:preparation.code||'CONTEXT_UNAVAILABLE',message:preparation.error||'原文或前情资料暂不可用；已保存记录保留。'}:null;
 sourceStale=Boolean(sourceStale||d.web?.sourceStale||preparationError);
 const usage={inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0,complete:true};
 const perAttempt=new Map(),receipts=new Map();
 for(const c of candidates)if(c.receipt)receipts.set(c.attemptId,c.receipt);
 for(const c of candidates)if(c.receipt?.usage)perAttempt.set(c.attemptId,c.receipt.usage);
 for(const op of operations)if(!perAttempt.has(op.attemptId)&&op.receipt?.usage)perAttempt.set(op.attemptId,op.receipt.usage);
 for(const op of operations){const u=perAttempt.get(op.attemptId);if(!u){if(op.error?.requestOutcome!=='NOT_SENT')usage.complete=false;continue;}for(const key of Object.keys(usage).filter(k=>k!=='complete'))if(Number.isFinite(u[key]))usage[key]+=u[key];else usage.complete=false;}
 usage.knownTokens=usage.totalTokens;
 usage.unknownAttempts=operations.filter(op=>op.error?.requestOutcome!=='NOT_SENT'&&!Number.isFinite(perAttempt.get(op.attemptId)?.totalTokens)).length;
 usage.acknowledgedUnknownAttempts=operations.filter(op=>op.cancelAcknowledgement?.acceptUnknownUsage===true&&!Number.isFinite(perAttempt.get(op.attemptId)?.totalTokens)).length;
 let selection=null,selectionError=null;
 if(d.plan)try{selection=resolveSelection(d.plan,d.choice);}catch(e){selectionError={code:e.code,message:e.message};}
 const plan=d.plan?Object.fromEntries(Object.entries(d.plan).filter(([k])=>k!=='sourceFingerprints')):null;
 const lastFailure=candidates.findLast(c=>['needs_repair','needs_dependency_repair','stale'].includes(c.status)&&!c.resolvedBy);
 const problems=[...(lastFailure?.errors||[]),...(lastFailure?.validation?.errors||[])];
 const problemMessages=[...new Set(problems.map(problem=>typeof problem==='string'?problem:[problem?.at,problem?.message,typeof problem?.detail==='object'?JSON.stringify(problem.detail):problem?.detail].filter(Boolean).join('：')||problem?.code||'候选校验未通过'))];
 const candidateError=lastFailure?{code:problems[0]?.code||'CANDIDATE_VALIDATION',message:problemMessages.slice(0,3).map(message=>message.slice(0,600)).join('；')||'已保存的候选未通过校验，请查看候选历史。'}:null;
 const interrupted=!active&&operations.some(o=>o.status==='running');
 const visibleProgress=['awaiting_confirmation','needs_design','budget_stop','usage_review','source_stale','waiting_dependencies','failed','unknown','pausing','paused','stopped'].includes(d.web?.progress)?d.web.progress:d.status;
 const attentionError=interrupted?{code:'INTERRUPTED',message:'上次服务中断或另一进程仍持有作业，请先核对已保存回执；不自动重发。'}:sourceStale||visibleProgress==='source_stale'?{code:'SOURCE_STALE',message:'原文或前情资料已更新，请新建任务使用最新资料；旧结果仍已保存。'}:visibleProgress==='usage_review'?{code:'USAGE_UNKNOWN',message:'回包已保存，但用量未完整返回。请先确认接受未知用量；只解除费用阻断，不自动重发，也不重跑已完成步骤。'}:visibleProgress==='unknown'||operations.some(o=>o.status==='unknown'&&!o.cancelAcknowledgement?.acceptUnknownUsage)?{code:'UNKNOWN',message:'有结果或用量未知的调用待处理：先检查已有回包；中断、超时或 CLI 失败须按下方回执核验结果，确认本机执行已结束且无可采用完整结果后，才可明确接受未知用量风险。已保存片段保留，确认不会自动重试。'}:null;
 return {id:d.id,title:d.web?.title||d.source?.title||d.id,status:interrupted?'interrupted':visibleProgress,createdAt:d.web?.createdAt,settings:d.settings,active,sourceStale,blocked:sourceStale,preparation,repairControl:repairControl(d),directorNotes:d.source?.context?.directorNotes||'',
  ...(scheduling?{scheduling:{maxConcurrent:scheduling.maxConcurrent,maxPerEpisode:scheduling.maxPerEpisode,inFlight:scheduling.inFlight,queued:scheduling.queued}}:{}),
  error:preparationError||d.web?.error||selectionError||attentionError||candidateError,sourceRows:d.source?.sourceRows||[],sourceWarnings:d.source?.context?.sourceWarnings||[],plan,choice:d.choice,selection,
  dialogue:(d.source?.dialogue||[]).map(({id,speaker,channel,cue,kind})=>({id,speaker,channel,cue,kind})),
  adopted:(d.adopted||[]).map(a=>({packageIds:a.packageIds,stage:a.stage,unitCount:a.draft.units.length,shotCount:a.draft.units.reduce((n,u)=>n+u.shots.length,0),seconds:a.draft.units.flatMap(u=>u.shots).reduce((n,s)=>n+s.duration,0)})),
  operations:operations.map(op=>{const {attemptId,stage,packageIds,status,finishMode,createdAt,error,cancelAcknowledgement,recovery,localSettledAt,cancelRequestedAt}=op;
   const receipt=receipts.get(attemptId)||op.receipt,durationMs=op.durationMs??receipt?.durationMs??op.receipt?.durationMs;
   return {attemptId,stage,packageIds,status,finishMode,createdAt,error,cancelAcknowledgement,localSettledAt,cancelRequestedAt,recoveryAt:recovery?.at||null,requestOutcome:receipt?.requestOutcome||op.receipt?.requestOutcome||error?.requestOutcome||null,
    ...(op.feedbackRepair?{feedbackRepair:true}:{}),...(Number.isFinite(durationMs)&&durationMs>=0?{durationMs}:{}),execution:executionByAttempt.get(attemptId),canRecoverSaved:hasPendingSavedResponse(d,op),usage:perAttempt.get(attemptId)||null};}),
  candidates:candidates.map(c=>{const {id,attemptId,stage,packageIds,status,errors,validation,requiredPackageIds,resolvedBy}=c;return {id,attemptId,stage,packageIds,status,errors,validation,requiredPackageIds,resolvedBy,canRecheck:!active&&!sourceStale&&canRecheckCandidate(d,c)};}),
  assembly:d.assembly?{text:d.assembly.text,...d.assembly.validation,draft:d.assembly.draft?{units:d.assembly.draft.units,fantasyRealization:d.assembly.draft.fantasyRealization}:null}:null,usage,cancellations,budget:{...d.web?.budget,maxRepairs:2},phase:d.web?.progress||null,lastCandidateId:lastFailure?.id||null};
}
