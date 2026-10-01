import {fail} from './shared.mjs';
import {buildExecutionBatches} from './execution-batches.mjs';

export const AUTHOR_CALL_GROUPING_VERSION='adjacent-short-tail-v1';
const overlap=(a,b)=>a.some(id=>b.includes(id));
const live=o=>o.status==='running'||o.status==='unknown'&&o.cancelAcknowledgement?.acceptUnknownUsage!==true;
const enabled=d=>d.rulesSnapshot?.authorCallGroupingVersion===AUTHOR_CALL_GROUPING_VERSION&&d.plan?.unitPackingPolicy==='event-first-v1';
const sourceOrder=d=>{
 const rank=new Map(d.source.sourceRows.map((r,i)=>[r.id,i]));
 return d.plan.workPackages.map(w=>({...w,first:Math.min(...w.sourceRefs.map(id=>rank.get(id))),last:Math.max(...w.sourceRefs.map(id=>rank.get(id)))})).sort((a,b)=>a.first-b.first);
};

// These are eligibility bounds for one transport call, never creative duration or unit limits.
function validGroup(d,packageIds){
 if(!enabled(d)||packageIds.length!==2||packageIds[0]===packageIds[1])return false;
 const ordered=sourceOrder(d),index=ordered.findIndex(w=>w.id===packageIds[0]),parent=ordered[index],child=ordered[index+1];
 if(!parent||child?.id!==packageIds[1]||parent.last>=child.first||!child.dependsOn.includes(parent.id))return false;
 const units=d.plan.provisionalUnits.filter(u=>packageIds.includes(u.packageId)),tail=units.filter(u=>u.packageId===child.id);
 if(tail.length!==1||tail[0].secondsRange[1]>6||units.length>5||units.reduce((n,u)=>n+u.secondsRange[1],0)>150)return false;
 return packageIds.every(packageId=>{const m=buildExecutionBatches({...d,packageId});return m.batches.length===1&&!m.batches[0].exceedsSoftTarget;});
}

export function validateAuthorCallGroup(d,packageIds){
 if(!validGroup(d,packageIds))fail('PACKAGE','作者合批仅支持新版相邻、依赖明确且负荷有界的双工作包短尾组合');
 return {version:AUTHOR_CALL_GROUPING_VERSION,packageIds:[...packageIds]};
}

function fresh(d,packageIds,reserved=[]){
 return !overlap(packageIds,reserved)&&!d.adopted.some(a=>overlap(a.packageIds,packageIds))
  &&!d.operations.some(o=>live(o)&&overlap(o.packageIds,packageIds))
  &&!packageIds.some(id=>d.executionBatches?.[id])
  &&!d.candidates.some(c=>!c.resolvedBy&&overlap([...(c.packageIds||[]),...(c.requiredPackageIds||[])],packageIds)&&(c.raw?.trim()||c.output!=null||c.draft!=null||['needs_repair','needs_dependency_repair'].includes(c.status)));
}

export function assertFreshAuthorCallGroup(d,packageIds){
 if(!fresh(d,packageIds))fail('AUTHOR_GROUP_STATE','合批范围已有在途、采用或已保存待修正文，须保留原作业范围');
}

export function readyAuthorCallGroups(d,reservedPackageIds=[]){
 const adopted=new Set(d.adopted.flatMap(a=>a.packageIds)),reserved=new Set(reservedPackageIds),result=[];
 const available=w=>!adopted.has(w.id)&&!reserved.has(w.id)&&!d.operations.some(o=>live(o)&&o.packageIds.includes(w.id));
 const ordered=enabled(d)?sourceOrder(d):d.plan.workPackages;
 for(const parent of ordered){
  if(!available(parent)||!parent.dependsOn.every(id=>adopted.has(id)))continue;
  const child=ordered[ordered.indexOf(parent)+1],pair=child?[parent.id,child.id]:null;
  const group=pair&&validGroup(d,pair)&&fresh(d,pair,[...reserved])&&child.dependsOn.every(id=>pair.includes(id)||adopted.has(id))?pair:[parent.id];
  result.push(group);for(const id of group)reserved.add(id);
 }
 return result;
}
