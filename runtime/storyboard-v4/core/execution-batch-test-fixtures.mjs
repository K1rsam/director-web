import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {normalizePlan} from './core.mjs';
import {VERSION,PLAN_VERSION} from './shared.mjs';

const emotion={subject:'甲',contextTone:'紧张',audienceEffect:'期待',change:'从犹豫到决定',landing:'决定行动',retain:['原话','连续因果']};
export function fixture(count=9){
 const source={key:'batches',sourceRows:Array.from({length:count},(_,i)=>({id:`s${i+1}`,text:`甲：第${i+1}句。`})),contextRows:[],entryFacts:[],assets:[]};
 const ids=source.sourceRows.map(r=>r.id);
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'共同决定行动',entryFacts:[],events:[{id:'e1',sourceRefs:ids,sceneKey:'屋内',boundaryBefore:{kind:'episode_start',reason:'完整事件入口'},emotionContract:emotion}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:ids,emotionContract:emotion,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:ids.map((ref,i)=>({id:`pu${i+1}`,packageId:'p1',sourceRefs:[ref],secondsRange:[26,30]})),fantasyCandidates:[]};
 return {source,plan,settings:{maxUnits:null,maxUnitSeconds:30,fantasyMode:'off',visualStyle:'固定测试画风'},choice:{mode:'off',overrides:{},unitOverrides:{},confirmedFingerprint:null}};
}
// Entirely synthetic: preserve batching, wrapped dialogue and cross-unit fantasy shapes, not production content.
export function v3Fixture(){
 const sourceRows=[],provisionalUnits=[],rowCounts=[7,6,6,7,9,7,7,7,5],dialogueCounts=[3,3,3,4,7,4,4,3,3];
 const secondsRanges=[[26,29],[22,25],[26,29],[26,30],[28,30],[27,30],[26,29],[26,29],[15,18]];
 let dialogueNumber=0;
 const append=text=>{const line=sourceRows.length+1,id=`synthetic-L${String(line).padStart(3,'0')}`;sourceRows.push({id,line,text},{id:`synthetic-L${String(line+1).padStart(3,'0')}`,line:line+1,text:''});return id;};
 for(let i=0;i<rowCounts.length;i++){
  const sourceRefs=[];
  for(let j=0;j<dialogueCounts[i];j++){
   const n=++dialogueNumber,wrapped=i===7&&j===2,speaker=n%6===0?'甲（OS）':'甲';
   sourceRefs.push(append(`${speaker}：第${n}次准备好了${wrapped?'':'。'}`));
   if(wrapped)sourceRefs.push(append('。'));
  }
  while(sourceRefs.length<rowCounts[i])sourceRefs.push(append(`△甲检查第${i+1}组的第${sourceRefs.length+1}个标记。`));
  provisionalUnits.push({id:`U${String(i+1).padStart(2,'0')}`,packageId:'WP01',sourceRefs,secondsRange:secondsRanges[i]});
 }
 const sourceRefs=provisionalUnits.flatMap(u=>u.sourceRefs),source={key:'synthetic-v3-workload',title:'合成执行分批测试',sourceRows,contextRows:[],entryFacts:[],assets:[]};
 const anchors=[[provisionalUnits[0].sourceRefs[0]],[provisionalUnits[1].sourceRefs[0]],[provisionalUnits[3].sourceRefs.at(-1),provisionalUnits[4].sourceRefs[0]],[provisionalUnits[6].sourceRefs.at(-1),provisionalUnits[7].sourceRefs[0]],[provisionalUnits[8].sourceRefs[0]]];
 const fantasyCandidates=anchors.map((anchorRefs,i)=>({id:`FC${String(i+1).padStart(2,'0')}`,anchorRefs,subject:'甲',emotionPurpose:`第${i+1}次确认后更有信心`,recommended:true,proposal:'主观小化身点头后消失',screenSecondsRange:[1,2],extraSecondsRange:[0,1]}));
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'依次确认准备，最后决定前行',entryFacts:[],events:[{id:'EV01',sourceRefs,sceneKey:'屋内',boundaryBefore:{kind:'episode_start',reason:'合成事件开始'},emotionContract:emotion}],workPackages:[{id:'WP01',eventId:'EV01',sourceRefs,emotionContract:emotion,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits,fantasyCandidates};
 return {source,plan,settings:{maxUnits:null,maxUnitSeconds:30,fantasyMode:'all',visualStyle:'固定测试画风'},choice:{mode:'all',overrides:{},unitOverrides:{U03:false,U06:false},confirmedFingerprint:null},voiceReference:null};
}

// Deterministic transport fixture, not a professional creative sample or timing assessment.
export function draftForRequest(request){
 const prefix=request.executionBatch?.id||request.packageId,seen=new Set(),events=request.plan.events||[];
 const units=request.plan.provisionalUnits.map((rough,i)=>{
  const quotes=request.source.dialogue.filter(q=>!seen.has(q.id)&&q.sourceIds.some(ref=>rough.sourceRefs.includes(ref)));
  for(const q of quotes)seen.add(q.id);
  const qs=quotes.length?quotes:[null],duration=quotes.length<=1?10:3;
  return {id:`${prefix}-u${i+1}`,eventId:events.find(e=>rough.sourceRefs.some(ref=>e.sourceRefs.includes(ref)))?.id||'e1',boundaryBefore:{kind:request.executionBatch?.index>0||i?'continuous':'episode_start',reason:'同一事件自然承接'},title:'继续行动',unitDirection:'眉眼先松开，再转向门口，原话连续。',intent:{subject:'甲',change:'作出决定',landing:'准备前行',retain:['原话']},scene:'日 内 屋内',props:[],participants:['甲'],lighting:'窗侧自然光',initialState:'站在门内',exitState:`已说完${quotes.at(-1)?.id||rough.id}`,shots:qs.map((q,j)=>({id:`${prefix}-s${i+1}-${j+1}`,duration,camera:'正面近景',picture:'甲抬眼作出决定。',lighting:'窗侧自然光',sound:'现场声',dialogueParts:q?[{lineId:q.id,text:q.quote,presentation:['OS','VO','系统音'].includes(q.channel)?q.channel:'画内',delivery:'自然连读',voiceStart:0,voiceEnd:duration-1}]:[],transition:'接下一句',sourceRefs:j?q.sourceIds:rough.sourceRefs,contextRefs:[]}))};
 });
 const fantasyRealization=request.plan.fantasyCandidates.map(c=>{const linked=units.flatMap(u=>u.shots.filter(s=>s.sourceRefs.some(ref=>c.anchorRefs.includes(ref))).map(s=>({unitId:u.id,shotId:s.id})));return {candidateId:c.id,unitIds:[...new Set(linked.map(x=>x.unitId))],shotIds:linked.map(x=>x.shotId),screenSeconds:1,entry:'主观造型随念头出现',exit:'念头落定后接回现实',domain:'主观',preservedFunction:c.emotionPurpose,status:'realized'};});
 return {schemaVersion:VERSION,units,fantasyRealization};
}

export async function seeded(t,run=async r=>({output:draftForRequest(r)}),f=fixture()){
 const directory=await mkdtemp(path.join(tmpdir(),'v4-execution-batch-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const requests=[],engine=createEngine({directory,modelRunner:async r=>{requests.push(r);const result=await run(r);return {...result,raw:result.raw??JSON.stringify(result.output),requestOutcome:'RESPONDED',usage:{totalTokens:10}};}});
 await engine.create({id:'batch',source:f.source,settings:f.settings});
 await createStore(directory).update('batch',d=>{d.plan=normalizePlan(f.plan,d.source);d.choice=f.choice;d.status='planned';return d;});
 return {directory,engine,requests,store:createStore(directory)};
}
