import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules,normalizePlan} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {VERSION,PLAN_VERSION,digest} from './shared.mjs';
import {buildShotHandoffs,resolveShotHandoffs} from './shot-handoffs.mjs';
import {normalizeDraft,validateDraft,renderDraft} from './quality.mjs';
import {DELTA_VERSION} from './delta.mjs';
import {createEngine} from './pipeline.mjs';
import {buildReviewPacket} from '../review-packet.mjs';
import {projectModelCoordinates,restoreModelCoordinates} from './model-coordinates.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const settings={maxUnitSeconds:30,maxUnits:null,fantasyMode:'off'};
function fixture(){
 const source=normalizeSource({key:'shot-handoffs',sourceRows:[{id:'r1',text:'△甲把铜环沿桌面滑给窗边的乙。'},{id:'r2',text:'△乙左手接住铜环。'},{id:'r3',text:'△次日，甲在院内望向门口。'}]});
 const emotion={subject:'甲乙',contextTone:'试探',audienceEffect:'看清交接',change:'推出到接住',landing:'铜环到乙左手',retain:['同一次桌面交接与接触']};
 const plan=normalizePlan({schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'交接后次日等候',entryFacts:[],events:[{id:'e1',sourceRefs:['r1','r2'],sceneKey:'屋内',boundaryBefore:{kind:'episode_start',reason:'桌边交接开始'},emotionContract:emotion},{id:'e2',sourceRefs:['r3'],sceneKey:'院内',boundaryBefore:{kind:'time_space_jump',reason:'源为次日院内'},emotionContract:{...emotion,change:'交接后等候',landing:'甲望门口'}}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:['r1','r2'],emotionContract:emotion,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]},{id:'p2',eventId:'e2',sourceRefs:['r3'],emotionContract:{...emotion,change:'交接后等候',landing:'甲望门口'},entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'pu1',packageId:'p1',sourceRefs:['r1'],secondsRange:[10,12]},{id:'pu2',packageId:'p1',sourceRefs:['r2'],secondsRange:[6,8]},{id:'pu3',packageId:'p2',sourceRefs:['r3'],secondsRange:[2,3]}],fantasyCandidates:[]},source);
 const shot=(id,ref,duration,picture,transition)=>({id,duration,camera:'同一桌侧中近景',picture,lighting:'窗光照亮桌面',sound:'衣袖声与铜环擦桌声',dialogueParts:[],transition,sourceRefs:[ref],contextRefs:[]});
 const unit=(id,eventId,kind,shots)=>({id,eventId,boundaryBefore:{kind,reason:kind==='time_space_jump'?'次日院内':'同次桌边交接'},title:id,unitDirection:'沿桌面跟随交接，让铜环和左手接触可见。',intent:{subject:'甲乙',change:'推出到接住',landing:'铜环到乙左手',retain:['原动作先后']},scene:eventId==='e1'?'日 内 屋内':'次日 外 院内',props:eventId==='e1'?['铜环']:[],participants:eventId==='e1'?['甲','乙']:['甲'],visualSubjects:[],lighting:'窗光',initialState:'甲在桌边，乙左手在窗边桌沿前。',exitState:'铜环沿桌面滑向乙，交接尚未完成。',shots});
 const draft={schemaVersion:VERSION,units:[unit('p1-u1','e1','episode_start',[shot('p1-s1','r1',5,'甲把铜环放到桌面，右手指尖抵着环缘。','沿甲的右手指尖接下镜。'),shot('p1-s2','r1',7,'甲推出铜环，铜环滑出画面。','动作顺接下一单元。')]),unit('p1-u2','e1','continuous',[shot('p1-s3','r2',8,'乙已经拿着铜环。','停在乙手部。')]),unit('p2-u1','e2','time_space_jump',[{...shot('p2-s1','r3',3,'次日院内，甲站在门前，抬眼望向院门。','目光落到院门。'),camera:'院墙内朝门的固定中景',sound:'院中鸟鸣'}])],fantasyRealization:[]};
 Object.assign(draft.units[2],{unitDirection:'院内甲抬眼望向门口，目光落定后结束。',intent:{subject:'甲',change:'抬眼望门',landing:'目光落在院门',retain:['次日院内时点']},lighting:'日光照亮院墙',initialState:'次日院内，甲站在门前。',exitState:'甲朝院门望着，双手垂在身侧。'});
 draft.units[2].shots[0].lighting='日光照亮甲的面部与院墙';
 return {source,plan,draft};
}
const request=(f,rulesSnapshot=captureRules())=>buildRequest({stage:'finish',source:f.source,settings,plan:f.plan,packageIds:['p1','p2'],previousDraft:f.draft,finishMode:'delta',rulesSnapshot});

