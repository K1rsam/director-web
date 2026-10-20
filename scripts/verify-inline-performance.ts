import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {prepareStandardEpisode} from '../lib/standard-script-plan';
import {prepareEpisodeReception} from '../lib/standard-script-reception';
const require=createRequire(import.meta.url);
const {makeEpisodeInput}=require('../runtime/storyboard-v4/input.mjs');
const {standardPackageSource}=require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource}=require('../runtime/storyboard-v4/core/source.mjs');
const {sliceSource,buildRequest,captureRules}=require('../runtime/storyboard-v4/core/core.mjs');
function accepted(text:string){
 const prepared=prepareStandardEpisode(text,'episode-1');
 assert.deepEqual(prepared.diagnostics,[]);assert.ok(prepared.compiled);
 const episode={id:'ep',projectId:'p',number:1,title:'第1集',content:text};
 const input=makeEpisodeInput({episode,project:{id:'p'},inputProtocol:'upstream-material-v2',handoff:{readiness:'READY',reasons:[],packet:{sourceText:text,...prepareEpisodeReception(episode,null)}}});
 return {prepared,pkg:prepared.compiled.package,source:input.source};
}
function resign(pkg:any){
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
 const {packageId,...rest}=pkg,{receipt,...fidelity}=rest.fidelity;
 const digest=createHash('sha256').update(JSON.stringify(canonical({...rest,fidelity})),'utf16le').digest('hex');pkg.packageId=`standard:${digest}`;receipt.packageDigest=digest;
}
test('clear inline acting cue is not spoken; original line and its exact location survive',()=>{
 const text='苏尘：咳咳，（掐着手指）我算算……';
 const {prepared,pkg,source}=accepted(text);
 assert.equal(source.dialogue[0].quote,'咳咳，我算算……');
 assert.equal(pkg.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V5');
 const row=source.sourceRows[0],cue=source.dialogue[0].performanceCues[0];
 assert.equal(row.text,text);assert.equal(cue.text,'掐着手指');assert.equal(cue.quoteOffset,3);
 assert.equal(cue.parts.map(([a,b]:number[])=>row.text.slice(a,b)).join(''),'掐着手指');
 assert.equal(cue.markerParts.map(([a,b]:number[])=>row.text.slice(a,b)).join(''),'（掐着手指）');
 assert.match(prepared.compiled!.readingText,/掐着手指/);assert.match(prepared.compiled!.readingText,/咳咳，我算算/);
 assert.deepEqual(normalizeSource(structuredClone(source)),source);
});
test('literal quoted, explanatory, nested or uncertain parentheses never lose source characters',()=>{
 for(const text of ['苏尘：他说“（掐着手指）”，但我没有。','苏尘：一万元（含税），够吗？','苏尘：你（不是他）答应过。','苏尘：公式（a+b）不能改。','苏尘：他说「（苦笑）」。','苏尘：他写【掐着手指（大笑）】。','苏尘：这叫（苦笑就是苦涩的笑），懂吗？','苏尘：这叫（苦笑），不是笑着哭。','苏尘：纸上写着（点头），懂吗？','苏尘：你把（摇头）这两个字读出来。','苏尘：先（掐着（右手）手指）再算。','苏尘：我（向甲解释）这件事。']){
  const {source,pkg}=accepted(text);assert.equal(source.dialogue[0].quote,text.slice(text.indexOf('：')+1),text);assert.equal(source.dialogue[0].performanceCues,undefined);assert.notEqual(pkg.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V5');
 }
});
test('multiple cues, CRLF, Unicode and multi-speaker groups keep cue owners and positions',()=>{
 for(const eol of ['\n','\r\n','\r']){
  const {source}=accepted(`苏尘（OS）：我😀（苦笑）还没${eol}（皱眉）算完。`);
  assert.equal(source.dialogue[0].quote,`我😀还没${eol}算完。`);assert.equal(source.dialogue[0].channel,'OS');
  assert.deepEqual(source.dialogue[0].performanceCues.map((c:any)=>[c.text,c.quoteOffset]),[['苦笑',3],['皱眉',5+eol.length]]);
 }
 const {source}=accepted('苏尘：好，（点头）我来。林岚：不，（摇头）我先。');
 assert.deepEqual(source.dialogue.map((q:any)=>[q.speaker,q.quote,q.performanceCues[0].text]),[['苏尘','好，我来。','点头'],['林岚','不，我先。','摇头']]);
});
test('captions and acting cues remain separate through slicing and actual model projections',()=>{
 const {source}=accepted('苏尘OS：我（苦笑）还在。【字幕：三年后】\n▲他转身。');
 assert.equal(source.dialogue[0].quote,'我还在。');assert.equal(source.onscreenTexts[0].text,'三年后');
 const local=sliceSource(source,[source.dialogue[0].rowId]);assert.equal(local.dialogue[0].performanceCues[0].text,'苦笑');
 const other=sliceSource(source,[source.sourceRows.at(-1).id]);assert.equal(other.dialogue.length,0);
 for(const production of [true,false]){
  const rules=captureRules();if(!production)delete rules.modelProjectionVersion;
  const request=buildRequest({stage:'plan',source,settings:{maxUnits:null},rulesSnapshot:rules});
  const model=JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1]);
  assert.equal(model.source.dialogue[0].quote,'我还在。');assert.equal(model.source.dialogue[0].performanceCues[0].text,'苦笑');assert.match(request.prompt,/performanceCues/);
 }
});
test('even a resigned package cannot change, omit or invent a delivery projection',()=>{
 const text='苏尘：咳咳，（掐着手指）我算算……',original=accepted(text);
 for(const mutate of [(p:any)=>{p.script.entries[0].performance.spoken.text='删了台词';},(p:any)=>{p.script.entries[0].performance.cues[0].spokenOffset++;},(p:any)=>{delete p.script.entries[0].performance;},(p:any)=>{p.script.entries[0].performance.cues[0].extra='hidden';}]){
  const pkg=structuredClone(original.pkg);mutate(pkg);resign(pkg);assert.throws(()=>standardPackageSource(pkg,{key:'ep',sourceText:text}),/PERFORMANCE|表演|发声/);
 }
 const bad=structuredClone(original.source);bad.dialogue[0].performanceCues=[];assert.throws(()=>normalizeSource(bad),(e:any)=>e.code==='STANDARD_DIALOGUE_BINDING');
});
test('frozen legacy standard packages keep literal old quotes',()=>{
 const p=prepareStandardEpisode('人物：苏尘\n苏尘：咳咳，（掐着手指）我算算……','old',{syntax:'legacy'});assert.ok(p.compiled);
 assert.equal(p.compiled.package.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V1');
 const source=normalizeSource(standardPackageSource(p.compiled.package,{key:'old',sourceText:p.index.text}));
 assert.equal(source.dialogue[0].quote,'咳咳，（掐着手指）我算算……');assert.equal(source.dialogue[0].performanceCues,undefined);
});
test('frozen current requests and saved parsing decisions retain literal old speech',()=>{
 const text='苏尘：咳咳，（掐着手指）我算算……',episode={number:1,content:text};
 const resolution=prepareStandardEpisode(text,'episode-1');
 assert.equal(resolution.plan.schemaVersion,'STANDARD_SCRIPT_PLAN_V5');
 const previous=prepareStandardEpisode(text,'episode-1',{inlinePerformance:false});
 const frozen=prepareEpisodeReception(episode,null,resolution,{inlinePerformance:false});
 assert.equal(frozen.scriptReception.ready,true);
 assert.deepEqual(frozen.standardScript,previous.compiled!.package);
 assert.equal(resolution.plan.schemaVersion,'STANDARD_SCRIPT_PLAN_V5','conversion never mutates the saved decision');
 const source=normalizeSource(standardPackageSource(frozen.standardScript,{key:'old',sourceText:text}));
 assert.equal(source.dialogue[0].quote,'咳咳，（掐着手指）我算算……');
 assert.equal(source.dialogue[0].performanceCues,undefined);
});
