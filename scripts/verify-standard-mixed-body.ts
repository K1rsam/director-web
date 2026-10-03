import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {compileStandardScript} from '../lib/standard-script';
import {prepareStandardEpisode, deriveStandardScriptLines} from '../lib/standard-script-plan';
import {prepareEpisodeReception, scriptStructureTable} from '../lib/standard-script-reception';
import {applyScriptResolutions} from '../lib/script-resolution-plan';

const require = createRequire(import.meta.url);
const {makeEpisodeInput} = require('../runtime/storyboard-v4/input.mjs');
const {standardPackageSource} = require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource} = require('../runtime/storyboard-v4/core/source.mjs');
const {sliceSource, buildRequest, captureRules} = require('../runtime/storyboard-v4/core/core.mjs');
function accepted(text: string) {
  const prepared = prepareStandardEpisode(text, 'mixed');
  assert.deepEqual(prepared.diagnostics, [], text);
  assert.ok(prepared.compiled);
  const episode = {id: 'ep', projectId: 'p', number: 1, title: '第1集', content: text};
  const input = makeEpisodeInput({episode, project: {id:'p'}, inputProtocol:'upstream-material-v2',
    handoff:{readiness:'READY',reasons:[],packet:{sourceText:text,...prepareEpisodeReception(episode,null)}}});
  return {prepared, pkg: prepared.compiled.package, source: input.source};
}
function resign(pkg: any) {
  const canonical = (x: any): any => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])) : x;
  const {packageId, ...rest} = pkg, {receipt,...fidelity} = rest.fidelity;
  const digest = createHash('sha256').update(JSON.stringify(canonical({...rest,fidelity})),'utf16le').digest('hex');
  pkg.packageId = `standard:${digest}`; receipt.packageDigest = digest;
}

test('V3 explicit captions reach actual stage3 separately from exact OS/VO dialogue', () => {
  for (const eol of ['\n','\r\n','\r']) for (const [head,channel] of [['林岚os：','OS'],['林岚（VO）：','VO'],['林岚：（OS低声）','OS']]) {
    const text = `人物：林岚${eol}${head}我不会听话！【字幕：林岚/旅客】${eol}`;
    const {prepared,pkg,source} = accepted(text);
    assert.equal(prepared.plan.schemaVersion,'STANDARD_SCRIPT_PLAN_V3');
    assert.equal(pkg.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V3');
    assert.equal(pkg.fidelity.receipt.schemaVersion,'STANDARD_SCRIPT_MECHANICAL_RECEIPT_V3');
    assert.equal(pkg.assemblerVersion,'standard-script-compiler-v3');
    assert.equal(source.dialogue[0].quote,'我不会听话！');
    assert.equal(source.dialogue[0].channel,channel);
    assert.equal(source.onscreenTexts.length,1);
    assert.deepEqual(source.onscreenTexts.map((x:any)=>[x.kind,x.text,x.line]),[['ONSCREEN_TEXT','林岚/旅客',2]]);
    const row = source.sourceRows.find((r:any)=>r.standard.kind==='BODY_GROUP');
    assert.equal(row.text,`${head}我不会听话！【字幕：林岚/旅客】${eol}`);
    assert.equal(row.text.split('【字幕：林岚/旅客】').length-1,1);
    assert.equal(source.onscreenTexts[0].rowId,row.id);
    assert.equal(source.onscreenTexts[0].parts.map(([a,b]:number[])=>row.text.slice(a,b)).join(''),'林岚/旅客');
    assert.equal(deriveStandardScriptLines(prepared)[1].speaker,'林岚');
    assert.equal(deriveStandardScriptLines(prepared)[1].channel,channel);
    assert.deepEqual(normalizeSource(structuredClone(source)),source);
  }
});

test('leading/middle/multiple and bilingual explicit captions preserve only spoken source characters', () => {
  const {source} = accepted('林岚： 【字幕：三年后】还没【SUBTITLE: Arrival】到呢。【字幕:旅客】');
  assert.equal(source.dialogue[0].quote,'还没到呢。');
  assert.deepEqual(source.onscreenTexts.map((x:any)=>x.text),['三年后',' Arrival','旅客']);
  assert.ok(source.onscreenTexts.every((x:any)=>x.kind==='ONSCREEN_TEXT'));
  const multi = accepted('林岚（OS）：还没【字幕：林岚】\n走到那里。').source;
  assert.equal(multi.dialogue[0].quote,'还没\n走到那里。');
  assert.equal(multi.onscreenTexts[0].text,'林岚');
  for(const eol of ['\n','\r\n','\r']){
    const later = accepted(`林岚（OS）：还没${eol}到【字幕：林岚😀】呢。`).source;
    assert.equal(later.onscreenTexts[0].line,2,'caption line must locate its own original physical line, not only the containing dialogue start');
    assert.equal(later.onscreenTexts[0].text,'林岚😀');
    assert.equal(later.dialogue[0].quote,`还没${eol}到呢。`);
  }
});

test('V3 survives source scope and both actual model request projections', () => {
  const {source} = accepted('林岚os：我不走。【字幕：旅客】\n▲车停下。');
  const row = source.dialogue[0].rowId;
  assert.equal(sliceSource(source,[row]).onscreenTexts.length,1);
  assert.equal(sliceSource(source,[source.sourceRows.at(-1).id]).onscreenTexts.length,0);
  for (const production of [true,false]) {
    const rules = captureRules();
    if (!production) delete rules.modelProjectionVersion;
    const request = buildRequest({stage:'plan',source,settings:{maxUnits:null},rulesSnapshot:rules});
    const model = JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1]);
    assert.equal(model.source.dialogue[0].quote,'我不走。');
    assert.equal(model.source.onscreenTexts[0].text,'旅客');
    assert.equal(model.source.onscreenTexts[0].kind,'ONSCREEN_TEXT');
  }
});