test('finish receives current bound adjacent shot pairs, including merged-segment and scene exceptions',()=>{
 const f=fixture(),before=structuredClone(f),req=request(f);
 assert.equal(req.editingHandoffs?.version,'shot-handoffs-v1','finish lacks actual-draft cut-pair evidence');
 assert.equal(req.editingHandoffs.cutPairs.length,3);
 assert.deepEqual(f,before,'inspection cannot repair or retime the work');
});

test('unknown handoff snapshots fail closed rather than silently dropping the review evidence',()=>{
 assert.throws(()=>request(fixture(),{...captureRules(),editingHandoffVersion:'future'}),e=>e.code==='RULE_SNAPSHOT');
});


function repair(draft){
 const next=structuredClone(draft),out=next.units[0].shots.at(-1),into=next.units[1].shots[0];
 out.picture='甲松开右手，铜环沿桌面向窗边的乙滑去；环缘刚越过画面右侧即切。';
 out.transition='铜环越过右画框时切乙手边，接同一次朝窗边的滑行。';
 into.camera='同一桌侧的手部近景，窗框留在乙身后。';
 into.picture='铜环从左画缘滑入，仍沿桌面朝窗边前进；乙的左掌在桌沿前迎住环缘，手指合拢时铜环停下。';
 next.units[0].exitState='铜环刚越过右画框，仍沿桌面朝窗边滑动。';
 next.units[1].initialState='铜环继续沿桌面从左画缘进入乙左手前方。';
 next.units[1].exitState='铜环停在乙左手内，甲的右手仍在桌面另一侧。';
 return next;
}

