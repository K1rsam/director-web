import {createHash} from 'node:crypto';
import {prisma} from './prisma';
import {readLightEpisodeFoundation} from './light-foundation-reader';
import {readAssetDesignHandoff,type AssetDesignHandoff} from './asset-design-adoption';
import {resolveProvider,type runRoleByProvider} from './role-runner';
import {promptNeedsReview,type PromptWorkspace} from './asset-prompt-contract';

export type AssetMaterialNeed={workflowId:string;requestId:string;needRef:string;runId:string;episodeNumber:number;sourceVersion:string;target:string;purpose:string;sourceRefs:string[];packageIds:string[];blocking?:boolean};
export type AssetMaterialScope={workflowId:string;runId:string;episodeNumber:number;sourceVersion:string};
export type AssetCandidateDesign={provenance:'CANDIDATE_ONLY';version:string;brief:string;scope:AssetMaterialScope;needs:Pick<AssetMaterialNeed,'needRef'|'target'|'purpose'|'sourceRefs'|'packageIds'>[];limitations:string[]};
export type AssetMaterialCandidate={schema:'ASSET_MATERIAL_CANDIDATE_V1';id:string;key:string;status:'RUNNING'|'READY'|'FAILED';scope:AssetMaterialScope;needs:AssetMaterialNeed[];basisFingerprint:string;brief:string;limitations:string[];rawOutput?:string;error?:string;createdAt:string};
const key='ASSET_MATERIAL_CANDIDATE_V1',digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(value:unknown,max=200):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const references=(value:unknown):value is string[]=>Array.isArray(value)&&value.length>0&&value.length<=200&&value.every(item=>text(item))&&new Set(value).size===value.length;
const basis=(workspace:PromptWorkspace,assetKey:string,design?:AssetDesignHandoff)=>digest({asset:workspace.assets.find(a=>a.key===assetKey)?.fingerprint,prompt:workspace.records[assetKey]??null,design:design?.status==='TEXT_ADOPTED'||design?.status==='REFERENCE_ADOPTED'?{version:design.adoptionVersion,brief:design.brief}:null});
const scopeOf=(need:AssetMaterialNeed):AssetMaterialScope=>({workflowId:need.workflowId,runId:need.runId,episodeNumber:need.episodeNumber,sourceVersion:need.sourceVersion});