test('compiler and independent consumer reject caption/channel tampering, omissions and overlaps even after resigning', () => {
  const text = '林岚os：我不走。【字幕：旅客】';
  const {prepared,pkg,source} = accepted(text);
  for (const mutate of [
    (p:any)=>{p.entries[0].children[0].channel='SPEECH';},
    (p:any)=>{p.entries[0].children[0].parts[0].end--;},
    (p:any)=>{p.entries[0].children[1].parts[0].start--;},
    (p:any)=>{p.entries[0].children.pop();},
  ]) {const plan=structuredClone(prepared.plan);mutate(plan);assert.throws(()=>compileStandardScript(prepared.index,plan));}
  for (const mutate of [
    (p:any)=>{p.script.entries[0].children[0].channel='SPEECH';},
    (p:any)=>{p.script.entries[0].children[0].textAssembly.parts[0].end--;p.script.entries[0].children[0].text='我不走';},
    (p:any)=>{p.script.entries[0].children[1].text='漏字';},
    (p:any)=>{p.script.entries[0].children[1].textAssembly.parts[0].start--;},
    (p:any)=>{p.script.entries[0].children.pop();},
  ]) {const altered=structuredClone(pkg);mutate(altered);resign(altered);assert.throws(()=>standardPackageSource(altered,{key:'ep',sourceText:text}));}
  for (const mutate of [(s:any)=>{s.onscreenTexts=[];},(s:any)=>{s.onscreenTexts[0].text='台词';},(s:any)=>{s.dialogue[0].quote+='【字幕：旅客】';}]) {
    const altered=structuredClone(source);mutate(altered);assert.throws(()=>normalizeSource(altered));
  }
});

test('V3 receiver rejects unknown nested child fields rather than discarding a re-signed extension',()=>{
  const text='林岚os（低声）：到了。【字幕：旅客】', {pkg}=accepted(text);
  const paths=[['textAssembly'],['textAssembly','parts',0],['speaker'],['speaker','parts',0],['channelSource'],['channelSource','parts',0],['cue'],['cue','parts',0],['layout',0]];
  for(const [i,list] of [[0,paths],[1,[['textAssembly'],['textAssembly','parts',0],['label'],['label','parts',0],['layout',0]]]] as const){
    for(const path of list){
      const altered:any=structuredClone(pkg);let field=altered.script.entries[0].children[i];
      for(const segment of path)field=field[segment];
      field.future={kind:'must-not-be-ignored'};resign(altered);
      assert.throws(()=>standardPackageSource(altered,{key:'ep',sourceText:text}),`child ${i}: ${path.join('.')}`);
    }
  }
});

test('mixed nodes stay visible in compact structure and cannot be recast by manual/assist resolution', () => {
  const content='林岚os：到了。【字幕：旅客】';
  accepted(content);
  const table = scriptStructureTable({episodes:[{number:1,content}]} as any,null,[1]);
  assert.equal(table.rows[0][4],'BODY_GROUP');
  for (const type of ['ACTION','DIALOGUE','CREATIVE_GUIDANCE'] as const) assert.throws(()=>applyScriptResolutions(content,'mixed',[
    {startLine:1,endLine:1,type,...(type==='DIALOGUE'?{speaker:'林岚',channel:'OS' as const}:{})}
  ]));
});

test('quoted caption literals remain spoken and unsupported or ambiguous mixed forms stay blocked', () => {
  const literal='他说“【字幕：到了】”，记住了吗？';
  const {source,pkg} = accepted(`林岚：${literal}`);
  assert.equal(source.dialogue[0].quote,literal);
  assert.equal(source.onscreenTexts,undefined);
  assert.equal(pkg.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V1');
  for (const text of ['林岚：到了。【字幕：旅客】顾辰：收到。','林岚：到了。【字幕：】','林岚：到了。【字幕：未闭合','林岚：到了。【字幕：外【内】】','林岚：到了。【字幕：跨\n行】','林岚：【字幕：只有字幕】','林岚：到了。[SUBTITLE:Arrival]','林岚：到了。【字幕 : 旅客】']) {
    const prepared=prepareStandardEpisode(text,'mixed');
    assert.equal(prepared.compiled,null,text);
    assert.ok(prepared.diagnostics.length,text);
  }
});
