import {readSeriesDirectionProjection} from './series-direction-service';
import {readAssetDesignHandoff,ADOPTED_DESIGN_TEXT_VERSION,type AssetDesignHandoff} from './asset-design-adoption';
import {readLightEpisodeFoundation} from './light-foundation-reader';
import {createHash} from 'node:crypto';
import {isProductionEpisodeNumber,readProductionScope} from './production-episodes';
import {buildAssetProductionCards,episodeVisualFacts,type AssetProductionCard} from './asset-design-model-input';
import {readScopedAssetMaterialCandidates,type AssetMaterialScope,type AssetCandidateDesign} from './asset-material-candidates';
import type {ScriptPerformanceOptions} from './standard-script-reception';
import {createInflightRead,retryDatabaseRead,upstreamReadKey} from './production-read-guard';

export const EPISODE_UPSTREAM_VERSION='EPISODE_UPSTREAM_V1' as const;
type BaseHandoff=Awaited<ReturnType<typeof readLightEpisodeFoundation>>;
type Direction=Awaited<ReturnType<typeof readSeriesDirectionProjection>>;

/** Only episode-scoped, explicitly bound adopted text may accompany the legacy brief; never unadopted history. */
export function attachEpisodeMaterials(base:BaseHandoff,direction:Direction,designs:AssetDesignHandoff[],material?:{scope:AssetMaterialScope;candidates:({assetKey:string}&AssetCandidateDesign)[]}) {
 const keys=new Set([...base.packet.assets.flatMap(a=>[a.key!,...a.variants.map(v=>v.key!)]),...base.packet.materialDependencies.map(d=>d.key)]);
 if(direction.status==='CONFIRMED'&&(!direction.projection?.brief||[...direction.projection.brief].length>600))throw new Error('全剧方向投影无效，未以空方向继续。');
 const selected=designs.filter(d=>keys.has(d.assetKey)).map(({visualFacts,...design})=>({...design,...(visualFacts?{visualFacts:episodeVisualFacts(visualFacts,base.packet.episode,base.packet.sourceText)}:{})}));
 if(new Set(selected.map(d=>d.assetKey)).size!==selected.length)throw new Error('采用设计存在重复身份，未合并猜测。');
 for(const design of selected)if(['TEXT_ADOPTED','REFERENCE_ADOPTED'].includes(design.status)&&(!design.brief?.trim()||[...design.brief].length>600))throw new Error('已采用设计缺少有效简述。');
 const effective=selected.filter(d=>d.status==='TEXT_ADOPTED'||d.status==='REFERENCE_ADOPTED');
 if(material&&(material.scope.episodeNumber!==base.packet.episode||material.scope.sourceVersion!==base.packet.sourceVersion||material.candidates.some(c=>JSON.stringify(c.scope)!==JSON.stringify(material.scope)||!keys.has(c.assetKey))))throw new Error('候选材料不属于本集和当前任务范围。');
 const packet={...base.packet,upstream:{version:EPISODE_UPSTREAM_VERSION,seriesDirection:direction,
   ...(material?.candidates.length?{materialCandidateScope:material.scope}:{}),
   seriesKnowledge:direction.status==='CONFIRMED'?direction.projection?.seriesKnowledge??[]:[],assetProductionCards:buildAssetProductionCards(base.packet,selected,material?.candidates),
   assetDesigns:selected,modelDesigns:effective.map(({assetKey,adoptionVersion,brief,materialAvailability,references,fullText})=>({assetKey,adoptionVersion,brief,materialAvailability,...(fullText?{fullText:structuredClone(fullText)}:{}),references:references.map(({id,description,available})=>({id,description,available}))})),
   policy:'全剧方向只约束表达，不改原文事实与揭示时点；采用设计是制作材料，不是剧情证据。已有采用设计优先；CANDIDATE_ONLY只回答指定任务need，供局部评估与回执，不是全局采用或源事实，不可推翻关键锁定。只读参考说明，未读取图像像素；未采用或缺图片不冒充已完成素材。'}};
 return {...base,packet,materialVersion:createHash('sha256').update(JSON.stringify(packet)).digest('hex')};
}

