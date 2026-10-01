import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeSource,parseScript,resolveSourceRef} from './source.mjs';
import {resolveSelection,confirmSelection,rebaseSelection,selectionFingerprint} from './selection.mjs';

test('P source keeps exact split punctuation, trace coordinates, and aliases',()=>{
  const raw=JSON.parse(readFileSync(new URL('./fixtures/clash-source.json',import.meta.url)));
  const source=normalizeSource(raw);
  assert.equal(source.dialogue[1].quote,'苏远，这就是你跟我说话的态度？我说了，我们已经分手了，不要缠着我！');
  assert.equal(source.dialogue[1].rowId,'clash:P0082');
  assert.equal(resolveSourceRef(source,'P0083').id,'clash:P0083');
  assert.equal(resolveSourceRef(source,'L0117').id,'clash:P0083');
  assert.throws(()=>resolveSourceRef(source,'L0083'),/不存在/);
  assert.equal(source.sourceRows[3].text,'！');
});

test('duplicate coordinate alias is rejected rather than choosing first',()=>{
  assert.throws(()=>normalizeSource({key:'x',sourceRows:[{line:1,text:'甲'},{line:1,text:'乙'}]}),/ambiguous|歧义/i);
});

test('empty actor cue stays a row, not fabricated dialogue',()=>{
  const source=parseScript('L0001 | 张三：（含泪低头）\nL0002 | 张三：我来了。',{key:'x'});
  assert.equal(source.sourceRows.length,2);
  assert.deepEqual(source.dialogue.map(d=>d.quote),['我来了。']);
});

test('orphan punctuation is not counted as owned dialogue',()=>{
  const s=parseScript('L0001 | ！',{key:'x'});
  assert.equal(s.dialogue.length,0);
  assert.equal(s.sourceRows[0].kind,'action');
  assert.equal(s.diagnostics.length,1);
});

test('plain script rejoins a separate punctuation row without changing either source row',()=>{
  const s=parseScript('P0082 | 甲：不要走\nP0083 | ！',{key:'p'});
  assert.equal(s.dialogue[0].quote,'不要走！');
  assert.deepEqual(s.dialogue[0].sourceIds,['p:P0082','p:P0083']);
  assert.equal(s.sourceRows[1].text,'！');
});

test('wrapped punctuation crosses only empty layout rows and keeps exact source coordinates',()=>{
  const lines=['赵清雅：我说了，我们已经分手了，不要缠着我','','　 \t','！','','？','苏远：我只是通知你。'];
  const s=parseScript(lines.join('\r\n'),{key:'wrapped'});
  assert.deepEqual(s.diagnostics,[]);
  assert.equal(s.dialogue[0].quote,'我说了，我们已经分手了，不要缠着我！？');
  assert.deepEqual(s.dialogue[0].sourceIds,['wrapped:L0001','wrapped:L0004','wrapped:L0006']);
  assert.deepEqual(s.sourceRows.map(r=>r.text),lines);
  assert.deepEqual(s.sourceRows.map(r=>r.line),[1,2,3,4,5,6,7]);
  assert.equal(s.dialogue[1].quote,'我只是通知你。');
  assert.deepEqual(normalizeSource(s),s);
});

test('punctuation never bridges an action, scene, empty actor cue or unrecognized text',()=>{
  for(const boundary of ['△乙转身离开。','2-1 日 外 学校','乙：（抬头）','未注明归属的话','出场人物：乙']){
    const s=parseScript(`甲：别走\n\n${boundary}\n\n！`,{key:'barrier'});
    assert.equal(s.dialogue[0].quote,'别走',boundary);
    assert.deepEqual(s.dialogue[0].sourceIds,['barrier:L0001']);
    assert.ok(s.diagnostics.some(d=>d.rowId==='barrier:L0005'&&d.reason==='孤立标点无法归属对白'),boundary);
  }
  const next=parseScript('甲：别走\n\n乙：等一下\n\n！',{key:'speakers'});
  assert.deepEqual(next.dialogue.map(d=>[d.speaker,d.quote]),[['甲','别走'],['乙','等一下！']]);
  assert.deepEqual(next.diagnostics,[]);
});

