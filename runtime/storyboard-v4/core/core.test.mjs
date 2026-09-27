import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest as buildEventRequest,normalizeSettings,normalizePlan,sliceSource,defaultChoice,captureRules as captureEventRules} from './core.mjs';
import {confirmSelection,resolveSelection} from './selection.mjs';
import {normalizeSource} from './source.mjs';
import {PLAN_VERSION,digest} from './shared.mjs';

// These pre-event fixtures exercise the frozen v1 contract; event-v2 behavior has its own suite.
function captureRules(){const rules=captureEventRules();rules.outputSchemaVersion='structured-v1';delete rules.unitPackingPolicy;delete rules.creativeRevision;for(const key of ['planHint','draftHint','deltaHint'])rules[key]=rules[key].split('\n')[0];return rules;}
const buildRequest=payload=>buildEventRequest({rulesSnapshot:captureRules(),...payload});

const source=()=>normalizeSource({key:'t',title:'不甘',context:'只做本段',contextRows:[{id:'prior',line:1,text:'△甲收起护罩。'}],sourceRows:[{id:'s1',line:2,text:'甲：（怒视）我还没输！'}],dialogue:[{id:'d1',line:2,speaker:'甲',cue:'怒视',channel:'现场对白',quote:'我还没输！'}],entryFacts:[{id:'f-state',subject:'甲',statement:'护罩已收起',sourceRefs:['prior'],evidence:'甲收起护罩'}]});
const plan=()=>({schemaVersion:PLAN_VERSION,emotionArc:'承压仍不服',entryFacts:[],workPackages:[{id:'p1',sourceRefs:['s1'],emotionContract:{subject:'甲',contextTone:'严肃不甘',audienceEffect:'感到他仍抵抗',change:'痛苦但不服',landing:'他本人仍站着',retain:['不改成搞笑']},entryFactIds:['f-state'],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs:['s1'],secondsRange:[2,6]}],fantasyCandidates:[{id:'f1',anchorRefs:['s1'],subject:'甲',emotionPurpose:'不甘与抵抗',recommended:false,proposal:'背后的影子被压弯又绷住',screenSecondsRange:[1,2],extraSecondsRange:[0,1]}]});

test('effective settings preserve Sol medium, explicit scope and no silent unknown fields',()=>{
 const s=normalizeSettings({maxUnits:null,fantasyMode:'off'});
 assert.equal(s.model,'gpt-6-sol');assert.equal(s.reasoning,'medium');assert.equal(s.maxUnitSeconds,30);
 assert.throws(()=>normalizeSettings({fantasyMode:'off'}),e=>e.code==='SETTINGS_SCOPE');
 assert.throws(()=>normalizeSettings({maxUnits:null,mystery:true}),e=>e.code==='SETTINGS_FIELD');
 assert.throws(()=>normalizeSettings({maxUnits:1,maxUnitSeconds:100}),e=>e.code==='SETTINGS_CAP');
});

test('author receives source state and emotion, not an unlocked early fantasy recipe',()=>{
 const s=source(),p=normalizePlan(plan(),s);
 const r=buildRequest({stage:'author',source:s,plan:p,packageId:'p1',choice:defaultChoice('all'),settings:{maxUnits:1,fantasyMode:'all'}});
 assert.match(r.prompt,/护罩已收起/);assert.match(r.prompt,/甲收起护罩/);assert.match(r.prompt,/严肃不甘/);assert.match(r.prompt,/他本人仍站着/);
 assert.ok(!r.prompt.includes('背后的影子被压弯又绷住'));
 assert.equal(r.settings.fantasyEnabled,true);assert.equal(r.promptHash,digest(r.prompt));
 assert.ok(r.loadedFiles.some(f=>f.path.includes('fantasy-expression-methods')));
});

test('review choice cannot run author until current plan is confirmed',()=>{
 const s=source(),p=normalizePlan(plan(),s),choice=defaultChoice('review');
 const payload={stage:'author',source:s,plan:p,packageId:'p1',choice,settings:{maxUnits:1,fantasyMode:'review'}};
 assert.throws(()=>buildRequest(payload),e=>e.code==='FANTASY_CONFIRMATION_REQUIRED');
 const selected=resolveSelection(p,choice);
 const confirmed=confirmSelection(p,choice,[],selected.fingerprint);
 assert.equal(buildRequest({...payload,choice:confirmed}).settings.fantasyEnabled,false);
});

