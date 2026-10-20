import {digest,fail} from './shared.mjs';

export const OPPORTUNITY_COVERAGE_VERSION='opportunity-coverage-v2';
export const OPPORTUNITY_COVERAGE_VERSIONS=['opportunity-coverage-v1',OPPORTUNITY_COVERAGE_VERSION];
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fields=['id','anchorRefs','subject','emotionPurpose','recommended','proposal','screenSecondsRange','extraSecondsRange'];
const point=x=>Object.fromEntries(fields.map(k=>[k,x[k]]));
const anchorKey=x=>digest({anchorRefs:[...x.anchorRefs].sort(),subject:x.subject.trim(),emotionPurpose:x.emotionPurpose.trim()});
const empty=x=>x===undefined||plain(x)&&Object.keys(x).length===0;
export const automaticOpportunities=choice=>['recommended','all'].includes(choice?.mode)&&empty(choice.overrides)&&empty(choice.unitOverrides)
 &&choice.confirmedFingerprint==null&&(choice.reviewRequiredIds===undefined||Array.isArray(choice.reviewRequiredIds)&&choice.reviewRequiredIds.length===0);

// Append-only automatic opportunities must not rewrite the input of an already paid operation.
// The live choice is still compared in full: a later cancellation cannot hide behind this basis.
const appendFields=['version','origin','mode','attemptId','candidateId','stage','outputHash','definitionHash','choiceHash','sourceHash','executionManifestHash','executionBatchId'];
const appendHash=origin=>digest(Object.fromEntries(appendFields.map(k=>[k,origin[k]])));
function validAppend(c,version){
 const o=c.opportunityOrigin;if(o?.version!==version)return false;
 if(version==='opportunity-coverage-v1')return true;
 return o.origin==='automatic_recommendation'&&['recommended','all'].includes(o.mode)&&['author','finish'].includes(o.stage)
  &&['attemptId','candidateId','outputHash','choiceHash','sourceHash'].every(k=>typeof o[k]==='string'&&o[k])
  &&o.definitionHash===digest(point(c))&&o.appendHash===appendHash(o);
}
export function opportunityInputBasis(plan,choice,saved,version=saved?.version??OPPORTUNITY_COVERAGE_VERSION){
 if(!OPPORTUNITY_COVERAGE_VERSIONS.includes(version))fail('OPPORTUNITY_BASIS','未知幻想冻结依据版本');
 const all=plan.fantasyCandidates;
 if(!saved)return {plan,basis:{version,candidateIds:all.map(c=>c.id),candidateHash:digest(all),choiceHash:digest(choice)}};
 if(saved.version!==version||!Array.isArray(saved.candidateIds)||new Set(saved.candidateIds).size!==saved.candidateIds.length
  ||saved.choiceHash!==digest(choice))fail('OPPORTUNITY_BASIS','幻想输入选择已变更或冻结依据无效，保留原回包');
 const candidates=saved.candidateIds.map(id=>all.find(c=>c.id===id));
 if(candidates.some(c=>!c)||digest(candidates)!==saved.candidateHash||all.some(c=>!saved.candidateIds.includes(c.id)&&!validAppend(c,version)))fail('OPPORTUNITY_BASIS','原候选被删除/修改或新增候选来源不明，不能伪还原原请求');
 return {plan:{...plan,fantasyCandidates:candidates},basis:structuredClone(saved)};
}

export function opportunityPolicy({stage,choice,executionBatch,executionLimited=false,refining=false,version=OPPORTUNITY_COVERAGE_VERSION}){
 const legacy=version==='opportunity-coverage-v1',limited=legacy&&(executionBatch||executionLimited);
 return {version,defaultOrigin:'project_policy_not_item_confirmation',confirmedContextTakesPrecedence:true,
  defaults:{emotion:'普通剧本也主动加强适合的表情、动作、互动、关系反差；强度随当拍起落',camera:'适合处以触发明确的快速路径、命中和可读落点加强，不把慢移或全程匀速当动态',fantasy:'允许推荐时主动找更多适合段落，兼查覆盖与力度；体验、趣味和视听冲击本身即增益，不需新增情节或节省秒数'},
  opportunityScan:['普通对话','试探','等待','误会','转场','配角与群像','人物关系','独立高潮'],
  selectionAuthority:automaticOpportunities(choice)?'automatic_mode_not_item_confirmation':'saved_selection_only',
  allowSupplements:stage!=='plan'&&!limited&&!refining&&automaticOpportunities(choice),
  scope:limited?'multi_batch_document_selected_only':refining?'refinement_selected_only':'current_source_rows_only'};
}