test('explicit saved dialogue is not silently expanded by layout punctuation inference',()=>{
  const s=normalizeSource({key:'saved',sourceRows:[{line:1,text:'甲：别走'},{line:2,text:''},{line:3,text:'！'}],dialogue:[{id:'saved-d1',line:1,speaker:'甲',quote:'别走',channel:'现场对白'}]});
  assert.equal(s.dialogue[0].quote,'别走');
  assert.deepEqual(s.dialogue[0].sourceIds,['saved:L0001']);
  assert.ok(s.diagnostics.some(d=>d.rowId==='saved:L0003'));
});

test('space-delimited scene headings stay metadata without losing their text or coordinates',()=>{
  const lines=['第二集','','场景 姑苏高中觉醒大厅','甲：我来了。','场景\t觉醒大厅外','场景　饭店','场景：街道'];
  const s=parseScript(lines.join('\n'),{key:'scene-heading'});
  assert.deepEqual(s.diagnostics,[]);
  assert.deepEqual(s.sourceRows.map(r=>r.kind),['metadata','blank','metadata','dialogue','metadata','metadata','metadata']);
  assert.deepEqual(s.sourceRows.map(r=>r.text),lines);
  assert.equal(resolveSourceRef(s,'L0003').text,'场景 姑苏高中觉醒大厅');
  assert.deepEqual(s.dialogue.map(d=>[d.speaker,d.quote]),[['甲','我来了。']]);
  assert.deepEqual(normalizeSource(s),s);
});

test('scene heading recognition never consumes ordinary speech, actions or similar names',()=>{
  const s=parseScript('甲：场景 饭店\n场景师：灯光调好了。\n△场景里的人散去。\n场景很安静\n这一处场景 店内\n场景  \n场景 师：保留这句。',{key:'scene-boundary'});
  assert.deepEqual(s.dialogue.map(d=>[d.speaker,d.quote]),[['甲','场景 饭店'],['场景师','灯光调好了。'],['场景 师','保留这句。']]);
  assert.deepEqual(s.sourceRows.map(r=>r.kind),['dialogue','dialogue','action','action','action','action','dialogue']);
  assert.deepEqual(s.diagnostics.map(d=>d.rowId),['scene-boundary:L0004','scene-boundary:L0005','scene-boundary:L0006']);
  const barrier=parseScript('甲：别走\n\n场景 大厅外\n\n！',{key:'scene-punctuation'});
  assert.equal(barrier.dialogue[0].quote,'别走');
  assert.equal(barrier.sourceRows[2].kind,'metadata');
  assert.deepEqual(barrier.diagnostics,[{rowId:'scene-punctuation:L0005',reason:'孤立标点无法归属对白'}]);
});

test('VO OS, system sound and out-of-frame roar retain channels and kinds',()=>{
  const s=parseScript('L0001 | 甲：（VO）你好。\nL0002 | 乙：（OS）谁？\nL0003 | 系统音：签到成功。\nL0004 | 巨兽：（画外咆哮）吼！',{key:'x'});
  assert.deepEqual(s.dialogue.map(d=>d.channel),['VO','OS','系统音','现场对白']);
  assert.equal(s.dialogue[3].kind,'roar');
  assert.match(s.dialogue[3].cue,/画外咆哮/);
  const raw=normalizeSource({key:'r',sourceRows:[{line:1,text:'巨兽：吼！'}],dialogue:[{id:'r1',line:1,speaker:'巨兽',quote:'吼！',channel:'画外咆哮'}]});
  assert.equal(raw.dialogue[0].channel,'现场对白');
  assert.equal(raw.dialogue[0].kind,'roar');
  assert.match(raw.dialogue[0].cue,/画外咆哮/);
});

