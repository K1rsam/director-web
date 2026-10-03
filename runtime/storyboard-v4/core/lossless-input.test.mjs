import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules,normalizePlan,normalizeSettings} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {buildExecutionBatches} from './execution-batches.mjs';
import {PLAN_VERSION} from './shared.mjs';
import {projectModelInput} from './lossless-input.mjs';

const inputOf=request=>JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以')[0]);
const frozenRules=()=>{const rules=captureRules();delete rules.inputProjectionVersion;return rules;};
function fixture(){
 const quote='“别急着替我宣布结局。'+('那扇门没有关，我说过的话也没有收回。'.repeat(6))+'”';
 const source=normalizeSource({key:'lossless-test',context:{directorNotes:'只保留这一条独有的导演要求：目光先落向门边，再回到对手脸上。'},sourceRows:Array.from({length:12},(_,i)=>({id:`stable-source-catalog-20260930-L${String(i+1).padStart(4,'0')}`,text:i%3===2?`△甲第${i+1}次按住门沿，乙始终停在窗边。`:`${i%3?'乙OS':'甲VO'}：（压住呼吸）第${i+1}句${quote}`})),contextRows:[{id:'prior-state-20260930',text:'△门已经打开，窗仍关着。',kind:'context'}]});
 const ids=source.sourceRows.map(r=>r.id),emotionContract={subject:'甲与乙',contextTone:'严肃不甘而非滑稽。'.repeat(9),audienceEffect:'观众期待的是对视时关系变化，不是提前获胜。'.repeat(7),change:'从试图离开到停住，对手仍未让步。'.repeat(7),landing:'手掌留在门沿，视线回到对手。'.repeat(7),retain:['原话、声道及说者完整保留','不能让OS被其他人物听见','主观幻想不等于现实新增能力']};
 const plan=normalizePlan({schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'离开前仍不肯认输',entryFacts:[],events:[{id:'e1',sourceRefs:ids,sceneKey:'房间',boundaryBefore:{kind:'episode_start',reason:'同场未中断的完整情绪事件'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:ids,emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:Array.from({length:6},(_,i)=>({id:`pu${i+1}`,packageId:'p1',sourceRefs:ids.slice(i*2,i*2+2),secondsRange:[26,30]})),fantasyCandidates:[]},source);
 const settings=normalizeSettings({maxUnits:null,maxUnitSeconds:30,fantasyMode:'off'}),choice={mode:'off',overrides:{},unitOverrides:{},confirmedFingerprint:null};
 return {stage:'author',source,plan,settings,choice,packageIds:['p1'],voiceReference:{scope:'平读参照，非演员实配',rows:source.dialogue.map(q=>({id:q.id,quote:q.quote,seconds:12}))}};
}

// Independent decoder for the documented, one-hop on-page reference notation.
function expand(input){
 const get=pointer=>pointer.slice(2).split('/').reduce((value,key)=>value[key.replaceAll('~1','/').replaceAll('~0','~')],input);
 const markers=value=>value&&typeof value==='object'&&(Object.hasOwn(value,'$same')||Object.hasOwn(value,'$rowIds'));
 const noReferences=value=>{if(markers(value))return false;return !value||typeof value!=='object'||Object.values(value).every(noReferences);};
 const visit=value=>{
  if(!value||typeof value!=='object')return value;
  if(Object.hasOwn(value,'$same')){assert.deepEqual(Object.keys(value),['$same']);const target=get(value.$same);assert.notEqual(target,undefined,'references resolve inside this input');assert.ok(noReferences(target),'references must not chain');return structuredClone(target);}
  if(Object.hasOwn(value,'$rowIds')){assert.deepEqual(Object.keys(value),['$rowIds']);return value.$rowIds.flatMap(([catalog,start,end])=>{assert.ok(['sourceRows','contextRows'].includes(catalog));return input.source[catalog].slice(start,end+1).map(row=>row.id);});}
  return Array.isArray(value)?value.map(visit):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
 };
 return visit(input);
}

test('new requests compact only reversible model data while preserving source and all professional rules',()=>{
 const payload=fixture(),before=structuredClone(payload),rules=captureRules();
 assert.equal(rules.inputProjectionVersion,'lossless-input-v1');
 const old=buildRequest({...payload,rulesSnapshot:frozenRules()}),current=buildRequest({...payload,rulesSnapshot:rules});
 const input=inputOf(current);
 assert.match(current.prompt,/单跳等值引用/);
 assert.ok(JSON.stringify(input).includes('$rowIds'));
 assert.ok(JSON.stringify(input).includes('$same'));
 assert.deepEqual(expand(input),inputOf(old));
 assert.deepEqual(input.source.sourceRows,inputOf(old).source.sourceRows,'raw source remains directly readable');
 assert.deepEqual(input.source.dialogue,inputOf(old).source.dialogue,'quote, speaker, cue and channel stay explicit');
 assert.deepEqual(current.source,old.source);assert.deepEqual(current.plan,old.plan);
 assert.deepEqual(current.loadedFiles,old.loadedFiles);assert.deepEqual(current.snapshot,old.snapshot);
 assert.equal(current.schemaHash,old.schemaHash);assert.notEqual(current.inputHash,old.inputHash);
 assert.ok(current.prompt.length<old.prompt.length);
 assert.deepEqual(payload,before);
});

test('execution batches retain the full parent overview and predecessor while removing exact local-plan copies',()=>{
 const payload=fixture(),rules=captureRules();
 assert.equal(rules.inputProjectionVersion,'lossless-input-v1');
 const projection=snapshot=>{
  const manifest=buildExecutionBatches({...payload,packageId:'p1',rulesSnapshot:snapshot,generation:'test-only-generation'}),batch=manifest.batches[1];
  return {version:manifest.version,generation:manifest.generation,manifestHash:manifest.hash,id:batch.id,packageId:'p1',index:batch.index,total:manifest.batches.length,batch,predecessor:{batchId:manifest.batches[0].id,candidateId:'existing-paid-candidate',draftHash:'existing-draft-hash',unit:{id:'prior-u1',scene:'房间',lighting:'窗边冷光',unitDirection:'本段独有的停顿与回望',shots:[{picture:'拇指停在木纹裂口，视线随后抬起。',dialogueParts:[]}]}}};
 };
 const old=buildRequest({...payload,rulesSnapshot:frozenRules(),executionBatch:projection(frozenRules())});
 const current=buildRequest({...payload,rulesSnapshot:rules,executionBatch:projection(rules)}),input=inputOf(current),expected=inputOf(old);
 // Snapshot hashes deliberately differ, but all creative and continuity data must be identical.
 expected.executionBatch.manifestHash=input.executionBatch.manifestHash;
 assert.deepEqual(expand(input),expected);
 assert.deepEqual(input.plan.packageOverview,expected.plan.packageOverview);
 assert.deepEqual(input.executionBatch.predecessor,expected.executionBatch.predecessor);
 assert.ok(input.plan.provisionalUnits.every(unit=>unit.$same));
 assert.ok(current.prompt.length<old.prompt.length);
});

test('full and delta finishing keep every draft word and the global review requirement',()=>{
 const payload=fixture(),previousDraft={schemaVersion:'performance-core-v4',units:[{id:'p1-u1',unitDirection:'光先落眼底，最后才抬头。',shots:[{id:'p1-s1',picture:'眉峰收紧，手指沿门沿滑落半寸。',dialogueParts:[{lineId:payload.source.dialogue[0].id,text:payload.source.dialogue[0].quote}]}]}],fantasyRealization:[]};
 assert.equal(captureRules().inputProjectionVersion,'lossless-input-v1');
 for(const finishMode of ['full','delta']){
  const scoped={...payload,stage:'finish',finishMode,previousDraft},old=buildRequest({...scoped,rulesSnapshot:frozenRules()}),current=buildRequest(scoped),input=inputOf(current);
  assert.deepEqual(input.previousDraft,previousDraft);assert.deepEqual(expand(input),inputOf(old));
  assert.match(current.prompt,/检查镜头正文与源状态\/情绪契约/);
  assert.deepEqual(current.loadedFiles,old.loadedFiles);assert.equal(current.schemaHash,old.schemaHash);
 }
});

test('missing projection version preserves frozen request bytes, and unknown versions are rejected',()=>{
 const payload=fixture(),rules=frozenRules(),before=structuredClone(rules);
 const first=buildRequest({...payload,rulesSnapshot:rules}),second=buildRequest({...payload,rulesSnapshot:structuredClone(rules)});
 assert.ok(!first.prompt.includes('单跳等值引用'));
 assert.equal(first.prompt,second.prompt);assert.equal(first.inputHash,second.inputHash);
 assert.equal(first.promptHash,second.promptHash);assert.deepEqual(rules,before);
 assert.throws(()=>buildRequest({...payload,rulesSnapshot:{...rules,inputProjectionVersion:'future-unknown'}}),error=>error.code==='RULE_SNAPSHOT');
});

test('reserved notation in source data falls back without reinterpreting or dropping anything',()=>{
 const payload=fixture();payload.source.context={literal:{$same:'#/not-a-reference',extra:'真实源数据，禁止解释成投影标记'}};
 assert.equal(captureRules().inputProjectionVersion,'lossless-input-v1');
 const old=buildRequest({...payload,rulesSnapshot:frozenRules()}),current=buildRequest(payload);
 assert.deepEqual(inputOf(current),inputOf(old));assert.equal(current.prompt,old.prompt);
});

test('malformed nominally known containers fall back to the full unmodified input',()=>{
 const original=inputOf(buildRequest({...fixture(),rulesSnapshot:frozenRules()}));
 const mutations=[
  input=>{input.source.sourceRows='not-an-array';},
  input=>{input.source.sourceRows[0].id={unrecognized:'coordinate'};},
  input=>{input.source.entryFacts={unexpected:'fact-catalog'};},
  input=>{input.plan.workPackages=[null];},
  input=>{input.plan.provisionalUnits=[null];},
  input=>{input.plan.events=[null];},
  input=>{input.plan.workPackages[0].beatContracts={unknown:'contract-shape'};},
  input=>{input.plan.packageOverview={provisionalUnits:'not-an-array'};},
  input=>{input.voiceReference.rows=[null];},
  input=>{input.source.context={unexpectedDate:new Date('2026-09-30T00:00:00Z')};},
 ];
 for(const mutate of mutations){const input=structuredClone(original);mutate(input);const before=structuredClone(input),result=projectModelInput(input);assert.equal(result.hint,'');assert.deepEqual(result,{input:before,hint:''});assert.deepEqual(input,before);}
});

test('ID ranges preserve order, repetitions and unavailable layout IDs without broadening scope',()=>{
 const input=inputOf(buildRequest({...fixture(),rulesSnapshot:frozenRules()})),ids=input.source.sourceRows.map(row=>row.id);
 input.plan.workPackages[0].sourceRefs=[...ids.slice(5),...ids.slice(0,3),...ids.slice(0,3),input.source.contextRows[0].id];
 input.plan.provisionalUnits[0].sourceRefs=[ids[0],'known-only-in-full-catalog-blank-id',ids[1]];
 const projected=projectModelInput(input);
 assert.ok(projected.hint);assert.deepEqual(expand(projected.input),input);
 assert.deepEqual(projected.input.plan.provisionalUnits[0].sourceRefs,input.plan.provisionalUnits[0].sourceRefs);
});

test('near-duplicate emotion contracts and unknown nested data are never summarized away',()=>{
 const input=inputOf(buildRequest({...fixture(),rulesSnapshot:frozenRules()}));
 const beat=input.plan.workPackages[0].beatContracts[0];
 beat.emotionContract.change+='独有变化：乙的右手收回衣袋，目光没有回避。';
 beat.unknownEvidence={version:{unrecognized:'v9'},meaning:'不可删的陌生证据',sourceRefs:input.source.sourceRows.map(row=>row.id),emotionContract:structuredClone(input.plan.workPackages[0].emotionContract)};
 input.source.context={unique:{evidence:'唯一的上下文不能被常见规则替代'},copiedQuote:input.source.dialogue[0].quote};
 const projected=projectModelInput(input);
 assert.ok(projected.hint);assert.deepEqual(expand(projected.input),input);
 assert.deepEqual(projected.input.plan.workPackages[0].beatContracts[0].emotionContract,beat.emotionContract);
 assert.deepEqual(projected.input.plan.workPackages[0].beatContracts[0].unknownEvidence,beat.unknownEvidence);
 assert.deepEqual(projected.input.source.context.unique,input.source.context.unique);
 assert.ok(projected.input.source.context.copiedQuote.$same);
});

test('projection never grows a short request with notation overhead',()=>{
 const input={stage:'plan',source:{key:'tiny',sourceRows:[{id:'s1',text:'甲：走。'}],contextRows:[],dialogue:[{id:'q1',rowId:'s1',speaker:'甲',quote:'走。',cue:'',kind:'speech',channel:'现场对白'}],entryFacts:[],context:'走。'},plan:null,voiceReference:{rows:[{id:'q1',quote:'走。',seconds:1}]},previousDraft:null};
 assert.deepEqual(projectModelInput(input),{input,hint:''});
});