type EvidenceOptions = ScriptPerformanceOptions & {episodeEvidenceVersion?: 'episode-evidence-v1' | null;adoptedDesignTextVersion?:typeof ADOPTED_DESIGN_TEXT_VERSION|null};
async function readHandoffSnapshot(projectId:string,episodeNumber:number,productionScope?:{workflowId:string;runId:string},options:EvidenceOptions={}) {
 if(!isProductionEpisodeNumber(episodeNumber,await readProductionScope(projectId)))throw new Error('此来源尚未归入可制作正文，请先核对来源分区。');
 const base=await readLightEpisodeFoundation(projectId,episodeNumber,undefined,options);
 const {prisma}=await import('./prisma');
 const episode=await prisma.episode.findFirstOrThrow({where:{projectId,number:episodeNumber},select:{id:true}});
 const keys=[...base.packet.assets.flatMap(a=>[a.key!,...a.variants.map(v=>v.key!)]),...base.packet.materialDependencies.map(d=>d.key)];
 const workspace=productionScope?await(await import('./asset-prompt-service')).loadAssetPromptWorkspace(projectId):undefined;
 const [direction,designs]=await Promise.all([readSeriesDirectionProjection(projectId,episode.id),keys.length?readAssetDesignHandoff(projectId,keys,workspace,{adoptedDesignTextVersion:options.adoptedDesignTextVersion}):Promise.resolve([])]);
 let material:Parameters<typeof attachEpisodeMaterials>[3];
 if(productionScope){const scope={...productionScope,episodeNumber,sourceVersion:base.packet.sourceVersion};material={scope,candidates:await readScopedAssetMaterialCandidates(projectId,scope,keys,workspace!)};}
 return attachEpisodeMaterials(base,direction,designs,material);
}

/** Both assemblies are read-only; changing inputs require a refresh, never a mixed-version handoff. */
const readHandoffInFlight=createInflightRead<Awaited<ReturnType<typeof readHandoffSnapshot>>>();
export async function readProductionEpisodeHandoff(projectId:string,episodeNumber:number,productionScope?:{workflowId:string;runId:string},options:EvidenceOptions={}) {
 return readHandoffInFlight(upstreamReadKey(projectId,episodeNumber,productionScope,options),()=>retryDatabaseRead(async()=>{
  const before=await readHandoffSnapshot(projectId,episodeNumber,productionScope,options),after=await readHandoffSnapshot(projectId,episodeNumber,productionScope,options);
  if(before.materialVersion!==after.materialVersion)throw Object.assign(new Error('来源、全剧方向或采用设计在读取期间更新，请刷新后重试；未投递混合版本。'),{status:409,code:'UPSTREAM_CHANGED'});
  return after;
 }));
}

/** UI-only read view of the same cards consumed by Stage 3; not a model input or sufficiency verdict. */
export type AssetPreparationReview={schema:'ASSET_PREPARATION_REVIEW_V1';projectId:string;episodes:{
 episodeNumber:number;sourceVersion:string;materialVersion:string;readiness:BaseHandoff['readiness'];reasons:BaseHandoff['reasons'];
 directionStatus:Direction['status'];cards:AssetProductionCard[];
}[]};
export async function readAssetPreparationReview(projectId:string,episodeNumbers:number[],readHandoff=readProductionEpisodeHandoff):Promise<AssetPreparationReview>{
 if(!Array.isArray(episodeNumbers)||!episodeNumbers.length||episodeNumbers.length>1000||episodeNumbers.some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('请明确选择有效制作集数；空白时仅浏览，不整理全剧。');
 const episodes:AssetPreparationReview['episodes']=[];
 for(const number of [...new Set(episodeNumbers)].sort((a,b)=>a-b)){
  const handoff=await readHandoff(projectId,number),packet=handoff.packet;
  if(packet.episode!==number)throw new Error('生产卡不属于本集，未混用其他集材料。');
  if(episodes.length&&packet.sourceVersion!==episodes[0].sourceVersion)throw Object.assign(new Error('来源在读取期间更新，请刷新后重新查看；未合并不同源稿。'),{status:409,code:'UPSTREAM_CHANGED'});
  episodes.push({episodeNumber:number,sourceVersion:packet.sourceVersion,materialVersion:handoff.materialVersion,readiness:handoff.readiness,reasons:handoff.reasons,
   directionStatus:packet.upstream.seriesDirection.status,cards:packet.upstream.assetProductionCards});
 }
 return {schema:'ASSET_PREPARATION_REVIEW_V1',projectId,episodes};
}