test('unsupported line stays traceable and context references require opt-in',()=>{
  const s=parseScript('L0001 | 1-1 学校 日 外\nL0002 | 出场人物：甲、乙\nL0003 | 甲？无明确分隔',{key:'x',contextRows:[{line:8,text:'前情'}]});
  assert.equal(s.dialogue.length,0);
  assert.equal(s.sourceRows.length,3);
  assert.ok(s.diagnostics.length);
  assert.throws(()=>resolveSourceRef(s,'x:L0008'),/unknown|不存在/i);
  assert.equal(resolveSourceRef(s,'x:L0008',{allowContext:true}).text,'前情');
});

test('entry facts require locatable evidence',()=>{
  const raw={key:'x',sourceRows:[{line:1,text:'甲受伤'}],entryFacts:[{id:'f',subject:'甲',statement:'受伤',sourceRefs:['L0001'],evidence:'受伤'}]};
  assert.deepEqual(normalizeSource(raw).entryFacts[0].sourceRefs,['x:L0001']);
  assert.throws(()=>normalizeSource({...raw,entryFacts:[{...raw.entryFacts[0],evidence:'痊愈'}]}),/evidence|依据/i);
});

const plan=(patch={})=>({workPackages:[],provisionalUnits:[{id:'u1',sourceRefs:['x:L0001']},{id:'u2',sourceRefs:['x:L0002']}],fantasyCandidates:[{id:'a',anchorRefs:['x:L0001'],subject:'甲',emotionPurpose:'惊喜',recommended:true,proposal:'光'},{id:'b',anchorRefs:['x:L0001'],subject:'甲',emotionPurpose:'恐惧',recommended:false,proposal:'影'}],sourceFingerprints:{'x:L0001':'one','x:L0002':'two'},...patch});
const choice=(mode,patch={})=>({mode,overrides:{},unitOverrides:{},confirmedFingerprint:null,...patch});

test('off, all, recommended, review and nonrecommended candidate',()=>{
  const p=plan();
  assert.deepEqual(resolveSelection(p,choice('off')).selectedIds,[]);
  assert.deepEqual(resolveSelection(p,choice('recommended')).selectedIds,['a']);
  const all=resolveSelection(p,choice('all'));
  assert.deepEqual(all.selectedIds,['a','b']);
  assert.equal(all.status,'ready');
  assert.deepEqual(all.unfulfilledUnitIds,[]);
  assert.deepEqual(all.byUnit.u2,[]);
  assert.equal(resolveSelection(p,choice('review',{unitOverrides:{u2:false}})).status,'awaiting_confirmation');
});

test('point override beats unit override and mode',()=>{
  const r=resolveSelection(plan(),choice('off',{unitOverrides:{u1:true},overrides:{a:false}}));
  assert.deepEqual(r.selectedIds,['b']);
  assert.deepEqual(r.byUnit.u1,['b']);
});

test('one candidate across two units is selected once; conflicting unit votes need a point choice',()=>{
  const p=plan({provisionalUnits:[{id:'u1',sourceRefs:['x:L0001']},{id:'u2',sourceRefs:['x:L0001']}],fantasyCandidates:[{id:'a',anchorRefs:['x:L0001'],recommended:true}]});
  assert.deepEqual(resolveSelection(p,choice('all')).selectedIds,['a']);
  assert.throws(()=>resolveSelection(p,choice('all',{unitOverrides:{u1:true,u2:false}})),/冲突|conflict/i);
  assert.deepEqual(resolveSelection(p,choice('all',{unitOverrides:{u1:true,u2:false},overrides:{a:true}})).selectedIds,['a']);
});

test('editing a review choice after confirmation invalidates confirmation',()=>{
  const p=plan(),initial=choice('review',{unitOverrides:{u2:false}});
  const confirmed=confirmSelection(p,initial,['a'],selectionFingerprint(p,initial));
  assert.equal(resolveSelection(p,confirmed).status,'ready');
  assert.equal(resolveSelection(p,{...confirmed,overrides:{...confirmed.overrides,b:true}}).status,'awaiting_confirmation');
});

