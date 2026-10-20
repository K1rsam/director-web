import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {PLAN_VERSION} from './shared.mjs';

function fixture(){
 const source=normalizeSource({key:'creative-brief',sourceRows:[{id:'s1',text:'甲：我还站着。'},{id:'s2',text:'△甲撑住栏杆，乙后退。'}]});
 const emotionContract={subject:'甲',contextTone:'严肃抗争',audienceEffect:'敬佩抵抗而非发笑',change:'受压仍顶住',landing:'本人站稳',retain:['严肃不甘','没有胜利或新能力']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'受压不倒',entryFacts:[],events:[{id:'e1',sourceRefs:['s1','s2'],sceneKey:'城墙-夜外',boundaryBefore:{kind:'episode_start',reason:'本段开始'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:['s1','s2'],emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'pu1',packageId:'p1',sourceRefs:['s1','s2'],secondsRange:[24,30]}],fantasyCandidates:[{id:'f1',anchorRefs:['s1'],subject:'甲',emotionPurpose:'压迫中的抵抗',recommended:true,proposal:'肩上巨型石盘倾斜，他仍用肩顶住。',screenSecondsRange:[3,4],extraSecondsRange:[0,1]},{id:'f2',anchorRefs:['s2'],subject:'乙',emotionPurpose:'误判后的后怕',recommended:false,proposal:'视野里的台阶变成纸片抽走。',screenSecondsRange:[2,3],extraSecondsRange:[1,2]}]};
 return {stage:'author',source,plan,packageId:'p1',settings:{maxUnits:null,maxUnitSeconds:30,fantasyMode:'recommended'}};
}
function modelInput(request){return JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以各工作包')[0]);}

test('selected fantasy suggestions reach the author as replaceable proposals, not locks',()=>{
 const payload=fixture(),r=buildRequest(payload),candidate=r.plan.fantasyCandidates[0];
 assert.equal(candidate.suggestedProposal,payload.plan.fantasyCandidates[0].proposal);
 assert.equal(candidate.userLockedProposal,undefined);
 assert.equal(r.plan.fantasyCandidates.length,1);
 assert.ok(!r.prompt.includes(payload.plan.fantasyCandidates[1].proposal));
 const changed=structuredClone(payload);changed.plan.fantasyCandidates[0].proposal='受压者胸前的铠甲主观变成迎风船帆。';
 assert.notEqual(buildRequest(changed).inputHash,r.inputHash);
 assert.notEqual(buildRequest(changed).promptHash,r.promptHash);
});

test('real user lock wins while an AI-supplied lock and disabled suggestions never leak',()=>{
 const payload=fixture();payload.plan.fantasyCandidates[0].userLockedProposal='AI冒充用户锁定';
 const r=buildRequest({...payload,lockedFantasyDirections:{f1:'保留用户指定的巨石意象'}});
 assert.equal(r.plan.fantasyCandidates[0].userLockedProposal,'保留用户指定的巨石意象');
 assert.equal(r.plan.fantasyCandidates[0].suggestedProposal,undefined);
 assert.ok(!r.prompt.includes('AI冒充用户锁定'));
 const off=buildRequest({...payload,settings:{...payload.settings,fantasyMode:'off'}});
 assert.deepEqual(off.plan.fantasyCandidates,[]);
 assert.ok(!off.prompt.includes(payload.plan.fantasyCandidates[0].proposal));
});

test('capacity briefing counts the union of speech windows and does not label remaining time idle',()=>{
 const payload=fixture(),quote=payload.source.dialogue[0].id;
 const previousDraft={units:[{id:'p1-u1',eventId:'e1',shots:[{id:'s1',duration:5,dialogueParts:[{voiceStart:0,voiceEnd:3},{voiceStart:2,voiceEnd:4}]},{id:'s2',duration:3,dialogueParts:[{voiceStart:1,voiceEnd:2}]}]}]};
 const r=buildRequest({...payload,stage:'finish',previousDraft,voiceReference:{scope:'平读，非演员实配',rows:[{id:quote,seconds:2.75},{id:'out-of-scope',seconds:80}]}});
 const b=modelInput(r).capacityBrief;
 assert.equal(b.maxUnitSeconds,30);assert.deepEqual(b.preferredRange,[26,30]);assert.equal(b.hardMinimum,false);
 assert.equal(b.currentDraft.unitCount,1);assert.equal(b.currentDraft.totalSeconds,8);
 assert.equal(b.currentDraft.units[0].speechWindowSeconds,5);assert.equal(b.currentDraft.units[0].withoutSpeechWindowSeconds,3);
 assert.match(b.timingCaveat,/不等于空等/);assert.match(b.timingCaveat,/不是.*实配/);
 assert.deepEqual(b.voiceReference,{coveredLines:1,totalLines:1,seconds:2.75,isPerformedMinimum:false});
 assert.equal(previousDraft.units[0].shots[0].duration,5);
});

test('15-second planning is advisory; missing timing stays unknown instead of invented zero',()=>{
 const payload=fixture(),plan=buildRequest({...payload,stage:'plan',settings:{...payload.settings,maxUnitSeconds:15}});
 const brief=modelInput(plan).capacityBrief;assert.deepEqual(brief.preferredRange,[13,15]);assert.equal(brief.hardMinimum,false);assert.equal(brief.currentDraft,null);
 const finish=buildRequest({...payload,stage:'finish',previousDraft:{units:[{id:'p1-u1'}]}});
 const current=modelInput(finish).capacityBrief.currentDraft;
 assert.equal(current.totalSeconds,null);assert.equal(current.units[0].speechWindowSeconds,null);
 assert.equal(current.units[0].withoutSpeechWindowSeconds,null);
});

test('new creative input is snapshot-versioned without changing the output schema',()=>{
 const payload=fixture(),current=captureRules(),frozen=structuredClone(current);delete frozen.creativeRevision;
 const a=buildRequest({...payload,rulesSnapshot:frozen}),b=buildRequest({...payload,rulesSnapshot:current});
 assert.equal(current.creativeRevision,'expressive-cadence-v4');
 assert.equal(modelInput(a).capacityBrief,undefined);assert.equal(a.plan.fantasyCandidates[0].suggestedProposal,undefined);
 assert.equal(a.schemaHash,b.schemaHash);assert.notEqual(a.inputHash,b.inputHash);
 const changed=structuredClone(payload);changed.plan.fantasyCandidates[0].proposal='新的未锁定建议';
 assert.equal(buildRequest({...changed,rulesSnapshot:frozen}).promptHash,a.promptHash);
 assert.equal(buildRequest({...changed,rulesSnapshot:frozen}).inputHash,a.inputHash);
 assert.throws(()=>buildRequest({...payload,rulesSnapshot:{...current,creativeRevision:'unknown-version'}}),e=>e.code==='RULE_SNAPSHOT');
});

test('frozen v3 rules and skill text remain stable beside new v4 defaults',()=>{
 const payload=fixture(),current=captureRules(),frozen=structuredClone(current);
 frozen.creativeRevision='expressive-cadence-v3';
 frozen.files['skills/unit-performance-director/SKILL.md']+='\n冻结旧任务的技能正文标记。';
 const saved=structuredClone(frozen),old=buildRequest({...payload,rulesSnapshot:frozen});
 const fresh=buildRequest({...payload,rulesSnapshot:current});
 assert.equal(modelInput(old).creativeRevision,'expressive-cadence-v3');
 assert.equal(modelInput(fresh).creativeRevision,'expressive-cadence-v4');
 assert.ok(old.prompt.includes('冻结旧任务的技能正文标记。'));
 assert.ok(!fresh.prompt.includes('冻结旧任务的技能正文标记。'));
 assert.equal(buildRequest({...payload,rulesSnapshot:frozen}).promptHash,old.promptHash);
 assert.equal(buildRequest({...payload,rulesSnapshot:frozen}).inputHash,old.inputHash);
 assert.notEqual(fresh.inputHash,old.inputHash);
 assert.deepEqual(frozen,saved);
});

test('partial repair drafts cannot be blocked by advisory capacity statistics',()=>{
 const payload=fixture();
 for(const units of [[null],[{id:'p1-u1',shots:[null]}],[{id:'p1-u1',shots:[{duration:4,dialogueParts:[null]}]}]]){
  const r=buildRequest({...payload,stage:'finish',previousDraft:{units}});
  const b=modelInput(r).capacityBrief.currentDraft;
  assert.equal(b.unitCount,1);assert.equal(b.units[0].speechWindowSeconds,null);
  assert.equal(b.units[0].withoutSpeechWindowSeconds,null);
 }
});