export const OPPORTUNITY_HINT='opportunityPolicy是项目默认演出策略，不是用户逐项确认；context中已确认的定调、限制与选择优先。强度与覆盖同时核，不因源无Q版或强情绪形容词就把普通段落视为不适合，不用一处强峰值抵销其他独立适配机会；有效克制、蓄势和慢停照留，不设次数、占比或时长配额。统筹仍只交既有fantasyCandidates，不添加fantasySupplements根字段；后续岗位按本次schema；settings.fantasyEnabled仅记原已选集合，新增许可另看allowSupplements。后续岗仅当allowSupplements=true，可在本次原有回包根字段fantasySupplements新增带源锚的推荐候选（字段同统筹fantasyCandidates），并在本次实际新写镜头及fantasyRealization兑现；差量必须随完整替换组兑现。不得只报建议、not_realized、借保留旧镜或前情补演；不修改旧候选、开关或工作包。其他情况fantasySupplements=[]，只执行已选机会，普通强表演/摄影仍可补强。不另开付费规划或审查。';

// Pure proposal: the caller commits the resulting plan only after all existing draft/feedback guards pass.
export function proposeOpportunityAppend({document:d,operation:op,candidate,request,output,normalizePlan}){
 const list=candidate.output?.fantasySupplements;
 if(list===undefined||Array.isArray(list)&&!list.length)return null;
 if(!Array.isArray(list)||request.opportunityPolicy?.allowSupplements!==true||!automaticOpportunities(d.choice)||!op.opportunityBasis
  ||op.opportunityBasis.choiceHash!==digest(d.choice))fail('OPPORTUNITY_AUTHORITY','本次不允许自动扩展幻想选择');
 const scope=new Set(request.source.sourceRows.map(r=>r.id)),newIds=new Set(),keys=new Set(),additions=[],selectedIds=[];
 const changedUnits=op.finishMode==='delta'?new Set(candidate.output.replacements.flatMap(g=>g.units.map(u=>u.id))):null;
 for(const raw of list){
  if(!plain(raw)||Object.keys(raw).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(raw,k))
   ||!Array.isArray(raw.anchorRefs)||!raw.anchorRefs.length||new Set(raw.anchorRefs).size!==raw.anchorRefs.length||raw.anchorRefs.some(r=>!scope.has(r))
   ||!['id','subject','emotionPurpose','proposal'].every(k=>typeof raw[k]==='string'&&raw[k].trim())||raw.recommended!==true
   ||!['screenSecondsRange','extraSecondsRange'].every(k=>Array.isArray(raw[k])&&raw[k].length===2&&raw[k].every(Number.isFinite)&&raw[k][0]>=0&&raw[k][1]>=raw[k][0])||raw.screenSecondsRange[1]<=0)fail('OPPORTUNITY_POINT','补充机会须为当前制作源内完整、有效的推荐候选');
  const c=point(raw),key=anchorKey(c),existing=d.plan.fantasyCandidates.find(x=>x.id===c.id);
  if(newIds.has(c.id)||keys.has(key)||d.plan.fantasyCandidates.some(x=>x.id!==c.id&&anchorKey(x)===key))fail('OPPORTUNITY_DUPLICATE','补充机会编号或同源同功能重复');
  newIds.add(c.id);keys.add(key);
  if(existing&&(existing.opportunityOrigin?.attemptId!==op.attemptId||digest(point(existing))!==digest(c)))fail('OPPORTUNITY_DUPLICATE','补充机会不能覆盖既有候选');
  const records=(output.fantasyRealization||[]).filter(f=>f.candidateId===c.id),f=records[0];
  const shots=output.units?.flatMap(u=>u.shots.map(s=>({...s,unitId:u.id})))||[];
  const shotIds=f?.screenSpans?.map(s=>s.shotId)??f?.shotIds??[];
  const realized=shots.filter(s=>shotIds.includes(s.id));
  if(records.length!==1||f.status!=='realized'||!Array.isArray(f.unitIds)||!f.unitIds.length||!realized.length
   ||changedUnits&&(f.unitIds.some(id=>!changedUnits.has(id))||realized.some(s=>!changedUnits.has(s.unitId)))
   ||c.anchorRefs.some(ref=>!realized.some(s=>s.sourceRefs?.includes(ref))))fail('OPPORTUNITY_NOT_REALIZED','补漏须在本次实际新写且对应源锚的镜头兑现，不能借旧稿或仅声明');
  selectedIds.push(c.id);
  if(!existing){
   const origin={version:op.opportunityBasis.version,origin:'automatic_recommendation',mode:d.choice.mode,attemptId:op.attemptId,candidateId:candidate.id,stage:op.stage,outputHash:digest(candidate.output)};
   if(origin.version===OPPORTUNITY_COVERAGE_VERSION){Object.assign(origin,{definitionHash:digest(c),choiceHash:op.opportunityBasis.choiceHash,sourceHash:digest(d.source),executionManifestHash:op.executionManifestHash??null,executionBatchId:op.executionBatchId??null});origin.appendHash=appendHash(origin);}
   additions.push({...c,opportunityOrigin:origin});
  }
 }
 // Reuse the full existing ownership validator, but preserve every old plan object byte-for-byte.
 normalizePlan({...d.plan,fantasyCandidates:[...d.plan.fantasyCandidates,...additions]},d.source,{unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy});
 return {plan:{...d.plan,fantasyCandidates:[...d.plan.fantasyCandidates,...additions]},selection:{...request.selection,selectedIds:[...new Set([...request.selection.selectedIds,...selectedIds])]},addedIds:additions.map(c=>c.id)};
}
