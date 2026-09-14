import {isDeepStrictEqual} from 'node:util';
import type {DeliveryRepairPlanner} from './foundation-delivery-call';

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Only duplicate complete records are removable. Conflicting proposals require
 * a source-backed edit; screenplay arrays and author decisions are never deduped. */
export function normalizeStageRecords(value:unknown):unknown {
 if(!record(value))return value;
 const result=structuredClone(value);
 const dedup=(items:unknown)=>Array.isArray(items)?items.filter((item,i)=>!items.slice(0,i).some(old=>isDeepStrictEqual(old,item))):items;
 if(result.format==='ASSET_CATALOG_V3' || String(result.format).startsWith('ASSET_CATALOG_'))result.assets=dedup(result.assets);
 if(record(result.changes))for(const field of ['assets','scenes'])if(Array.isArray(result.changes[field]))result.changes[field]=dedup(result.changes[field]);
 return result;
}
export function validateStageRecords<T>(value:unknown,validate:(value:unknown)=>T):T {
 const normalized=normalizeStageRecords(value);
 if(isDeepStrictEqual(normalized,value))return validate(value);
 try{return validate(normalized);}catch{
  // A failed normalized array would shift error coordinates relative to the
  // retained provider response. Diagnose the original instead; never patch a different row.
  return validate(value);
 }
}

/** A failed object stays in the saved response. The responsible role receives
 * only its object and the relevant source already supplied to the original call. */
export function stageRepairPlanner(request:Record<string,unknown>,systemPrompt:string):DeliveryRepairPlanner {
 return ({stage,candidate,issues})=>{
  if(!record(candidate)||!['F2','Q1'].includes(stage))return null;
  const paths:string[]=[],objects:Record<string,unknown>[]=[],episodes=new Set<number>();
  for(const issue of issues){
   if(issue.owner!=='PROGRAM')continue;
   const path=issue.coordinate.replace(/^\$\./,'').replace(/\[(\d+)\]/g,'.$1');
   const match=/^(assets|changes\.(?:assets|scenes|sceneSplits))\.(\d+)(?:\.|$)/.exec(path);
   if(!match||stage==='F2'&&match[1]!=='assets'||stage==='Q1'&&!match[1].startsWith('changes.'))return null;
   const array=match[1].split('.').reduce<unknown>((v,k)=>record(v)?v[k]:undefined,candidate);
   const item=Array.isArray(array)?array[Number(match[2])]:undefined;
   if(!record(item))return null;
   const root=match[1]+'.'+match[2];
   // Keep the complete object as evidence, but authorize only the diagnosed
   // existing field (or nearest existing parent when that field is missing).
   let target=path;
   const at=(p:string)=>p.split('.').reduce<unknown>((v,k)=>record(v)||Array.isArray(v)?(v as Record<string,unknown>)[k]:undefined,candidate);
   while(target!==root&&at(target)===undefined)target=target.slice(0,target.lastIndexOf('.'));
   if(!paths.some(p=>target===p||target.startsWith(p+'.'))){
    for(let i=paths.length-1;i>=0;i--)if(paths[i].startsWith(target+'.'))paths.splice(i,1);
    paths.push(target);
   }
   if(!objects.some(o=>o.path===root))objects.push({path:root,value:item});
   const ns=Array.isArray(item.episodes)?item.episodes:typeof item.episode==='number'?[item.episode]:[];
   for(const n of ns)if(typeof n==='number')episodes.add(n);
   if(!ns.length&&typeof item.key==='string'){
    const prior=record(request.candidates)&&record(request.candidates.f2)&&Array.isArray(request.candidates.f2.assets)?request.candidates.f2.assets.find(a=>record(a)&&a.key===item.key):undefined;
    if(record(prior))for(const n of (Array.isArray(prior.usageEpisodes)?prior.usageEpisodes:Array.isArray(prior.episodes)?prior.episodes:[]))if(typeof n==='number')episodes.add(n);
   }
  }
  if(!paths.length||paths.length>8||!episodes.size)return null;
  const scope=Array.isArray(request.scope)?request.scope:[];
  if([...episodes].some(n=>!scope.includes(n)))return null;
  const source=record(request.source)&&Array.isArray(request.source.episodes)?request.source.episodes.filter(e=>record(e)&&episodes.has(Number(e.number))):[];
  if(!source.length)return null;
  const scenes=Array.isArray(request.scenes)?request.scenes.filter(s=>record(s)&&episodes.has(Number(s.episode))):[];
  const values=objects.map(o=>o.value).filter(record),keys=new Set(values.flatMap(v=>[v.key,record(v.preparation)?v.preparation.fromKey:undefined]).filter((x):x is string=>typeof x==='string'));
  const catalog=record(request.candidates)&&record(request.candidates.f2)?request.candidates.f2:null;
  const assets=catalog&&Array.isArray(catalog.assets)?catalog.assets.filter(a=>record(a)&&(keys.has(String(a.key))||Array.isArray(a.usageEpisodes)&&a.usageEpisodes.some(n=>episodes.has(Number(n))))):[];
  const registry=Array.isArray(request.registry)?request.registry.filter(a=>record(a)&&keys.has(String(a.key))):[];
  const choices=Array.isArray(request.humanChoiceRegistry)?request.humanChoiceRegistry.filter(c=>record(c)&&Array.isArray(c.episodes)&&c.episodes.some(n=>episodes.has(Number(n)))):[];
  const evidence={scope:[...episodes],allowedPaths:paths,objects,issues,source,scenes,assets,registry,choices,delivery:request.delivery};
  const prompt='你继续履行本岗位Skill。上一份成果已保存，只修错误；objects是上下文，只有allowedPaths能写。返回 {"format":"FIELD_REPAIR_V1","patches":[{"path":"allowedPaths中的准确路径","value":"该路径的修正值"}]}。不返回全包，不修改原文，不补造事实，不更改用户决定；省略补丁不能算解决。程序保留其它字段并完整复验。\nINPUT_JSON:\n'+JSON.stringify(evidence);
  if(prompt.length>32000)return null; // Never truncate source to force a request through.
  return {paths,systemPrompt,prompt,evidence};
 };
}
