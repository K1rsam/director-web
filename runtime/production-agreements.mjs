import {createStore} from './storyboard-v4/core/store.mjs';
import {digest,fail} from './storyboard-v4/core/shared.mjs';

// A larger evidence view does not change the source on which a shared choice was made.
export function agreementSourceBasis(seed){
 const sources=[seed?.previousSource,seed?.currentOpening];
 if(sources.some(s=>!s||typeof s.sourceTextHash!=='string'||!s.sourceTextHash||!Number.isSafeInteger(s.sourceLength)||s.sourceLength<0))
  fail('AGREEMENT_SOURCE_UNVERIFIED','制作约定缺少可校验的完整原文依据，请先重新读取边界。');
 return digest({fromEpisode:seed.fromEpisode,toEpisode:seed.toEpisode,sources:sources.map(s=>({episode:s.episode,sourceTextHash:s.sourceTextHash,sourceLength:s.sourceLength}))});
}

export function createAgreementStore(directory){
 const store=createStore(directory);
 const key=({chainId,fromEpisode,toEpisode})=>digest({chainId,fromEpisode,toEpisode});
 const supersede=(d,at)=>[...(d.supersededProposals||[]),{producerRunId:d.producerRunId,choices:d.choices,version:d.version,createdAt:d.createdAt,supersededAt:at}];
 return {
  async read(boundary){try{return await store.read(key(boundary));}catch(e){if(e.code==='ENOENT')return null;throw e;}},
  async seal(boundary,{sourceBasis,predecessorRunId,selectedSuccessorRunId}){
   const id=key(boundary),at=new Date().toISOString();
   // Admission and the first proposal contend for this same durable record.
   try{return await store.create(id,{schema:'PRODUCTION_AGREEMENT_V1',...boundary,sourceBasis,choices:[],producerRunId:null,sealed:true,sealedAt:at,predecessorRunId,createdAt:at,version:digest({sourceBasis,choices:[]})});}
   catch(e){if(e.code!=='EXISTS')throw e;}
   return store.update(id,d=>{
    if(d.sourceBasis!==sourceBasis)fail('AGREEMENT_SOURCE_CHANGED','主创开工前的制作约定依据已变，已有记录保留。');
    if(d.sealed)return d;
    const stale=selectedSuccessorRunId!==undefined&&d.producerRunId!==selectedSuccessorRunId;
    return {...d,...(stale?{choices:[],producerRunId:null,supersededProposals:supersede(d,at),version:digest({sourceBasis,choices:[]})}:{}),sealed:true,sealedAt:at,predecessorRunId};
   });
  },
  async publish(boundary,{sourceBasis,choices,producerRunId,predecessorUnstarted}){
   if(!Array.isArray(choices)||choices.some(c=>c.authority!=='DESIGN'||!c.key||!c.value))fail('PRODUCTION_AGREEMENT','制作约定必须是最小设计选择，不能冒充原文事实。');
   const id=key(boundary);let old;try{old=await store.read(id);}catch(e){if(e.code!=='ENOENT')throw e;}
   if(old){
    // Caller holds the chain selection lock; only its selected successor may publish.
    return store.update(id,d=>{
     if(d.sourceBasis!==sourceBasis)fail('AGREEMENT_SOURCE_CHANGED','制作约定的边界来源已变，请保留历史并核对新来源。');
     if(!d.sealed&&predecessorUnstarted&&d.producerRunId!==producerRunId&&choices.length){
      const at=new Date().toISOString();return {...d,choices:structuredClone(choices),producerRunId,createdAt:at,supersededProposals:supersede(d,at),version:digest({sourceBasis,choices})};
     }
     const saved=new Map(d.choices.map(c=>[c.key,c.value]));
     return choices.some(c=>saved.has(c.key)&&saved.get(c.key)!==c.value)?{...d,proposalConflict:true}:d;
    });
   }
   // Once the preceding author has started, a later prediction cannot impose a new lock on it.
   if(!predecessorUnstarted||!choices.length)return null;
   try{return await store.create(id,{schema:'PRODUCTION_AGREEMENT_V1',...boundary,sourceBasis,choices:structuredClone(choices),producerRunId,createdAt:new Date().toISOString(),version:digest({sourceBasis,choices})});}
   catch(e){if(e.code==='EXISTS')return this.publish(boundary,{sourceBasis,choices,producerRunId,predecessorUnstarted});throw e;}
  }
 };
}
