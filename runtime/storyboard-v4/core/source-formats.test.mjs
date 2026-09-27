import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScript,normalizeSource} from './source.mjs';
import {buildRequest,sliceSource} from './core.mjs';

test('scene lists, split headings and triangle actions preserve source without becoming speech',()=>{
 const lines=['第一集','1-1','日 内 道观','场景：道观','人物：甲、乙','道具：无','甲os：该出发了。','▲甲抬手。【字幕：甲/修行者】','1-2墓地 日 外','▲甲跪拜。','2.2日，外，中海路','人物：甲、路人','路人：你是谁？'];
 for(const separator of ['\n','\r\n','\r']){
  const s=parseScript(lines.join(separator),{key:'scene-formats'});
  assert.deepEqual(s.diagnostics,[]);
  assert.deepEqual(s.sourceRows.map(r=>r.text),lines);
  assert.deepEqual(s.sourceRows.map(r=>r.line),lines.map((_,i)=>i+1));
  assert.deepEqual(s.dialogue.map(d=>[d.speaker,d.quote,d.channel]),[['甲','该出发了。','OS'],['路人','你是谁？','现场对白']]);
  assert.equal(s.sourceRows[7].kind,'action');
  assert.deepEqual(normalizeSource(s),s);
 }
});

test('scene recognition does not swallow decimals, ordinary prose or similar actor names',()=>{
 const s=parseScript('1.1 日，内，道观\n1-1收容所 夜 内\n3.14元可以买什么\n日内完成任务\n人物师：这句要念。\n道具师：别动。\n甲：人物：甲、乙。',{key:'scene-negative'});
 assert.deepEqual(s.diagnostics.map(d=>d.rowId),['scene-negative:L0003','scene-negative:L0004']);
 assert.deepEqual(s.dialogue.map(d=>[d.speaker,d.quote]),[['人物师','这句要念。'],['道具师','别动。'],['甲','人物：甲、乙。']]);
});

const montageLines=['人物：甲、乙','甲VO：我来应聘。【搭配画面：甲走进大门。】','','因为我需要钱。【搭配画面：合同上写着：日结！】','','这里日薪三千。【搭配画面：乙把合同放下。】','△乙指着合同。','乙VO：夜班巡逻。【搭配画面：走廊。】','','千万别靠近门。【搭配画面：门后出现眼睛。】','甲：我记下了。'];
test('annotated VO continuations share speaker and channel while visual notes stay in original rows',()=>{
 const s=parseScript(montageLines.join('\n'),{key:'montage'});
 assert.deepEqual(s.diagnostics,[]);
 assert.deepEqual(s.sourceRows.map(r=>r.text),montageLines);
 assert.deepEqual(s.dialogue.map(d=>[d.speaker,d.channel,d.quote]),[['甲','VO','我来应聘。因为我需要钱。这里日薪三千。'],['乙','VO','夜班巡逻。千万别靠近门。'],['甲','现场对白','我记下了。']]);
 assert.deepEqual(s.dialogue[0].sourceIds,['montage:L0002','montage:L0004','montage:L0006']);
 assert.deepEqual(s.dialogue[1].sourceIds,['montage:L0008','montage:L0010']);
 assert.deepEqual(normalizeSource(s),s);
 const part=sliceSource(s,['montage:L0004']);
 assert.deepEqual(part.dialogue[0],s.dialogue[0]);
 assert.ok(part.sourceRows.some(r=>r.text.includes('合同上写着：日结！')));
 const request=buildRequest({stage:'plan',source:s,settings:{maxUnits:null,maxUnitSeconds:30,fantasyMode:'recommended'}});
 assert.ok(request.schema && request.prompt.includes('合同上写着：日结！'));
});

test('VO continuation crosses only blank layout rows, never an action, scene or unattributed text',()=>{
 for(const barrier of ['△甲离开。','▲甲离开。','1-2','日 外 门口','人物：乙','乙：（抬头）','乙：（抬头）【搭配画面：乙抬头。】','乙：【搭配画面：乙抬头。】','【搭配画面：门。】△乙离开。','【搭配画面：门。】1-2','无归属普通句','【搭配画面：门。】']){
  const s=parseScript(`甲VO：开头。【搭配画面：窗。】\n\n${barrier}\n\n下一句话。【搭配画面：门。】`,{key:'barrier'});
  assert.equal(s.dialogue[0].quote,'开头。',barrier);
  assert.deepEqual(s.dialogue[0].sourceIds,['barrier:L0001']);
  assert.ok(s.diagnostics.some(d=>d.rowId==='barrier:L0005'),barrier);
 }
 const onScreen=parseScript('甲：现场话。【搭配画面：窗。】\n下一句。【搭配画面：门。】',{key:'no-guess'});
 assert.equal(onScreen.dialogue[0].quote,'现场话。');
 assert.ok(onScreen.diagnostics.some(d=>d.rowId==='no-guess:L0002'));
});

test('standalone visual annotations are not speakers; literal brackets and malformed annotations are preserved',()=>{
 const s=parseScript('【搭配画面：门牌写着：保密。】\n甲：牌上写的是【特等】。\n甲VO：未完成。【搭配画面：窗口',{key:'notes'});
 assert.equal(s.sourceRows[0].kind,'action');
 assert.deepEqual(s.dialogue.map(d=>d.quote),['牌上写的是【特等】。']);
 assert.deepEqual(s.diagnostics.map(d=>d.rowId),['notes:L0003']);
 assert.equal(s.sourceRows[2].text,'甲VO：未完成。【搭配画面：窗口');
});

test('explicit legacy dialogue is preserved and compatibility still requires exact words, speaker and channel',()=>{
 const sourceRows=[{line:1,text:'甲VO：旧原话。【搭配画面：甲站着。】'},{line:2,text:'下一句。【搭配画面：门。】'}];
 const quote='旧原话。【搭配画面：甲站着。】';
 const raw={key:'legacy',sourceRows,dialogue:[{id:'D-old',speaker:'甲',quote,cue:'VO',channel:'VO',sourceIds:['legacy:L0001']}]};
 const s=normalizeSource(raw);
 assert.equal(s.dialogue[0].quote,quote);
 assert.deepEqual(s.dialogue[0].sourceIds,['legacy:L0001']);
 assert.equal(s.dialogue[0].id,'D-old');
 assert.deepEqual(normalizeSource(s),s);
 for(const patch of [{quote:'旧原话'},{speaker:'乙'},{channel:'OS'}])assert.throws(()=>normalizeSource({...raw,dialogue:[{...raw.dialogue[0],...patch}]}));
 const fresh=parseScript(sourceRows.map(r=>r.text).join('\n'),{key:'fresh'});
 assert.throws(()=>normalizeSource({...fresh,dialogue:[{...fresh.dialogue[0],quote:'旧原话。'}]}),/原句/);
});
