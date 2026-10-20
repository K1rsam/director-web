import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewPacket} from './review-packet.mjs';
import {refinementAssemblyHash} from './core/director-refinement.mjs';
const fixture=()=>{
 const d={id:'review-case',status:'text_ready_for_review',settings:{fantasyMode:'recommended',maxUnitSeconds:30,visualStyle:'3D国漫'},source:{sourceRows:[{id:'s1',text:'甲：（迟疑）我……愿意。'}],context:{directorNotes:'保留迟疑，不统一提速。',seriesDirection:{brief:'反差逆袭，保留亲情'}}},
  assembly:{text:'基稿完整正文',draft:{units:[{id:'u1'}]},validation:{errors:[]}},adopted:[{candidateId:'base'}],operations:[],candidates:[],web:{sourceStale:false}};
 const h=refinementAssemblyHash(d);d.operations.push({attemptId:'attempt',purpose:'director_refinement',refinement:{baseAssemblyHash:h,eventIds:['e1'],skill:{body:'SECRET_SKILL'}}});
 d.candidates.push({id:'candidate',attemptId:'attempt',purpose:'director_refinement',status:'refinement_ready',previewText:'候选完整正文',validation:{errors:[]},refinement:{baseAssemblyHash:h,eventIds:['e1']},raw:'SECRET_RAW'});
 return d;
};
test('review material has source, unchanged constraints, two unlabeled full drafts and blank evidence-based rubric without private internals',()=>{
 const d=fixture(),packet=buildReviewPacket(d,{candidateId:'candidate'});
 assert.match(packet.text,/我……愿意/);assert.match(packet.text,/基稿完整正文/);assert.match(packet.text,/候选完整正文/);assert.match(packet.text,/保留迟疑/);assert.match(packet.text,/反差逆袭/);
 assert.match(packet.text,/稿件 A/);assert.match(packet.text,/稿件 B/);assert.match(packet.text,/未生成视频/);assert.match(packet.text,/关键变化/);assert.match(packet.text,/气口/);
 assert.doesNotMatch(packet.text,/SECRET_|director_refinement|基稿版本|精修版本|预测评分/);assert.equal(packet.labels.length,2);
 assert.deepEqual(buildReviewPacket(d,{candidateId:'candidate'}),packet);
});
test('adopted comparison recovers the exact original draft from archive, not the current candidate twice',()=>{
 const d=fixture(),c=d.candidates[0];d.refinementArchives=[{candidateId:c.id,baseAssemblyHash:c.refinement.baseAssemblyHash,assembly:structuredClone(d.assembly),adopted:structuredClone(d.adopted)}];
 d.assembly.text='候选完整正文';d.adopted=[{candidateId:c.id}];c.status='adopted';
 const packet=buildReviewPacket(d,{candidateId:c.id});assert.match(packet.text,/基稿完整正文/);assert.equal(packet.text.match(/候选完整正文/g).length,1);
});
test('bad, missing or stale candidates cannot masquerade as an external review pair',()=>{
 const d=fixture();assert.throws(()=>buildReviewPacket(d,{candidateId:'missing'}),e=>e.code==='REFINEMENT_CANDIDATE');
 d.candidates[0].status='refinement_invalid';assert.throws(()=>buildReviewPacket(d,{candidateId:'candidate'}),e=>e.code==='REFINEMENT_CANDIDATE');
 d.candidates[0].status='refinement_ready';d.assembly.text='changed';assert.throws(()=>buildReviewPacket(d,{candidateId:'candidate'}),e=>e.code==='REFINEMENT_STALE');
});
test('preview-only continuity is clearly marked without exposing which blind draft is newer',()=>{
 const d=fixture();d.candidates[0].adoptionBlocked={code:'REFINEMENT_PREVIEW_ONLY',message:'private backend reason'};const packet=buildReviewPacket(d,{candidateId:'candidate'});
 assert.match(packet.text,/尚未完成实际跨集承接核对/);assert.doesNotMatch(packet.text,/private backend reason/);
});
test('blind rubric does not reveal target scores or prefer a newer version',()=>{
 const packet=buildReviewPacket(fixture(),{candidateId:'candidate'});
 assert.doesNotMatch(packet.text,/9分|九分|8分|新版本必更好/);
 assert.match(packet.text,/整体文本质量（独立判断，不机械平均）/);
});
test('unchanged refinement exports the retained draft once with a single-draft rubric',()=>{
 const d=fixture();d.candidates[0].previewText=d.assembly.text;
 const packet=buildReviewPacket(d,{candidateId:'candidate'});
 assert.match(packet.text,/无改动\/保留原稿/);
 assert.equal(packet.text.match(/基稿完整正文/g).length,1);
 assert.equal(packet.labels.length,1);assert.equal(packet.labels[0].origin,'base');
 assert.doesNotMatch(packet.text,/稿件 B|B ___|偏好|较弱稿|先逐稿独立评阅，再比较/);
 assert.match(packet.text,/稿件 A（0–10）/);
});
test('a standalone baseline export also has no absent B score or preference field',()=>{
 const packet=buildReviewPacket(fixture());
 assert.equal(packet.labels.length,1);
 assert.doesNotMatch(packet.text,/稿件 B|B ___|偏好|较弱稿/);
});
test('punctuation, timecode and whitespace changes remain distinct full drafts',()=>{
 for(const [before,after] of [['00:01.0 我……愿意。','00:01.0 我…愿意。'],['00:01.0 我愿意。','00:01.1 我愿意。'],[' 我愿意。\n','我愿意。\n']]){
  const d=fixture();d.assembly.text=before;d.candidates[0].previewText=after;
  const hash=refinementAssemblyHash(d);d.operations[0].refinement.baseAssemblyHash=hash;d.candidates[0].refinement.baseAssemblyHash=hash;
  const packet=buildReviewPacket(d,{candidateId:'candidate'});
  assert.equal(packet.labels.length,2);assert.ok(packet.text.includes(before));assert.ok(packet.text.includes(after));
  assert.match(packet.text,/稿件 B（0–10）/);
 }
});
test('missing frozen series direction is stated explicitly',()=>{
 const d=fixture();delete d.source.context.seriesDirection;
 assert.match(buildReviewPacket(d,{candidateId:'candidate'}).text,/本任务未采用已确认全剧方向，冻结输入为空/);
});
test('unchanged adopted refinement uses its exact archived baseline once',()=>{
 const d=fixture(),c=d.candidates[0];c.previewText=d.assembly.text;
 d.refinementArchives=[{candidateId:c.id,baseAssemblyHash:c.refinement.baseAssemblyHash,assembly:structuredClone(d.assembly),adopted:structuredClone(d.adopted)}];
 d.assembly.text='随后修改的当前稿';d.adopted=[{candidateId:c.id}];c.status='adopted';
 const packet=buildReviewPacket(d,{candidateId:c.id});
 assert.match(packet.text,/无改动\/保留原稿/);assert.equal(packet.labels.length,1);
 assert.equal(packet.text.match(/基稿完整正文/g).length,1);assert.doesNotMatch(packet.text,/随后修改的当前稿/);
});
test('single and paired rubrics are contiguous Markdown tables with matching column counts',()=>{
 for(const paired of [false,true]){
  const packet=buildReviewPacket(fixture(),paired?{candidateId:'candidate'}:{});
  const table=packet.text.slice(packet.text.indexOf('| 维度 |'),packet.text.indexOf('请另填：')).trim();
  assert.ok(!table.includes('\n\n'),'评分表行之间不应有空行');
  assert.ok(table.split('\n').every(row=>row.split('|').length===(paired?7:6)),'评分表各行的列数一致');
 }
});
test('unavailable text cannot be exported as a manufactured comparison',()=>{
 const candidateCase=fixture();candidateCase.candidates[0].previewText={text:'不是完整正文字符串'};
 assert.throws(()=>buildReviewPacket(candidateCase,{candidateId:'candidate'}),e=>e.code==='REFINEMENT_CANDIDATE');
 const baseCase=fixture();baseCase.assembly.text={text:'不是完整正文字符串'};
 const h=refinementAssemblyHash(baseCase);baseCase.operations[0].refinement.baseAssemblyHash=h;baseCase.candidates[0].refinement.baseAssemblyHash=h;
 assert.throws(()=>buildReviewPacket(baseCase,{candidateId:'candidate'}),e=>e.code==='REFINEMENT_BASE_REQUIRED');
});
const scopedFixture=()=>{
 const d=fixture();d.plan={events:[{id:'e1'},{id:'e2'}],fantasyCandidates:[]};
 d.source.sourceRows=[{id:'r1',text:'开场'},{id:'r2',text:'迟疑起点'+('甲'.repeat(140))},{id:'r3',text:'决定落点'+('乙'.repeat(140))},{id:'r4',text:'下一事件'}];
 d.assembly.draft={units:[
  {id:'u1',eventId:'e1',shots:[{id:'s1',picture:'开场',sourceRefs:['r1']}]},
  {id:'u2',eventId:'e1',shots:[{id:'s2',picture:'迟疑',sourceRefs:['r2']},{id:'s3',picture:'落定',sourceRefs:['r3']}]},
  {id:'u3',eventId:'e2',shots:[{id:'s4',picture:'下一事件',sourceRefs:['r4']}]},
 ]};
 d.operations[0].refinement.unitIds=['u2'];
 const h=refinementAssemblyHash(d);d.operations[0].refinement.baseAssemblyHash=h;d.candidates[0].refinement.baseAssemblyHash=h;d.candidates[0].draft=structuredClone(d.assembly.draft);
 return d;
};
const section=(text,heading)=>text.split(`## ${heading}\n\n`)[1]?.split('\n\n## ')[0]||'';
test('export describes the permitted frozen unit scope with short source anchors and counts',()=>{
 const d=scopedFixture(),packet=buildReviewPacket(d,{candidateId:'candidate'}),scope=section(packet.text,'本次允许修改范围');
 assert.ok(scope.includes('局部'),'单元选区应明确为局部');assert.ok(scope.includes('1 单元 / 2 镜'));
 assert.match(scope,/事件：e1/);assert.match(scope,/单元：u2/);assert.match(scope,/原文首锚：r2 · 迟疑起点/);assert.match(scope,/原文尾锚：r3 · 决定落点/);
 assert.doesNotMatch(scope,/e2|u1|u3|下一事件|甲{81}|乙{81}/);
});
test('export states when the frozen permitted scope covers the whole episode',()=>{
 const d=scopedFixture();d.operations[0].refinement.eventIds=['e1','e2'];delete d.operations[0].refinement.unitIds;
 const scope=section(buildReviewPacket(d,{candidateId:'candidate'}).text,'本次允许修改范围');
 assert.ok(scope.includes('全集'));assert.ok(scope.includes('3 单元 / 4 镜'));assert.match(scope,/单元：u1、u2、u3/);
});
test('actual difference coordinates identify modified objects without claiming an improvement or revealing origins',()=>{
 const d=scopedFixture();d.candidates[0].draft.units[1].shots[0].picture='眼神先挣扎后落定';
 const actual=section(buildReviewPacket(d,{candidateId:'candidate'}).text,'实际差异坐标（不代表提升）');
 assert.match(actual,/单元：u2/);assert.match(actual,/镜：s2/);assert.doesNotMatch(actual,/u1|u3|s1|s3|s4|候选|基稿|A.*candidate|B.*base/);
});
test('unchanged text explicitly has no actual difference coordinates',()=>{
 const d=scopedFixture();d.candidates[0].previewText=d.assembly.text;
 const actual=section(buildReviewPacket(d,{candidateId:'candidate'}).text,'实际差异坐标（不代表提升）');
 assert.match(actual,/无（正文逐字符相同）/);
});
test('permitted scope after adoption uses the archived baseline draft rather than the current assembly',()=>{
 const d=scopedFixture(),c=d.candidates[0];d.refinementArchives=[{candidateId:c.id,baseAssemblyHash:c.refinement.baseAssemblyHash,assembly:structuredClone(d.assembly),adopted:structuredClone(d.adopted)}];
 d.assembly={...d.assembly,draft:{units:[{id:'later',eventId:'e2',shots:[]}]}};d.adopted=[{candidateId:c.id}];c.status='adopted';
 const scope=section(buildReviewPacket(d,{candidateId:c.id}).text,'本次允许修改范围');
 assert.ok(scope.includes('1 单元 / 2 镜'));assert.match(scope,/单元：u2/);assert.doesNotMatch(scope,/later/);
});