test('off excludes optional method, preserves source-required event and rendering settings',()=>{
 const s=source(),p=normalizePlan(plan(),s);
 const r=buildRequest({stage:'author',source:s,plan:p,packageId:'p1',settings:{maxUnits:1,fantasyMode:'off'}});
 assert.equal(r.settings.fantasyEnabled,false);
 assert.ok(!r.loadedFiles.some(f=>f.path.includes('fantasy-expression-methods')));
 assert.match(r.prompt,/护罩/);
});

test('plan cannot omit action ownership, manufacture sources or cyclic dependencies',()=>{
 const s=source(),p=plan();p.workPackages[0].sourceRefs=['missing'];
 assert.throws(()=>normalizePlan(p,s));
 const cycle=plan();cycle.workPackages[0].dependsOn=['p1'];assert.throws(()=>normalizePlan(cycle,s),e=>e.code==='PLAN_DEPENDENCY');
 const missing=plan();missing.workPackages[0].sourceRefs=[];assert.throws(()=>normalizePlan(missing,s));
});

test('scoped source retains only required rows, whole quotes and cited entry facts',()=>{
 const s=source();
 s.sourceRows.push({id:'other',line:3,text:'乙：别过来。',kind:'dialogue'});s.dialogue.push({id:'d2',rowId:'other',sourceIds:['other'],speaker:'乙',quote:'别过来。',channel:'现场对白',kind:'speech'});
 const scope=sliceSource(s,['s1'],['f-state']);
 assert.deepEqual(scope.sourceRows.map(r=>r.id),['s1']);assert.deepEqual(scope.dialogue.map(q=>q.id),['d1']);
 assert.equal(scope.contextRows[0].id,'prior');assert.equal(scope.entryFacts[0].statement,'护罩已收起');
});

test('emotion or related source changes alter the actual request fingerprint',()=>{
 const s=source(),p=normalizePlan(plan(),s),settings={maxUnits:1,fantasyMode:'off'};
 const a=buildRequest({stage:'author',source:s,plan:p,packageId:'p1',settings});
 const revised=structuredClone(p);revised.workPackages[0].emotionContract.landing='咬牙抬头不服';
 const b=buildRequest({stage:'author',source:s,plan:revised,packageId:'p1',settings});assert.notEqual(a.inputHash,b.inputHash);
});

test('AI plan cannot promote its own recipe into a user lock',()=>{
 const s=source(),p=plan();p.fantasyCandidates[0].userLockedProposal='必须复制我这张图';
 const settings={maxUnits:1,fantasyMode:'all'};
 const a=buildRequest({stage:'author',source:s,plan:p,packageId:'p1',settings});
 assert.ok(!a.prompt.includes('必须复制我这张图'));
 const b=buildRequest({stage:'author',source:s,plan:p,packageId:'p1',settings,lockedFantasyDirections:{f1:'用户明确锁定：保留折影'}});
 assert.match(b.prompt,/用户明确锁定：保留折影/);assert.notEqual(a.inputHash,b.inputHash);
});

test('frozen rule snapshots are used verbatim and include model instructions in identity',()=>{
 const s=source(),p=normalizePlan(plan(),s),rules=captureRules(),settings={maxUnits:1,fantasyMode:'off'};
 const a=buildRequest({stage:'author',source:s,plan:p,packageId:'p1',settings,rulesSnapshot:rules});
 const changed=structuredClone(rules);changed.instructions+=' 测试用域指令变更';
 const b=buildRequest({stage:'author',source:s,plan:p,packageId:'p1',settings,rulesSnapshot:changed});
 assert.notEqual(a.inputHash,b.inputHash);assert.notEqual(a.instructionHash,b.instructionHash);
 assert.equal(a.snapshot[0].body,rules.files['references/common-contract.md']);
});