/** This is a private executor entry: the workflow first proves each need against its selected run. */
export async function generateScopedAssetMaterialCandidates(projectId:string,plan:{scope:{episodeNumbers:number[]};assetKeys:string[];sourceVersion:string},workspace:PromptWorkspace,needs:AssetMaterialNeed[],runner:typeof runRoleByProvider,check:()=>Promise<void>){
 if(!Array.isArray(needs)||!needs.length||needs.length>100)throw new Error('缺少当前任务的明确材料需求。');
 const seen=new Set<string>();
 for(const need of needs){
  if(!need||!['workflowId','requestId','needRef','runId','target'].every(field=>text(need[field as keyof AssetMaterialNeed]))||!text(need.purpose,2000)||!references(need.sourceRefs)||!references(need.packageIds)||!need.needRef.startsWith(`${need.requestId}:`)||seen.has(need.needRef))throw new Error('材料需求缺少唯一标识、包或原文坐标。');
  if(!plan.scope.episodeNumbers.includes(need.episodeNumber)||!plan.assetKeys.includes(need.target)||need.sourceVersion!==plan.sourceVersion)throw new Error('材料需求越出本次选集、资产或原文版本。');
  seen.add(need.needRef);
 }
 const groups=new Map<string,AssetMaterialNeed[]>();for(const need of needs){const id=JSON.stringify([scopeOf(need),need.target]);groups.set(id,[...groups.get(id)??[],need]);}
 const handoff=await readAssetDesignHandoff(projectId,[...new Set(needs.map(n=>n.target))],workspace),results:AssetMaterialCandidate[]=[];
 for(const requested of groups.values()){
  await check();const first=requested[0],scope=scopeOf(first),asset=workspace.assets.find(a=>a.key===first.target);if(!asset)throw new Error('所需材料不在当前目录。');
  const episode=await prisma.episode.findFirstOrThrow({where:{projectId,number:first.episodeNumber},select:{id:true,content:true}}),base=await readLightEpisodeFoundation(projectId,first.episodeNumber);
  if(base.packet.sourceVersion!==scope.sourceVersion)throw new Error('材料请求与当前原文版本不一致。');
  const actualKeys=new Set([...base.packet.assets.flatMap(a=>[a.key,...a.variants.map(v=>v.key)]),...base.packet.materialDependencies.map(a=>a.key)]);
  if(!actualKeys.has(first.target))throw new Error('所需材料不属于本集出场或必需派生来源。');
  const pkg=base.packet.standardScript;
  const sourceRows=pkg?pkg.script.entries.filter(entry=>entry.target==='BODY'||entry.target==='STRUCTURE').map(entry=>{const evidence=pkg.evidence.filter(unit=>entry.sourceUnitIds.includes(unit.id));return {id:`${episode.id}:${entry.id}`,text:episode.content.slice(evidence[0].start,evidence.at(-1)!.end),kind:entry.kind};}):episode.content.split(/\r\n|\n|\r/).map((line,i)=>({id:`${episode.id}:L${String(i+1).padStart(4,'0')}`,text:line,kind:'UNCLASSIFIED'}));
  const refs=[...new Set(requested.flatMap(n=>n.sourceRefs))];if(refs.some(ref=>!sourceRows.some(row=>row.id===ref)))throw new Error('材料需求引用的原文节点不属于当前集。');
  const design=handoff.find(d=>d.assetKey===first.target),basisFingerprint=basis(workspace,first.target,design);
  const id=`amc_${digest({scope,target:first.target,requested,basisFingerprint}).slice(0,48)}`,existing=await prisma.sceneSnapshot.findUnique({where:{id}});
  if(existing){const saved=JSON.parse(existing.content) as AssetMaterialCandidate;if(saved.status!=='READY')throw new Error('这份材料已有未结或失败回执，先核对已保存记录；不会自动重发。');results.push(saved);continue;}
  const stored:AssetMaterialCandidate={schema:key,id,key:first.target,status:'RUNNING',scope,needs:requested,basisFingerprint,brief:'',limitations:[],createdAt:new Date().toISOString()};
  try{await prisma.sceneSnapshot.create({data:{id,projectId,sceneKey:key,title:first.target,content:JSON.stringify(stored)}});}catch{throw new Error('材料请求已由另一执行者登记，请刷新核对，不重复调用。');}
  let rawOutput='';
  try{
   const project=await prisma.project.findUniqueOrThrow({where:{id:projectId}});await check();
   const result=await runner({projectId,provider:resolveProvider(project.executionMode),sessionMode:'ephemeral',role:{code:'ASSET_MATERIAL_NEED',skill:'',model:'gpt-6.1-sol',reasoningEffort:'medium',systemPrompt:'你是资产材料设计岗，只回答给定任务的局部材料需求，不写分镜、不重做全库。输出JSON {assetKey,brief,answeredNeedRefs,limitations}，brief至多600字且保留门、通路、遮挡、固定物或道具的实际功能；超限属于需局部返修，不截断内容。原文与已采用设计优先，角色对白只是主张。CANDIDATE_ONLY不是采用或事实：仅补未锁定且不影响剧情的美术细节。冲突或缺原文依据必须写limitations，不能推翻已锁定项、编造剧情出入口或道具能力。没有读取任何图像像素。'},prompt:JSON.stringify({asset:{key:asset.key,name:asset.name,type:asset.type},scope,materialNeeds:requested,sourceEvidence:sourceRows.filter(row=>refs.includes(row.id)),adoptedDesign:design&&['TEXT_ADOPTED','REFERENCE_ADOPTED'].includes(design.status)?{brief:design.brief,version:design.adoptionVersion}:null,existingDesign:workspace.records[first.target]?.body&&!promptNeedsReview(asset,workspace.records,workspace.assets)?{body:workspace.records[first.target].body,origin:workspace.records[first.target].origin,provenance:'DESIGN_NOT_SOURCE_FACT'}:null,style:workspace.stylePrefix,policy:'只读原文证据；候选仅供本次need的局部评估，不自动采用，不代表角色出场变化，不得改写已有正确设计。'})});
   rawOutput=result.rawOutput??JSON.stringify(result.data);const data=result.data as Record<string,unknown>;
   if(data.assetKey!==first.target||!text(data.brief,2400)||[...data.brief].length>600||!Array.isArray(data.answeredNeedRefs)||digest([...data.answeredNeedRefs].sort())!==digest(requested.map(n=>n.needRef).sort())||!Array.isArray(data.limitations)||data.limitations.some(v=>typeof v!=='string'||v.length>600))throw new Error('材料候选缺少完整需求回执或简述超出600字；原始返回已保留，需局部核对而非截断。');
   await check();
   const {loadAssetPromptWorkspace}=await import('./asset-prompt-service');const fresh=await loadAssetPromptWorkspace(projectId),freshDesign=(await readAssetDesignHandoff(projectId,[first.target],fresh))[0];
   if(basis(fresh,first.target,freshDesign)!==basisFingerprint)throw new Error('材料生成期间资产或采用设计已变化；保留回包，不当作当前候选。');
   const next:AssetMaterialCandidate={...stored,status:'READY',brief:data.brief.trim(),limitations:data.limitations as string[],rawOutput};await prisma.sceneSnapshot.update({where:{id},data:{content:JSON.stringify(next)}});results.push(next);
  }catch(error){const failed:AssetMaterialCandidate={...stored,status:'FAILED',rawOutput,error:(error as Error).message};await prisma.sceneSnapshot.update({where:{id},data:{content:JSON.stringify(failed)}});results.push(failed);break;}
 }
 return results;
}