test('actual finish prompt resolves every pair and original segment headers without duplicating prose in the index',()=>{
 const f=fixture();f.draft=normalizeDraft(f.draft,f.source,{plan:f.plan,settings,unitPackingPolicy:'event-first-v1'}).draft;
 const req=request(f),sent=JSON.parse(req.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以各工作包')[0]);
 assert.deepEqual(sent.editingHandoffs,req.editingHandoffs);
 const pairs=resolveShotHandoffs(sent.previousDraft,sent.editingHandoffs),pair=pairs.find(p=>p.outgoing.shotId==='p1-s2');
 assert.equal(pair.boundary,'segment');assert.equal(pair.outgoing.shot.picture,f.draft.units[0].shots[1].picture);
 assert.equal(pair.incoming.shot.picture,f.draft.units[0].shots[2].picture);
 assert.deepEqual(pair.outgoing.segmentHeaders,[f.draft.units[0].segments[0]].map(({shotIds,id,eventId,intent,...h})=>h));
 assert.equal(pair.incoming.segmentHeaders[0].initialState,f.draft.units[0].segments[1].initialState);
 assert.equal(JSON.stringify(sent.editingHandoffs).includes('甲推出铜环'),false,'index must refer to the complete existing work instead of copying its prose');
 const changed=structuredClone(sent.previousDraft);changed.units[0].shots[1].picture+='新动作';
 assert.throws(()=>resolveShotHandoffs(changed,sent.editingHandoffs),e=>e.code==='SHOT_HANDOFF_STALE');
 const headerChanged=structuredClone(sent.previousDraft);headerChanged.units[0].segments[1].initialState+='不同位置';
 assert.throws(()=>resolveShotHandoffs(headerChanged,sent.editingHandoffs),e=>e.code==='SHOT_HANDOFF_STALE');
 const tampered=structuredClone(sent.editingHandoffs);tampered.cutPairs[1].incoming.shotIndex=0;
 assert.throws(()=>resolveShotHandoffs(sent.previousDraft,tampered),e=>e.code==='SHOT_HANDOFF_STALE');
});

test('short coordinate transport keeps the numeric endpoint and segment locations resolvable to the same execution text',()=>{
 const f=fixture(),req=request(f),schema={type:'object',properties:{},required:[],additionalProperties:false};
 const projected=projectModelCoordinates({previousDraft:req.previousDraft,editingHandoffs:req.editingHandoffs},schema,{coordinateVersion:'model-coordinates-v4'}).input;
 for(const [i,pair] of projected.editingHandoffs.cutPairs.entries())for(const side of ['outgoing','incoming']){
  const endpoint=pair[side],unit=projected.previousDraft.units[endpoint.unitIndex],shot=unit.shots[endpoint.shotIndex];
  assert.equal(endpoint.shotId,shot.id);assert.equal(endpoint.unitId,unit.id);
  const old=req.editingHandoffs.cutPairs[i][side];assert.equal(shot.picture,f.draft.units[old.unitIndex].shots[old.shotIndex].picture);
 }
 assert.equal(projected.editingHandoffs.inputSha256,req.editingHandoffs.inputSha256,'hash identifies canonical saved draft, not its request-local short spelling');
});

test('existing content review locates an offscreen gap; real delta finish packs it and exports both repaired endpoints',async t=>{
 const f=fixture(),requests=[];
 // This is a source-grounded review observation, deliberately not an automatic semantic regex verdict.
 assert.deepEqual(validateDraft({draft:f.draft,source:f.source,settings,plan:f.plan,unitDirectionVersion:captureRules().unitDirectionVersion}).errors,[]);
 const issue={code:'CONTENT_CONTINUITY',coordinate:'p1-s2 → p1-s3',sourceRefs:['r1','r2'],detail:'铜环离画的画框边与向窗边的去向未交代；下镜已握住，源要求的左手接触被跳过。联修两端picture/transition与入镜camera。'};
 const directory=await mkdtemp(path.join(tmpdir(),'shot-handoff-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const engine=createEngine({directory,modelRunner:async req=>{
  requests.push(req);let output;
  if(req.stage==='plan')output=f.plan;
  else if(req.stage==='author')output={schemaVersion:VERSION,units:f.draft.units.filter(u=>req.packageIds.includes(u.id.startsWith('p1')?'p1':'p2')),fantasyRealization:[]};
  else {
   const pairs=resolveShotHandoffs(req.previousDraft,req.editingHandoffs),pair=pairs.find(p=>p.outgoing.shotId==='p1-s2');
   assert.equal(pair.incoming.shot.picture,'乙已经拿着铜环。');assert.deepEqual(req.previousDraft.units.map(u=>u.id),['p1-u1','p1-u2','p2-u1']);
   const sent=JSON.parse(req.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以各工作包')[0]);assert.deepEqual(sent.issues,[issue]);
   const fixed=repair(req.previousDraft);
   output={schemaVersion:DELTA_VERSION,baseDraftHash:req.baseDraftHash,retainedUnitIds:['p2-u1'],replacements:[{replaces:['p1-u1','p1-u2'],units:fixed.units.slice(0,2),fantasyRealization:[]}],revisionNotes:[{coordinate:issue.coordinate,sourceRefs:issue.sourceRefs,change:'铜环右画缘切出，左画缘接入同次滑行并拍到乙左手接触。',preservedFunction:'源要求的交接先后及左手接住；次日院内边界沿用'}],unresolved:[]};
  }
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};
 }});
 await engine.create({id:'sample',source:f.source,settings});
 await engine.execute('sample',{stage:'plan',attemptId:'plan'});
 for(const id of ['p1','p2'])await engine.execute('sample',{stage:'author',packageId:id,attemptId:'author-'+id});
 const finished=await engine.execute('sample',{stage:'finish',packageIds:['p1','p2'],finishMode:'delta',issues:[issue],attemptId:'finish'});
 assert.equal(finished.candidates.at(-1).status,'adopted');
 const assembled=await engine.assemble('sample');assert.equal(assembled.status,'text_ready_for_review');
 assert.equal(assembled.assembly.draft.units.length,2,'20s full exchange fits 30s; next-day boundary remains separate');
 const current=assembled.assembly.draft,pairs=resolveShotHandoffs(current,buildShotHandoffs(current)),handoff=pairs.find(p=>p.outgoing.shotId==='p1-s2');
 assert.equal(handoff.boundary,'segment');assert.equal(handoff.incoming.segmentHeaders[0].initialState,repair(f.draft).units[1].initialState);
 assert.deepEqual(current.units[1],f.draft.units[2],'unmodified next-day unit remains byte-identical');
 for(const value of [handoff.outgoing.shot.picture,handoff.outgoing.shot.transition,handoff.incoming.shot.picture,handoff.incoming.shot.camera])assert.ok(assembled.assembly.text.includes(value));
 assert.doesNotMatch(assembled.assembly.text,/动作顺接|CONTENT_CONTINUITY|editingHandoffs|revisionNotes/);
 const review=buildReviewPacket(assembled).text;assert.ok(review.includes('p1-s2 → p1-s3'));assert.ok(review.includes(handoff.incoming.shot.picture));assert.ok(review.includes('time_space_jump'));
 assert.equal(requests.filter(r=>r.stage==='finish').length,1,'no new review role or paid repair loop');
 const frozen=structuredClone(assembled);delete frozen.rulesSnapshot.editingHandoffVersion;assert.equal(buildReviewPacket(frozen).text.includes('切点取证'),false);
});

