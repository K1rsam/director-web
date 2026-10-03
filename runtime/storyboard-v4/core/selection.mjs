import {digest,fail} from './shared.mjs';

const modes=new Set(['off','all','recommended','review']);
const candidates=plan=>plan.fantasyCandidates||[];
const units=plan=>plan.provisionalUnits||[];
const refs=x=>[...new Set(x||[])].sort();
const own=(object,key)=>object&&Object.hasOwn(object,key)?object[key]:undefined;
const anchorKey=c=>digest({anchors:refs(c.anchorRefs),subject:c.subject,emotionPurpose:c.emotionPurpose});
const signature=(plan,c)=>({anchors:refs(c.anchorRefs),subject:c.subject,emotionPurpose:c.emotionPurpose,source:refs(c.anchorRefs).map(id=>[id,plan.sourceFingerprints?.[id]??null])});
export function selectionFingerprint(plan,choice){
  const opportunities=candidates(plan).map(c=>({point:signature(plan,c),override:own(choice?.overrides,c.id)??null})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const unitChoices=units(plan).filter(u=>typeof own(choice?.unitOverrides,u.id)==='boolean').flatMap(u=>refs(u.sourceRefs).map(ref=>[ref,own(choice.unitOverrides,u.id)])).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return digest({mode:choice?.mode||'off',opportunities,unitChoices});
}
function validate(plan,choice){
  if(!modes.has(choice?.mode))fail('SELECTION_MODE','未知幻想选择模式');
  const ids=candidates(plan).map(c=>c.id);
  if(new Set(ids).size!==ids.length)fail('SELECTION_CANDIDATE_ID','幻想候选ID重复');
  for(const [id,value] of Object.entries(choice.overrides||{}))if(!ids.includes(id)||typeof value!=='boolean')fail('SELECTION_OVERRIDE',`无效候选覆盖: ${id}`);
  for(const [id,value] of Object.entries(choice.unitOverrides||{}))if(!units(plan).some(u=>u.id===id)||typeof value!=='boolean')fail('SELECTION_UNIT_OVERRIDE',`无效单元覆盖: ${id}`);
}
function mapping(plan){
  const map=new Map();
  for(const c of candidates(plan))map.set(c.id,units(plan).filter(u=>c.anchorRefs?.some(ref=>u.sourceRefs?.includes(ref))).map(u=>u.id));
  return map;
}
export function resolveSelection(plan,choice){
  validate(plan,choice);
  const map=mapping(plan),byUnit=Object.fromEntries(units(plan).map(u=>[u.id,[]])),selectedIds=[];
  for(const c of candidates(plan)){
    const mapped=map.get(c.id);
    const base=choice.mode==='all'||((choice.mode==='recommended'||choice.mode==='review')&&!!c.recommended);
    const votes=mapped.map(id=>own(choice.unitOverrides,id)).filter(v=>typeof v==='boolean');
    if(own(choice.overrides,c.id)===undefined&&new Set(votes).size>1)fail('SELECTION_UNIT_CONFLICT',`候选${c.id}跨单元选择冲突`);
    const unitVote=votes[0];
    const selected=own(choice.overrides,c.id)??unitVote??base;
    if(selected){selectedIds.push(c.id);for(const id of mapped)byUnit[id].push(c.id);}
  }
  // "All" selects available opportunities, not a fantasy quota for every rough unit.
  // Only an explicit unit request needs a design when no candidate covers it.
  const unfulfilledUnitIds=units(plan).filter(u=>own(choice.unitOverrides,u.id)===true&&![...map.values()].some(mapped=>mapped.includes(u.id))).map(u=>u.id);
  const fingerprint=selectionFingerprint(plan,choice);
  const status=unfulfilledUnitIds.length?'needs_design':choice.mode==='review'&&choice.confirmedFingerprint!==fingerprint?'awaiting_confirmation':'ready';
  return {mode:choice.mode,status,selectedIds,byUnit,unfulfilledUnitIds,fingerprint};
}
export function confirmSelection(plan,choice,selectedIds,expectedFingerprint){
  validate(plan,choice);
  const current=selectionFingerprint(plan,choice);
  if(expectedFingerprint!==current)fail('SELECTION_FINGERPRINT','幻想选择指纹过期');
  const ids=new Set(candidates(plan).map(c=>c.id)),selected=new Set(selectedIds);
  if(selected.size!==selectedIds.length||[...selected].some(id=>!ids.has(id)))fail('SELECTION_CONFIRM_IDS','确认包含未知或重复候选');
  const confirmed={...choice,overrides:Object.fromEntries(candidates(plan).map(c=>[c.id,selected.has(c.id)])),reviewRequiredIds:[]};
  confirmed.confirmedFingerprint=selectionFingerprint(plan,confirmed);
  return confirmed;
}
export function rebaseSelection(previousPlan,nextPlan,choice){
  validate(previousPlan,choice);
  const next=candidates(nextPlan),byId=new Map(next.map(c=>[c.id,c])),byAnchor=new Map();
  for(const c of next){const key=anchorKey(c);byAnchor.set(key,[...(byAnchor.get(key)||[]),c]);}
  const overrides={},reviewRequiredIds=[];
  const matched=new Set();
  for(const old of candidates(previousPlan)){
    const matches=byAnchor.get(anchorKey(old))||[];
    const found=(matches.length===1?matches[0]:null)||byId.get(old.id);
    if(!found)continue;
    matched.add(found.id);
    if(choice.reviewRequiredIds?.includes(old.id))reviewRequiredIds.push(found.id);
    if(anchorKey(old)===anchorKey(found)&&typeof own(choice.overrides,old.id)==='boolean')overrides[found.id]=own(choice.overrides,old.id);
    if(digest(signature(previousPlan,old))!==digest(signature(nextPlan,found)))reviewRequiredIds.push(found.id);
  }
  for(const c of next)if(!matched.has(c.id))reviewRequiredIds.push(c.id);
  const nextUnits=units(nextPlan),unitOverrides={};
  for(const old of units(previousPlan)){
    const value=own(choice.unitOverrides,old.id);
    if(typeof value!=='boolean')continue;
    const matches=nextUnits.filter(u=>u.sourceRefs?.length&&u.sourceRefs.every(ref=>old.sourceRefs?.includes(ref)));
    for(const target of matches)unitOverrides[target.id]=value;
  }
  const rebased={...choice,overrides,unitOverrides,reviewRequiredIds:[...new Set(reviewRequiredIds)]};
  // The fingerprint excludes unit numbering, unrelated source rows, and recommendation refreshes.
  rebased.confirmedFingerprint=choice.confirmedFingerprint===selectionFingerprint(nextPlan,rebased)?choice.confirmedFingerprint:null;
  return rebased;
}