test('all with zero candidates is ready without inventing fantasy requests',()=>{
  const p=plan({fantasyCandidates:[]});
  const result=resolveSelection(p,choice('all'));
  assert.equal(result.status,'ready');
  assert.deepEqual(result.selectedIds,[]);
  assert.deepEqual(result.unfulfilledUnitIds,[]);
  assert.deepEqual(result.byUnit,{u1:[],u2:[]});
});

test('only an explicit request for an uncovered unit needs a fantasy design',()=>{
  for(const mode of ['all','recommended','review']){
    const requested=resolveSelection(plan(),choice(mode,{unitOverrides:{u2:true}}));
    assert.equal(requested.status,'needs_design');
    assert.deepEqual(requested.unfulfilledUnitIds,['u2']);
    const declined=resolveSelection(plan(),choice(mode,{unitOverrides:{u2:false}}));
    assert.deepEqual(declined.unfulfilledUnitIds,[]);
    assert.equal(declined.status,mode==='review'?'awaiting_confirmation':'ready');
  }
});

test('confirmation fixes selected and declined points despite recommendation refresh',()=>{
  const p=plan();
  const start=choice('review',{unitOverrides:{u2:false}}),before=resolveSelection(p,start);
  const c=confirmSelection(p,start,['b'],before.fingerprint);
  assert.deepEqual(resolveSelection(p,c).selectedIds,['b']);
  assert.equal(resolveSelection(p,c).status,'ready');
  const refreshed=plan({fantasyCandidates:p.fantasyCandidates.map(x=>({...x,recommended:!x.recommended}))});
  assert.deepEqual(resolveSelection(refreshed,c).selectedIds,['b']);
  assert.equal(resolveSelection(refreshed,c).status,'ready');
});

test('old confirmation rejected; rebase preserves renumbering and unrelated source change',()=>{
  const p=plan();
  assert.throws(()=>confirmSelection(p,choice('review'),['a'],'stale'),/fingerprint|过期/i);
  const start=choice('review',{unitOverrides:{u2:false}});
  const c=confirmSelection(p,start,['a'],selectionFingerprint(p,start));
  const renumbered=plan({provisionalUnits:[{id:'next1',sourceRefs:['x:L0001']},{id:'next2',sourceRefs:['x:L0002']}],sourceFingerprints:{'x:L0001':'one','x:L0002':'changed'}});
  const next=rebaseSelection(p,renumbered,c);
  assert.deepEqual(resolveSelection(renumbered,next).selectedIds,['a']);
  assert.equal(resolveSelection(renumbered,next).status,'ready');
});

test('changed candidate anchor or related source invalidates prior confirmation',()=>{
  const p=plan();
  const start=choice('review',{unitOverrides:{u2:false}});
  const c=confirmSelection(p,start,['a'],selectionFingerprint(p,start));
  const changedSource=plan({sourceFingerprints:{'x:L0001':'changed','x:L0002':'two'}});
  assert.equal(resolveSelection(changedSource,rebaseSelection(p,changedSource,c)).status,'awaiting_confirmation');
  const changedAnchor=plan({fantasyCandidates:[{...p.fantasyCandidates[0],anchorRefs:['x:L0002']},p.fantasyCandidates[1]]});
  assert.notEqual(resolveSelection(changedAnchor,rebaseSelection(p,changedAnchor,c)).status,'ready');
});

test('numeric line alias is real, but P logical number is not an L file line',()=>{
  const p=normalizeSource({key:'p',sourceRows:[{sourceId:'P0081',line:81,sourceFileLine:111,text:'△抬头。'}]});
  assert.equal(resolveSourceRef(p,81).id,'p:P0081');
  assert.equal(resolveSourceRef(p,'L0111').id,'p:P0081');
  assert.throws(()=>resolveSourceRef(p,'L0081'),/不存在/);
  const l=normalizeSource({key:'l',sourceRows:[{line:559,text:'△起身。'}]});
  assert.equal(resolveSourceRef(l,'559').id,'l:L0559');
});