test('15-second capacity, natural short tail, dialogue sound handoff and subjective scene exception survive read-only evidence',()=>{
 const f=fixture(),fixed=repair(f.draft),before=structuredClone(fixed),packed=normalizeDraft(fixed,f.source,{plan:f.plan,settings:{...settings,maxUnitSeconds:15},unitPackingPolicy:'event-first-v1'}).draft;
 assert.equal(packed.units.length,3);assert.equal(packed.units[2].shots[0].duration,3);assert.deepEqual(fixed,before);
 const report=resolveShotHandoffs(packed,buildShotHandoffs(packed));assert.equal(report[1].boundary,'unit');assert.equal(report[2].boundaryBefore.kind,'time_space_jump');
 const q=structuredClone(packed);q.units[0].shots[1].sound='乙画外先说，铜环仍在滑动。';q.units[0].shots[1].dialogueParts=[{lineId:'q',text:'先把',presentation:'画外',delivery:'自然',voiceStart:6,voiceEnd:7}];q.units[1].shots[0].dialogueParts=[{lineId:'q',text:'它给我。',presentation:'画内',delivery:'连读',voiceStart:0,voiceEnd:1}];
 const audible=resolveShotHandoffs(q,buildShotHandoffs(q))[1];assert.equal(audible.outgoing.shot.sound,q.units[0].shots[1].sound);assert.deepEqual(audible.incoming.shot.dialogueParts,q.units[1].shots[0].dialogueParts);
 q.units[1].visualSubjects=[{name:'乙主观化身',domain:'subjective'}];const domain=resolveShotHandoffs(q,buildShotHandoffs(q))[1];assert.deepEqual(domain.incoming.segmentHeaders[0].visualSubjects,q.units[1].visualSubjects);
});

test('unmarked frozen snapshots omit the new input and schema fields; raw-only format repair remains available',()=>{
 const f=fixture(),old=captureRules();delete old.editingHandoffVersion;
 const frozen=request(f,old),current=request(f);assert.equal(frozen.editingHandoffs,undefined);assert.equal(frozen.prompt.includes('"editingHandoffs"'),false);
 assert.deepEqual(current.schema,frozen.schema,'no new output fields or semantic self-certification');
 const raw=buildRequest({stage:'finish',source:f.source,settings,plan:f.plan,packageIds:['p1','p2'],previousDraft:{rawText:'{paid malformed response'},finishMode:'delta',rulesSnapshot:captureRules()});
 assert.equal(raw.finishMode,'full');assert.equal(raw.editingHandoffs,undefined);
 assert.equal(digest(frozen.schema),digest(current.schema));
});

test('malformed paid drafts keep the existing format-repair route without fabricating adjacency or throwing a TypeError',()=>{
 const f=fixture();
 for(const units of [[null],[{id:'p1-u1',shots:'paid malformed shots'}],[{id:'p1-u1',shots:[null]}],[f.draft.units[0],{id:'empty',shots:[]},f.draft.units[2]],[{...f.draft.units[0],segments:[null]}]]){
  const malformed={schemaVersion:VERSION,units,fantasyRealization:[]};
  const req=buildRequest({stage:'finish',source:f.source,settings,plan:f.plan,packageIds:['p1','p2'],previousDraft:malformed,rulesSnapshot:captureRules()});
  assert.equal(req.editingHandoffs,undefined);assert.ok(req.prompt.includes(JSON.stringify(units)));
 }
});


test('actual production-shared-v5 finish transport resolves long-ID cut pairs after lossless alias restoration',()=>{
 const f=fixture();
 for(const u of f.draft.units){u.id='long-unit-coordinate-'.repeat(4)+u.id;for(const shot of u.shots)shot.id='long-shot-coordinate-'.repeat(4)+shot.id;}
 const req=buildRequest({stage:'finish',source:f.source,settings,plan:f.plan,packageIds:['p1','p2'],previousDraft:f.draft,finishMode:'delta',rulesSnapshot:{...captureRules(),productionFeedbackResultVersion:'production-feedback-result-v1'},productionSnapshot:{version:'production-feedback-v1',feedbackResultVersion:'production-feedback-result-v1',transportVersion:'production-shared-v5',touchesOpening:false,touchesEnding:false,materials:[],episodeBoundary:null}});
 assert.ok(Object.keys(req.modelCoordinates?.aliases||{}).length>0,'fixture must exercise real ID aliases, not short-ID no-op transport');
 const sent=JSON.parse(req.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以各工作包')[0]);
 for(const pair of sent.editingHandoffs.cutPairs)for(const side of ['outgoing','incoming']){
  const endpoint=pair[side],unit=sent.previousDraft.units[endpoint.unitIndex],shot=unit.shots[endpoint.shotIndex];
  assert.equal(endpoint.unitId,unit.id);assert.equal(endpoint.shotId,shot.id);assert.equal(shot.picture,f.draft.units[endpoint.unitIndex].shots[endpoint.shotIndex].picture);
 }
 const restored=restoreModelCoordinates({previousDraft:sent.previousDraft,editingHandoffs:sent.editingHandoffs},req.modelCoordinates);
 assert.deepEqual(restored.previousDraft,req.previousDraft);
 const pairs=resolveShotHandoffs(restored.previousDraft,restored.editingHandoffs);assert.equal(pairs[1].incoming.shot.picture,'乙已经拿着铜环。');
});
