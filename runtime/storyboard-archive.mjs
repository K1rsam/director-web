import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {createStore} from './storyboard-v4/core/store.mjs';

export function withStoryboardArchive(current,archiveRoot){
 const archive=createStore(archiveRoot);
 const mark=d=>({...d,web:{...d.web,legacyReadOnly:true}});
 const read=async id=>{try{return await current.read(id);}catch(e){if(e.code!=='ENOENT')throw e;return mark(await archive.read(id));}};
 const methods=['start','replan','repair','refine','acceptRefinement','pause','stop','choose','confirm','recover','recoverSaved','reviewBoundary','resolveSource','acknowledgeCancelled','recheck','setBudget'];
 const facade={...current,read,
  async list(binding={}){
   const active=await current.list(binding),ids=new Set(active.map(d=>d.id));
   const names=await readdir(path.join(archiveRoot,'documents')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));
   const prior=await Promise.all(names.filter(n=>n.endsWith('.json')&&!ids.has(n.slice(0,-5))).map(n=>archive.read(n.slice(0,-5))));
   return [...active,...prior.map(mark)].filter(d=>(!binding.episodeId||d.web?.binding?.episodeId===binding.episodeId)&&(!binding.projectId||d.web?.binding?.projectId===binding.projectId));
  }};
 for(const method of methods)facade[method]=async(id,...args)=>{
  const d=await read(id);if(d.web?.legacyReadOnly)throw Object.assign(new Error('这是旧版第三阶段记录，仅可查看与导出；请新建任务使用新版引擎。'),{code:'LEGACY_READ_ONLY',requestOutcome:'NOT_SENT'});
  return current[method](id,...args);
 };
 return facade;
}