/** No scope means no candidate. Candidates are never added to the global adopted-design registry. */
export async function readScopedAssetMaterialCandidates(projectId:string,scope:AssetMaterialScope,assetKeys:string[],workspace:PromptWorkspace):Promise<({assetKey:string}&AssetCandidateDesign)[]>{
 if(!text(scope.workflowId)||!text(scope.runId)||!Number.isSafeInteger(scope.episodeNumber)||scope.episodeNumber<0||!text(scope.sourceVersion))throw new Error('候选材料缺少明确任务范围。');
 const designs=await readAssetDesignHandoff(projectId,assetKeys,workspace),rows=await prisma.sceneSnapshot.findMany({where:{projectId,sceneKey:key,title:{in:assetKeys}},orderBy:[{createdAt:'asc'},{id:'asc'}]}),byNeed=new Map<string,{candidate:AssetMaterialCandidate;need:AssetMaterialNeed}>();
 // One asset can supply several independent work packages. A newer result replaces only
 // its own stable need, never another need that a saved work package already consumed.
 for(const row of rows){const candidate=JSON.parse(row.content) as AssetMaterialCandidate;if(candidate.schema!==key||candidate.status!=='READY'||digest(candidate.scope)!==digest(scope)||!assetKeys.includes(candidate.key)||candidate.basisFingerprint!==basis(workspace,candidate.key,designs.find(d=>d.assetKey===candidate.key)))continue;for(const need of candidate.needs)byNeed.set(JSON.stringify([candidate.key,need.needRef]),{candidate,need});}
 return [...byNeed.values()].map(({candidate:c,need:{needRef,target,purpose,sourceRefs,packageIds}})=>({assetKey:c.key,provenance:'CANDIDATE_ONLY',version:c.id,brief:c.brief,scope:c.scope,needs:[{needRef,target,purpose,sourceRefs,packageIds}],limitations:c.limitations}));
}

/** Recovery evidence only: callers still verify workflow membership and current need identity. */
export async function readScopedMaterialCandidateReceipt(projectId:string,workflowId:string,requestIds:string[]){
 const rows=await prisma.sceneSnapshot.findMany({where:{projectId,sceneKey:key}});
 return rows.map(row=>JSON.parse(row.content) as AssetMaterialCandidate).filter(c=>c.schema===key&&c.scope.workflowId===workflowId&&c.needs.some(n=>requestIds.includes(n.requestId))).map(({id,key,status,scope,needs,error})=>({id,key,status,scope,needRefs:needs.map(n=>n.needRef),error}));
}
