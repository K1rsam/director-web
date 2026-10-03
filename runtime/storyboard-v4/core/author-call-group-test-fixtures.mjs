import {PLAN_VERSION,VERSION} from './shared.mjs';

export const groupingVersion='adjacent-short-tail-v1';
export function tailFixture(){
 const source={key:'adjacent-tail',sourceRows:[...Array.from({length:5},(_,i)=>({id:`s${i+1}`,text:`甲：第${i+1}句。`})),{id:'s6',text:'△办公室内，甲推门入内。'}],contextRows:[],entryFacts:[],assets:[]};
 const emotion=i=>({subject:'甲',contextTone:`第${i}段的紧张`,audienceEffect:`期待第${i}段落点`,change:'从犹豫到决定',landing:`第${i}段作出决定`,retain:['原话','连续因果']});
 const spans=[['s1','s2','s3'],['s4','s5'],['s6']],scenes=['走廊','楼梯','办公室'];
 const events=spans.map((sourceRefs,i)=>({id:`e${i+1}`,sourceRefs,sceneKey:scenes[i],boundaryBefore:{kind:i?'time_space_jump':'episode_start',reason:i?'原文进入下一场景':'本集开始'},emotionContract:emotion(i+1)}));
 const workPackages=spans.map((sourceRefs,i)=>({id:`p${i+1}`,eventId:`e${i+1}`,sourceRefs,emotionContract:emotion(i+1),entryFactIds:[],contextRefs:[],dependsOn:i===2?['p2']:[],scenarioKeys:[]}));
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'三段各自完整的情绪走向',entryFacts:[],events,workPackages,provisionalUnits:spans.flatMap((refs,i)=>refs.map((ref,j)=>({id:`pu${i+1}-${j+1}`,packageId:`p${i+1}`,sourceRefs:[ref],secondsRange:i===2?[2,4]:i?[26,30]:[27,30]}))),fantasyCandidates:[]};
 return {source,plan,settings:{maxUnits:null,maxUnitSeconds:30,fantasyMode:'off',visualStyle:'固定测试画风'},choice:{mode:'off',overrides:{},unitOverrides:{},confirmedFingerprint:null}};
}

// A deterministic transport fixture; it does not assess professional creative quality.
export function tailDraft(request){
 const seen=new Set();
 const units=request.plan.provisionalUnits.map(rough=>{
  const owner=request.plan.workPackages.find(w=>w.id===rough.packageId),event=request.plan.events.find(e=>e.id===owner.eventId),first=!seen.has(event.id);seen.add(event.id);
  const quotes=request.source.dialogue.filter(q=>q.sourceIds.some(ref=>rough.sourceRefs.includes(ref))),duration=owner.id==='p3'?3:28;
  return {id:`${owner.id}-${rough.id}`,eventId:event.id,boundaryBefore:first?event.boundaryBefore:{kind:'capacity',reason:'本事件连续动作超过单元容量'},title:'继续行动',unitDirection:'眉眼先松开，再转向门口，原话连续。',intent:{subject:'甲',change:'作出决定',landing:event.emotionContract.landing,retain:['原话']},scene:`日 内 ${event.sceneKey}`,props:[],participants:['甲'],lighting:'窗侧自然光',initialState:'站在门内',exitState:`已完成${rough.id}`,shots:[{id:`${owner.id}-${rough.id}-s1`,duration,camera:'正面近景',picture:'甲抬眼作出决定。',lighting:'窗侧自然光',sound:'现场声',dialogueParts:quotes.map(q=>({lineId:q.id,text:q.quote,presentation:'画内',delivery:'自然连读',voiceStart:0,voiceEnd:duration-1})),transition:'接下一段',sourceRefs:rough.sourceRefs,contextRefs:[]}]};
 });
 return {schemaVersion:VERSION,units,fantasyRealization:[]};
}
