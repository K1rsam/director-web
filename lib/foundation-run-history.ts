type TimedRun={id:string;stageCode:string;status:string;inputSummary:string|null;log:string|null;durationMs:number|null;startedAt:Date|null;finishedAt:Date|null};
const parsed=(text:string|null):Record<string,unknown>=>{try{return JSON.parse(text??'{}')??{};}catch{return {};}};
export function foundationHistoryRuns<T extends TimedRun>(latest:T|null|undefined,history:readonly T[]=[]):T[]{
 if(!latest)return [];
 const task=parsed(latest.inputSummary).deliveryTaskId;
 if(typeof task!=='string'||!task)return [latest];
 return [...new Map([...history,latest].filter(run=>run.stageCode===latest.stageCode&&parsed(run.inputSummary).deliveryTaskId===task).map(run=>[run.id,run])).values()];
}
export function foundationRunDuration(run:TimedRun):number|null{
 if(!['SUCCEEDED','FAILED','CANCELED'].includes(run.status))return null;
 if(typeof run.durationMs==='number'&&Number.isFinite(run.durationMs)&&run.durationMs>=0)return run.durationMs;
 const start=run.startedAt?.getTime(),end=run.finishedAt?.getTime();
 if(start!==undefined&&end!==undefined&&Number.isFinite(start)&&Number.isFinite(end)&&end>=start)return end-start;
 const calls=parsed(run.log).calls;
 if(!Array.isArray(calls)||!calls.length)return null;
 const ranges=calls.map(call=>{
  if(!call||typeof call.startedAt!=='string'||typeof call.finishedAt!=='string')return null;
  const a=Date.parse(call.startedAt),b=Date.parse(call.finishedAt);
  return Number.isFinite(a)&&Number.isFinite(b)&&b>=a?[a,b]:null;
 });
 if(ranges.some(range=>!range))return null;
 return Math.max(...ranges.map(range=>range![1]))-Math.min(...ranges.map(range=>range![0]));
}
export function foundationHistoryDuration(runs:readonly TimedRun[]):number|null{
 if(!runs.length)return null;
 const values=runs.map(foundationRunDuration);
 return values.some(value=>value===null)?null:values.reduce<number>((sum,value)=>sum+value!,0);
}