test('P and decorated L/P script coordinates parse without treating scene metadata as speech',()=>{
  const s=parseScript('P0080　△抬头。\nL0111 | P0081 苏远os：别走！\nP0082 苏炎（VO）：来了。\nP0083 苏炎：（VO）受死！\nP0084 12-1：日 外 学校\nP0085 出场人物：苏炎',{key:'p'});
  assert.deepEqual(s.sourceRows.map(r=>r.kind),['action','dialogue','dialogue','dialogue','metadata','metadata']);
  assert.deepEqual(s.dialogue.map(d=>[d.speaker,d.channel,d.quote]),[['苏远','OS','别走！'],['苏炎','VO','来了。'],['苏炎','VO','受死！']]);
  assert.equal(resolveSourceRef(s,'L0111').id,'p:P0081');
});

test('supplied dialogue rejects shortened quote, wrong speaker and source channel',()=>{
  const raw={key:'x',sourceRows:[{line:1,text:'甲：（VO）不要走！'}],dialogue:[{id:'d',line:1,speaker:'甲',quote:'不要走！',channel:'VO'}]};
  assert.equal(normalizeSource(raw).dialogue[0].quote,'不要走！');
  assert.throws(()=>normalizeSource({...raw,dialogue:[{...raw.dialogue[0],quote:'不要走'}]}),/原句|quote/i);
  assert.throws(()=>normalizeSource({...raw,dialogue:[{...raw.dialogue[0],speaker:'乙'}]}),/说者|speaker/i);
  assert.throws(()=>normalizeSource({...raw,dialogue:[{...raw.dialogue[0],channel:'现场对白'}]}),/声道|channel/i);
  const inferred=normalizeSource({...raw,dialogue:[{id:'d',line:1,speaker:'甲',quote:'不要走！'}]});
  assert.equal(inferred.dialogue[0].channel,'VO');
});

test('spoken words remain speech despite shouting or scream cue',()=>{
  const s=parseScript('L0001 | 甲：（怒吼）给我灭！\nL0002 | 乙：（惨叫）啊！我的腿！\nL0003 | 巨兽：（画外咆哮）吼！',{key:'x'});
  assert.deepEqual(s.dialogue.map(d=>d.kind),['speech','speech','roar']);
  assert.equal(s.dialogue[2].originalChannel,'画外咆哮');
});

test('normalization rejects duplicate ids, duplicate aliases and missing source text',()=>{
  assert.throws(()=>normalizeSource({key:'x',sourceRows:[{id:'same',line:1,text:'甲'},{id:'same',line:2,text:'乙'}]}),/重复|duplicate/i);
  assert.throws(()=>normalizeSource({key:'x',sourceRows:[{line:1,text:'甲'},{line:1,text:'乙'}]}),/歧义|ambiguous/i);
  assert.throws(()=>normalizeSource({key:'x',sourceRows:[{line:1}]}),/text|原文/i);
  assert.throws(()=>normalizeSource({key:'x',sourceRows:[{line:'1',text:'甲'}]}),/line|坐标/i);
  assert.throws(()=>normalizeSource({key:'x',sourceRows:[{line:1,text:'甲：好。'}],dialogue:[{id:'d',line:1,speaker:'甲',quote:'好。'},{id:'d',line:1,speaker:'甲',quote:'好。'}]}),/重复|duplicate/i);
  const s=normalizeSource({key:'x',sourceRows:[{line:1,text:'△起身。',kind:'metadata'},{line:2,text:'甲：（低头）',kind:'dialogue'}]});
  assert.deepEqual(s.sourceRows.map(r=>r.kind),['action','action']);
  assert.throws(()=>normalizeSource({key:'x',sourceRows:[{line:1,text:'甲受伤'}],entryFacts:[{id:'f',subject:'甲',statement:'受伤',sourceRefs:['1'],evidence:'受伤'},{id:'f',subject:'甲',statement:'受伤',sourceRefs:['1'],evidence:'受伤'}]}),/重复|duplicate/i);
});