test('model input projects stable IDs and text, not redundant trace paths or unrelated speech references',()=>{
 const s=source();s.originalDocx='/private/not-needed.docx';s.sourceRows[0].sourceFileLine=200;
 const p=normalizePlan(plan(),s),settings={maxUnits:1,fantasyMode:'off'};
 const r=buildRequest({stage:'author',source:s,plan:p,packageId:'p1',settings,voiceReference:{scope:'平读非实配',rows:[{id:'d1',seconds:2,path:'/tmp/audio.aiff'},{id:'unrelated',seconds:30}]}});
 assert.ok(!r.prompt.includes('/private/not-needed.docx'));assert.ok(!r.prompt.includes('sourceFileLine'));
 assert.ok(!r.prompt.includes('/tmp/audio.aiff'));assert.ok(!r.prompt.includes('unrelated'));
 assert.ok(r.prompt.includes('我还没输！'));assert.equal(r.source.sourceRows[0].sourceFileLine,200);
});

test('joint finishing carries separate emotion contracts and complete source for both owners',()=>{
 const s=source();s.sourceRows.push({id:'s2',text:'△乙放下筷子，神情凝重。',kind:'action'});
 const p=plan();p.workPackages.push({id:'p2',sourceRefs:['s2'],emotionContract:{subject:'乙',contextTone:'严肃警觉',audienceEffect:'担心危险',change:'松弛转警觉',landing:'停止进食看向门口',retain:['不能用笑脸']},entryFactIds:[],dependsOn:['p1'],scenarioKeys:[]});p.provisionalUnits.push({id:'u2',packageId:'p2',sourceRefs:['s2'],secondsRange:[2,5]});
 const r=buildRequest({stage:'finish',source:s,plan:p,packageIds:['p1','p2'],settings:{maxUnits:null,fantasyMode:'off'},previousDraft:{units:[{id:'p1-u1'}]}});
 assert.deepEqual(r.packageIds,['p1','p2']);assert.equal(r.source.sourceRows.length,2);
 assert.deepEqual(r.plan.workPackages.map(w=>w.emotionContract.subject),['甲','乙']);
 assert.match(r.prompt,/严肃不甘/);assert.match(r.prompt,/严肃警觉/);assert.match(r.prompt,/保留现有/);
});

test('finisher can repair preserved paid raw response without pretending it was a valid draft',()=>{
 const r=buildRequest({stage:'finish',source:source(),plan:plan(),packageIds:['p1'],settings:{maxUnits:1,fantasyMode:'off'},previousDraft:{rawText:'{"units":[付费原始响应未闭合'}});
 assert.match(r.prompt,/付费原始响应未闭合/);assert.match(r.prompt,/格式/);
 assert.throws(()=>buildRequest({stage:'finish',source:source(),plan:plan(),packageIds:['p1'],settings:{maxUnits:1,fantasyMode:'off'},previousDraft:{rawText:' '}}),e=>e.code==='FINISH_INPUT');
});

test('delta finish exposes full source and draft but requests complete replacement groups',()=>{
 const old={schemaVersion:'performance-core-v4',units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]};
 const r=buildRequest({stage:'finish',finishMode:'delta',source:source(),plan:plan(),packageIds:['p1'],settings:{maxUnits:1,fantasyMode:'off'},previousDraft:old});
 assert.equal(r.finishMode,'delta');assert.ok(r.baseDraftHash);assert.match(r.prompt,/retainedUnitIds/);assert.match(r.prompt,/replacements/);assert.match(r.prompt,/p1-u1/);
 const fallback=buildRequest({stage:'finish',finishMode:'delta',source:source(),plan:plan(),packageIds:['p1'],settings:{maxUnits:1,fantasyMode:'off'},previousDraft:{...old,supplementalCandidates:[{rawText:'bad'}]}});
 assert.equal(fallback.finishMode,'full');assert.ok(!fallback.baseDraftHash);
});

test('delta output contract is frozen in rule snapshot and included in request identity',()=>{
 const old={schemaVersion:'performance-core-v4',units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]};
 const payload={stage:'finish',finishMode:'delta',source:source(),plan:plan(),packageIds:['p1'],settings:{maxUnits:1,fantasyMode:'off'},previousDraft:old};
 const rules=captureRules();assert.match(rules.deltaHint,/retainedUnitIds/);
 const frozen={...rules,deltaHint:'冻结版差量契约 retainedUnitIds replacements'};
 const request=buildRequest({...payload,rulesSnapshot:frozen});
 assert.match(request.prompt,/冻结版差量契约/);assert.ok(!request.prompt.includes('只压缩传输中的未改稿重复内容'));
 const current=buildRequest({...payload,rulesSnapshot:rules});
 assert.notEqual(request.promptHash,current.promptHash);assert.notEqual(request.inputHash,current.inputHash);
});
