import {assertDecisionChanges,decisionAssetFieldAllowed} from './foundation-decision-targets';
import {readApplicationScope,scopeApplies} from './foundation-application-scope';
import type {FoundationChoiceView} from './foundation-choice-store';
import type {FoundationDocument} from './foundation-document';
import type {ProductionOptimization,SceneFieldPatch} from './foundation-production-contracts';
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const fields=(value:object)=>value as Record<string,unknown>;
const fail=(reason:string):never=>{throw new Error(`限定字段合入停止：${reason}；原稿与原始响应保留。`);};
type SceneBefore = Pick<SceneFieldPatch,'episode'|'sceneKey'> & { [K in Exclude<keyof SceneFieldPatch,'episode'|'sceneKey'>]?: SceneFieldPatch[K] | null };
export type DecisionPatchProjection = {output:ProductionOptimization;after:FoundationDocument;correctedFields:string[]};

/** Pure projection after structural parsing. The caller supplies the full normal
 * production validator/applicator; a projected result is never trusted alone.
 * Unknown structural dependencies fail closed. Receipts affected by trimming
 * need retained effect; untouched choices retain the existing no-change contract. */
export function projectDecisionChanges(args:{
 choices:FoundationChoiceView[];scope:number[];output:ProductionOptimization;
 before:FoundationDocument;after:FoundationDocument;
 validateAndApply:(output:ProductionOptimization)=>{output:ProductionOptimization;after:FoundationDocument};
 beforeScenes?:readonly SceneBefore[];
}):DecisionPatchProjection {
 const {choices,scope,before,after}=args;
 if(!choices.length||choices.some(choice=>!choice.changeTargets)) {
  assertDecisionChanges(choices,scope,args.output,before,after);
  return {output:args.output,after,correctedFields:[]};
 }
 if(!before.f2||!after.f2)fail('缺少当前资产原稿');
 const output=structuredClone(args.output),correctedFields:string[]=[];
 const affectedChoices=new Set<string>();let trimmedActualChange=false;
 if(output.changes.removeAssetKeys?.length||output.changes.mergeAssets?.length||output.changes.sceneSplits?.length)fail('新增、删除、归并、拆场不能通过字段投影授权');
 if(after.f2!.assets.length!==before.f2!.assets.length||after.f2!.assets.some(asset=>!before.f2!.assets.some(old=>old.key===asset.key)))fail('资产身份集合改变');
 if(output.changes.overview!==undefined||output.changes.episodes?.length)fail('当前确认不授权总览或分集摘要');
 const allowedAsset=(choiceSet:FoundationChoiceView[],key:string,field:string)=>{
  const old=before.f2!.assets.find(asset=>asset.key===key),next=after.f2!.assets.find(asset=>asset.key===key);
  if(!old||!next)return false;
  return decisionAssetFieldAllowed(choiceSet,key,field,old,next);
 };
 const revertedNames:string[]=[];
 for(const patch of output.changes.assets??[]) {
  if(!patch.key)fail('新增资产没有已授权身份键');
  const old=before.f2!.assets.find(asset=>asset.key===patch.key),next=after.f2!.assets.find(asset=>asset.key===patch.key);
  if(!old||!next)fail('未知资产身份键');
  for(const field of new Set([...Object.keys(old!),...Object.keys(next!)])) {
   if(equal(fields(old!)[field],fields(next!)[field])||allowedAsset(choices,patch.key!,field))continue;
   // Scope, variant identity, classification and source links are not independent values.
   if(!['name','role','relationNote','aliases','preparation'].includes(field))fail(`assets.${patch.key}.${field}涉及身份或引用依赖`);
   if(field==='preparation'&&!equal(old!.preparation?.fromKey,next!.preparation?.fromKey))fail(`assets.${patch.key}.preparation.fromKey涉及来源依赖`);
   if(field==='name')revertedNames.push(next!.name);
   if(field==='aliases')revertedNames.push(...next!.aliases.filter(alias=>!old!.aliases.includes(alias)));
   if(field==='aliases'||fields(old!)[field]===undefined)delete fields(patch)[field];
   else fields(patch)[field]=structuredClone(fields(old!)[field]);
   correctedFields.push(`assets.${patch.key}.${field}`);
   trimmedActualChange=true;
   for(const choice of choices)if(choice.changeTargets!.assetKeys.includes(patch.key!))affectedChoices.add(choice.id);
  }
 }
 if(output.changes.assets)output.changes.assets=output.changes.assets.filter(patch=>{
  const old=before.f2!.assets.find(asset=>asset.key===patch.key)!,next=after.f2!.assets.find(asset=>asset.key===patch.key)!;
  const retainsChange=Object.keys(next).some(field=>!equal(fields(old)[field],fields(next)[field])&&allowedAsset(choices,patch.key!,field));
  if(!retainsChange)correctedFields.push(`assets.${patch.key}.noRetainedChange`);
  return retainsChange;
 });
 output.changes.scenes=(output.changes.scenes??[]).flatMap(patch=>{
  const projected=structuredClone(patch);
  for(const field of Object.keys(projected).filter(key=>!['episode','sceneKey'].includes(key))) {
   if(choices.some(choice=>choice.changeTargets!.sceneFields.some(allowed=>allowed===field)&&scopeApplies(readApplicationScope(choice.applicationScope,choice.episodes),patch.episode,patch.sceneKey)))continue;
   delete fields(projected)[field];correctedFields.push(`scenes.${patch.episode}.${patch.sceneKey}.${field}`);
   const original=args.beforeScenes?.find(scene=>scene.episode===patch.episode&&scene.sceneKey===patch.sceneKey);
   if(!original||!equal(fields(original)[field],fields(patch)[field])) {
    trimmedActualChange=true;
    for(const choice of choices)if(choice.changeTargets!.sceneFields.length&&scopeApplies(readApplicationScope(choice.applicationScope,choice.episodes),patch.episode,patch.sceneKey))affectedChoices.add(choice.id);
   }
  }
  return Object.keys(projected).length>2?[projected]:[];
 });
 if(!args.output.changes.scenes)delete output.changes.scenes;
 if(revertedNames.length){
  const retained=structuredClone(output.changes);
  // Reverted values are absent now. Any retained mention of a proposed name is
  // a dependency we cannot safely rewrite or reinterpret.
  const mentions=(value:unknown):boolean=>typeof value==='string'?revertedNames.some(name=>name.length>0&&value.includes(name)):Array.isArray(value)?value.some(mentions):!!value&&typeof value==='object'&&Object.values(value).some(mentions);
  if(mentions(retained))fail('被还原名称或别名仍被其它保留字段引用');
 }
 const checked=args.validateAndApply(output);
 assertDecisionChanges(choices,scope,checked.output,before,checked.after);
 if(trimmedActualChange){
  const hasEffect=(choiceSet:FoundationChoiceView[])=>{
   const assetsChanged=checked.after.f2!.assets.some(next=>{
    const old=before.f2!.assets.find(asset=>asset.key===next.key)!;
    return Object.keys(next).some(field=>!equal(fields(old)[field],fields(next)[field])&&allowedAsset(choiceSet,next.key,field));
   });
   const scenesChanged=(checked.output.changes.scenes??[]).some(patch=>{
    const old=args.beforeScenes?.find(scene=>scene.episode===patch.episode&&scene.sceneKey===patch.sceneKey);
    return old&&Object.keys(patch).some(field=>!['episode','sceneKey'].includes(field)&&!equal(fields(old)[field],fields(patch)[field])&&choiceSet.some(choice=>choice.changeTargets!.sceneFields.some(allowed=>allowed===field)&&scopeApplies(readApplicationScope(choice.applicationScope,choice.episodes),patch.episode,patch.sceneKey)));
   });
   return assetsChanged||scenesChanged;
  };
  if(!hasEffect(choices))fail('投影后没有可证实的授权实际修改，不能接受完成回执');
  for(const receipt of checked.output.appliedDecisions??[]){
   const choice=choices.find(item=>item.id===receipt.id);
   if(!choice||affectedChoices.has(choice.id)&&!hasEffect([choice]))fail(`确认回执${receipt.id}没有保留的授权实际修改`);
  }
 }
 return {...checked,correctedFields};
}