test('explicit channel and kind cannot be masked by cue text',()=>{
  const raw={key:'x',sourceRows:[{line:1,text:'甲：（VO）走！'}],dialogue:[{id:'d',line:1,speaker:'甲',quote:'走！',cue:'VO',channel:'现场对白'}]};
  assert.throws(()=>normalizeSource(raw),/声道|channel/i);
  assert.throws(()=>normalizeSource({...raw,dialogue:[{...raw.dialogue[0],channel:'VO',kind:'roar'}]}),/kind|声类/i);
});

test('recommended can choose none; review can confirm none; all respects explicit declines',()=>{
  const p=plan({fantasyCandidates:[{id:'a',anchorRefs:['x:L0001'],recommended:false}],provisionalUnits:[{id:'u1',sourceRefs:['x:L0001']}]});
  assert.equal(resolveSelection(p,choice('recommended')).status,'ready');
  const review=choice('review'),confirmed=confirmSelection(p,review,[],selectionFingerprint(p,review));
  assert.equal(resolveSelection(p,confirmed).status,'ready');
  assert.equal(resolveSelection(p,choice('all',{overrides:{a:false}})).status,'ready');
});

test('proposal and timing edits preserve confirmed choice',()=>{
  const p=plan({provisionalUnits:[{id:'u1',sourceRefs:['x:L0001']}]});
  const first=choice('review'),c=confirmSelection(p,first,['a'],selectionFingerprint(p,first));
  const edited=plan({provisionalUnits:p.provisionalUnits,fantasyCandidates:p.fantasyCandidates.map(x=>({...x,proposal:'另一画法',screenSecondsRange:[2,5]}))});
  assert.equal(resolveSelection(edited,rebaseSelection(p,edited,c)).status,'ready');
});

test('rebase split unit propagates explicit off; changed point is isolated for review',()=>{
  const p=plan({provisionalUnits:[{id:'u1',sourceRefs:['x:L0001','x:L0002']}],fantasyCandidates:[{id:'a',anchorRefs:['x:L0001'],subject:'甲',emotionPurpose:'惊喜',recommended:true},{id:'b',anchorRefs:['x:L0002'],subject:'乙',emotionPurpose:'惧怕',recommended:true}]});
  const start=choice('review',{unitOverrides:{u1:false}}),c=confirmSelection(p,start,[],selectionFingerprint(p,start));
  const split=plan({provisionalUnits:[{id:'n1',sourceRefs:['x:L0001']},{id:'n2',sourceRefs:['x:L0002']}],fantasyCandidates:p.fantasyCandidates});
  const migrated=rebaseSelection(p,split,c);
  assert.deepEqual(migrated.unitOverrides,{n1:false,n2:false});
  assert.equal(resolveSelection(split,migrated).status,'ready');
  const changed=plan({provisionalUnits:split.provisionalUnits,fantasyCandidates:[{...p.fantasyCandidates[0],emotionPurpose:'悲伤'},p.fantasyCandidates[1]]});
  const rebased=rebaseSelection(p,changed,c);
  assert.deepEqual(rebased.reviewRequiredIds,['a']);
  assert.equal(Object.hasOwn(rebased.overrides,'a'),false);
  assert.equal(rebased.overrides.b,false);
  assert.equal(resolveSelection(changed,rebased).status,'awaiting_confirmation');
});

test('candidate id matching Object prototype cannot inherit an override',()=>{
  const p=plan({provisionalUnits:[{id:'u1',sourceRefs:['x:L0001']}],fantasyCandidates:[{id:'toString',anchorRefs:['x:L0001'],recommended:false}]});
  assert.deepEqual(resolveSelection(p,choice('off')).selectedIds,[]);
});
