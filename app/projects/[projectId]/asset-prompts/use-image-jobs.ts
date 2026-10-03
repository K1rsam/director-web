'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {ImageJob} from '@/lib/asset-image-job-contract';

/** One private read owner for the grid and editor. No dispatch, shared response
 * cache, or cross-project state; late reads cannot replace a newer lifecycle. */
export function useProjectImageJobs(projectId:string,materialVersion:string){
 const [snapshot,setSnapshot]=useState<{projectId:string;jobs:ImageJob[]}>({projectId,jobs:[]}),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const lifecycle=useRef(0),sequence=useRef(0),active=useRef(false);
 const flight=useRef<Promise<ImageJob[]>|null>(null),forcedFlight=useRef<Promise<ImageJob[]>|null>(null),controller=useRef<AbortController|null>(null);
 const endpoint=`/projects/${projectId}/asset-prompts/images`;
 const read=useCallback(async(force=false):Promise<ImageJob[]>=>{
  const generation=lifecycle.current;
  const issue=async()=>{
  if(generation!==lifecycle.current)throw new Error('图片读取范围已变化。');
  if(flight.current)return flight.current;
  const id=++sequence.current,signal=controller.current?.signal;
  const pending=(async()=>{
   const response=await fetch(endpoint,{cache:'no-store',signal}),next=await response.json();
   if(!response.ok||!Array.isArray(next.jobs))throw new Error(next.error||'暂时无法读取图片任务。');
   if(generation===lifecycle.current&&id===sequence.current&&!signal?.aborted){
    setSnapshot({projectId,jobs:next.jobs});setError('');active.current=next.jobs.some((job:ImageJob)=>['WAITING_EXECUTOR','RUNNING'].includes(job.status));
   }
   return next.jobs as ImageJob[];
  })();
  flight.current=pending;
  try{return await pending;}finally{if(flight.current===pending)flight.current=null;}
  };
  if(!force)return flight.current??forcedFlight.current??issue();
  if(forcedFlight.current)return forcedFlight.current;
  // A forced read follows an older background read; concurrent forced readers
  // share that follow-up instead of each starting another request afterwards.
  const pending=(async()=>{if(flight.current)await flight.current.catch(()=>{});return issue();})();
  forcedFlight.current=pending;
  try{return await pending;}finally{if(forcedFlight.current===pending)forcedFlight.current=null;}
 },[endpoint,projectId]);
 useEffect(()=>{
  ++lifecycle.current;controller.current=new AbortController();flight.current=null;forcedFlight.current=null;active.current=false;setLoading(true);setError('');
  let ended=false,polling=false,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   if(ended||polling)return;
   clearTimeout(timer);polling=true;
   if(!document.hidden)try{await read();}catch{if(!ended)setError('图片任务读取暂未完成，请刷新核对。');}finally{if(!ended)setLoading(false);}
   polling=false;if(!ended)timer=setTimeout(()=>void poll(),active.current?5000:30000);
  };
  const visible=()=>{if(!document.hidden){clearTimeout(timer);void poll();}};
  void poll();document.addEventListener('visibilitychange',visible);
  return()=>{ended=true;++lifecycle.current;controller.current?.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[read,materialVersion]);
 return {jobs:snapshot.projectId===projectId?snapshot.jobs:[],loading,error,refresh:()=>read(true)};
}
