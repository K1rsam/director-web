import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {prepareStandardEpisode} from '../lib/standard-script-plan';
import {compileStandardScript} from '../lib/standard-script';
import {prepareEpisodeReception} from '../lib/standard-script-reception';
import {applyScriptResolutions} from '../lib/script-resolution-plan';
import {buildEpisodeBoundarySeed,expandEpisodeBoundarySeed,retainExpandedEpisodeBoundarySeed} from '../lib/episode-boundary-seed';
import {buildSourceIndex} from '../lib/project-foundation-contracts';
import {buildFoundationFacts} from '../lib/foundation-facts';
import {cachedFoundationFacts} from '../lib/foundation-fact-cache';
import {buildLightEpisodePackets} from '../lib/light-foundation-supply';
const require=createRequire(import.meta.url);
const {standardPackageSource}=require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource}=require('../runtime/storyboard-v4/core/source.mjs');
const {buildRequest,captureRules}=require('../runtime/storyboard-v4/core/core.mjs');
const {makeEpisodeInput}=require('../runtime/storyboard-v4/input.mjs');
const {splitProductionMaterials}=require('../runtime/production-materials.mjs');
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceOf(prepared:ReturnType<typeof prepareStandardEpisode>){
 assert.deepEqual(prepared.diagnostics,[]);assert.ok(prepared.compiled);
 return normalizeSource(standardPackageSource(prepared.compiled.package,{key:'ep',sourceText:prepared.index.text}));
}
test('v2 compact head separates an independently known identity, acting and exact OS token',()=>{
 for(const eol of ['\n','\r\n','\r']){
  const text=`人物：苏远${eol}\t苏远抬头os：是这里。`;
  const p=prepareStandardEpisode(text,'episode-1'),s=sourceOf(p),voice=s.dialogue[0];
  assert.equal(voice.speaker,'苏远');assert.equal(voice.channel,'OS');assert.equal(voice.cue,'os；抬头');assert.equal(voice.quote,'是这里。');
  assert.equal(p.plan.schemaVersion,'STANDARD_SCRIPT_PLAN_V5');
  const entry=p.compiled!.package.script.entries.at(-1)!;
  assert.equal(entry.speaker!.parts.map(p=>text.slice(p.start,p.end)).join(''),'苏远');
  assert.equal(entry.cue!.parts.map(p=>text.slice(p.start,p.end)).join(''),'抬头');
  assert.equal(entry.channelSource!.parts.map(p=>text.slice(p.start,p.end)).join(''),'os');
 }
 for(const [text,knownSpeakers] of [['苏远抬头VO：是这里。',['苏远']],['苏远：快看。\n苏远抬头os：是这里。',[]]] as const){
  const s=sourceOf(prepareStandardEpisode(text,'episode-1',{knownSpeakers:[...knownSpeakers]}));
  assert.equal(s.dialogue.at(-1).speaker,'苏远');assert.match(s.dialogue.at(-1).cue,/抬头/);
 }
});
test('v2 never shortens an unknown or explicitly complete character name, or turns a note into a speaker',()=>{
 for(const [text,knownSpeakers,name] of [
  ['苏远抬头os：这里。',[],'苏远抬头'],
  ['人物：苏远、苏远抬头\n苏远抬头os：这里。',[],'苏远抬头'],
  ['欧阳苏远抬头os：这里。',['苏远'],'欧阳苏远抬头'],
  ['人物：苏远\n苏远安排工作os：这里。',[],'苏远安排工作'],
 ] as const){
  const s=sourceOf(prepareStandardEpisode(text,'episode-1',{knownSpeakers:[...knownSpeakers]}));
  assert.equal(s.dialogue[0].speaker,name);assert.equal(s.dialogue[0].cue,'os');
 }
 for(const knownSpeakers of [[],['导演备注']]){
  const note=prepareStandardEpisode('导演备注抬头os：先看表情。','episode-1',{knownSpeakers});
  assert.ok(!note.compiled,'a director note with OS and acting still lacks speaker identity');assert.ok(note.diagnostics.some(d=>d.code==='UNKNOWN_COLON_LINE'));
 }
});
test('v2 inline expression has exact source ranges and its UTF16 position in actual downstream input',()=>{
 const text='苏远：哦😀（恍然大悟的样子）是这里。【字幕：地下室】';
 const episode={id:'ep',projectId:'p',number:1,title:'第1集',content:text};
 const reception=prepareEpisodeReception(episode,null);
 assert.equal(reception.standardScript!.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V5');
 const input=makeEpisodeInput({episode,project:{id:'p'},inputProtocol:'upstream-material-v2',handoff:{readiness:'READY',reasons:[],packet:{sourceText:text,...reception}}});
 assert.equal(input.source.dialogue[0].quote,'哦😀是这里。');assert.equal(input.source.onscreenTexts[0].text,'地下室');
 const cue=input.source.dialogue[0].performanceCues[0],row=input.source.sourceRows[0];
 assert.equal(cue.text,'恍然大悟的样子');assert.equal(cue.quoteOffset,3);
 assert.equal(cue.parts.map(([a,b]:number[])=>row.text.slice(a,b)).join(''),'恍然大悟的样子');
 assert.equal(cue.markerParts.map(([a,b]:number[])=>row.text.slice(a,b)).join(''),'（恍然大悟的样子）');
 const request=buildRequest({stage:'plan',source:input.source,settings:{maxUnits:null},rulesSnapshot:captureRules()});
 const model=JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1]);
 assert.equal(model.source.dialogue[0].quote,'哦😀是这里。');assert.equal(model.source.dialogue[0].performanceCues[0].text,'恍然大悟的样子');
});
test('v2 quoted, explanatory and unknown expression parentheses stay protected speech',()=>{
 for(const speech of ['哦（像猜到的样子）懂了。','他说“哦（恍然大悟的样子）懂了。”','这个叫（恍然大悟的样子），请念出来。','这（恍然大悟（点头）的样子）不能猜。']){
  const s=sourceOf(prepareStandardEpisode(`苏远：${speech}`,'episode-1'));
  assert.equal(s.dialogue[0].quote,speech);assert.equal(s.dialogue[0].performanceCues,undefined);
 }
});
test('frozen v1 plans and V1-V4 packages retain their exact identities, old quotes and request projection',()=>{
 const fixtures=[
  ['人物：苏远\n苏远抬头os：是这里。','V1','ed326bb9f57231459e44dcf8619abe0d86f28a742e0b10841cdad8dcfe34f811'],
  ['苏远：（OS抬头）是这里。','V2','b0aa9e80e73ff5008a7645adae9e35df35bbd52927d62516519eaf33b8b8ed23'],
  ['苏远：是这里。【字幕：地下室】','V3','e736f1c407b674d6cfba7c198f5265e151fc31d30f4adab481323fd4780f3d4f'],
  ['苏远：我（苦笑）还在，哦（恍然大悟的样子）懂了。','V4','ddd71681b3b8f81d42d640aba7031ddce29ad1e589987a3dcdc00b3e9aaf22b5'],
 ] as const;
 for(const [text,version,digest] of fixtures){
  const p=prepareStandardEpisode(text,'episode-1',{inlinePerformanceVersion:'inline-performance-v1'}),s=sourceOf(p);
  assert.equal(p.plan.schemaVersion,`STANDARD_SCRIPT_PLAN_${version}`);assert.equal(p.compiled!.package.packageId,`standard:${digest}`);
  assert.deepEqual(compileStandardScript(p.index,structuredClone(p.plan)).package,p.compiled!.package);
  assert.deepEqual(normalizeSource(structuredClone(s)),s);
  const frozen=prepareEpisodeReception({number:1,content:text},null,p,{inlinePerformanceVersion:'inline-performance-v1'});
  assert.deepEqual(frozen.standardScript,p.compiled!.package);
  const before=JSON.stringify(s),rules=captureRules();for(const flag of ['modelProjectionVersion','fantasyTimingVersion','visualSubjectsVersion'])delete rules[flag];
  const request=buildRequest({stage:'plan',source:s,settings:{maxUnits:null},rulesSnapshot:rules});
  const model=JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1]);
  assert.equal(model.source.dialogue.at(-1).speaker,version==='V1'?'苏远抬头':'苏远');
  if(version==='V4')assert.equal(model.source.dialogue[0].quote,'我还在，哦（恍然大悟的样子）懂了。');
  assert.equal(JSON.stringify(s),before);
 }
});
test('new and frozen tasks derive their requested grammar from saved decisions without editing either plan',()=>{
 const text='人物：苏远\n苏远抬头os：哦（恍然大悟的样子）是这里。',episode={number:1,content:text};
 const old=prepareStandardEpisode(text,'episode-1',{inlinePerformanceVersion:'inline-performance-v1'});
 const fresh=prepareStandardEpisode(text,'episode-1'),beforeOld=JSON.stringify(old),beforeFresh=JSON.stringify(fresh);
 const next=prepareEpisodeReception(episode,null,old,{inlinePerformanceVersion:'inline-performance-v2'});
 assert.deepEqual(next.standardScript,fresh.compiled!.package);
 const frozen=prepareEpisodeReception(episode,null,fresh,{inlinePerformanceVersion:'inline-performance-v1'});
 assert.deepEqual(frozen.standardScript,old.compiled!.package);
 const disabled=prepareEpisodeReception(episode,null,fresh,{inlinePerformance:false});
 assert.deepEqual(disabled.standardScript,prepareStandardEpisode(text,'episode-1',{inlinePerformance:false}).compiled!.package);
 assert.equal(JSON.stringify(old),beforeOld);assert.equal(JSON.stringify(fresh),beforeFresh);
 const custom=structuredClone(old);custom.plan.entries.at(-1)!.id='user-confirmed-voice';custom.compiled=compileStandardScript(custom.index,custom.plan);
 const reprojected=prepareEpisodeReception(episode,null,custom,{inlinePerformanceVersion:'inline-performance-v2'});
 assert.equal(reprojected.standardScript!.script.entries.at(-1)!.id,'user-confirmed-voice');
});
test('actual human speaker decisions stay source-bound across v2, v1 and disabled delivery',()=>{
 const text='人物：苏远\n苏远抬头os：是这里。',episode={number:1,content:text};
 const confirmed=applyScriptResolutions(text,'episode-1',[{id:'user-speaker',startLine:2,endLine:2,type:'DIALOGUE',speaker:'苏远抬头',channel:'OS'}]);
 assert.equal(confirmed.plan.schemaVersion,'STANDARD_SCRIPT_PLAN_V1');const before=JSON.stringify(confirmed);
 for(const options of [{inlinePerformanceVersion:'inline-performance-v2'},{inlinePerformanceVersion:'inline-performance-v1'},{inlinePerformance:false}] as const){
  const received=prepareEpisodeReception(episode,null,confirmed,options);
  assert.equal(received.standardScript!.script.entries.at(-1)!.speaker!.text,'苏远抬头');
  assert.deepEqual(received.standardScript,confirmed.compiled!.package);
 }
 assert.equal(JSON.stringify(confirmed),before);
 const automatic=prepareStandardEpisode(text,'episode-1',{inlinePerformanceVersion:'inline-performance-v1'});
 assert.equal(prepareEpisodeReception(episode,null,automatic,{inlinePerformanceVersion:'inline-performance-v2'}).standardScript!.script.entries.at(-1)!.speaker!.text,'苏远');
 const short=applyScriptResolutions(text,'episode-1',[{id:'confirmed-short',startLine:2,endLine:2,type:'DIALOGUE',speaker:'苏远',channel:'OS'}],['苏远']);
 assert.equal(short.plan.schemaVersion,'STANDARD_SCRIPT_PLAN_V5');
 for(const options of [{inlinePerformanceVersion:'inline-performance-v1'},{inlinePerformance:false}] as const)assert.equal(prepareEpisodeReception(episode,null,short,options).standardScript!.script.entries.at(-1)!.speaker!.text,'苏远');
});
test('fact cache distinguishes confirmed and automatic speaker interpretations even for identical plans',()=>{
 const text='人物：苏远\n苏远抬头os：是这里。',index=buildSourceIndex([{number:1,title:'第1集',content:text}]),context={version:'confirmed-cache',background:[]} as any;
 const automatic=prepareStandardEpisode(text,'episode-1',{inlinePerformanceVersion:'inline-performance-v1'});
 const confirmed=applyScriptResolutions(text,'episode-1',[{id:automatic.plan.entries.at(-1)!.id,startLine:2,endLine:2,type:'DIALOGUE',speaker:'苏远抬头',channel:'OS'}]);
 assert.deepEqual(confirmed.plan,automatic.plan);assert.deepEqual(confirmed.diagnostics,automatic.diagnostics);
 const options={standard:true,inlinePerformanceVersion:'inline-performance-v2'} as const;
 const autoFacts=cachedFoundationFacts(index,context,null,{...options,resolutions:{1:automatic}});
 const confirmedFacts=cachedFoundationFacts(index,context,null,{...options,resolutions:{1:confirmed}});
 assert.deepEqual(autoFacts.facts.at(-1)!.subjects,['苏远']);assert.deepEqual(confirmedFacts.facts.at(-1)!.subjects,['苏远抬头']);assert.notStrictEqual(autoFacts,confirmedFacts);
});
test('unknown speaker-decision sidecars never guess a new identity or mutate saved input',()=>{
 const text='人物：苏远\n苏远抬头os：是这里。',episode={number:1,content:text};
 const confirmed=applyScriptResolutions(text,'episode-1',[{id:'human',startLine:2,endLine:2,type:'DIALOGUE',speaker:'苏远抬头',channel:'OS'}]);
 const evidence=confirmed.speakerDecisions!;
 for(const speakerDecisions of [null,{version:'script-speaker-decisions-v99',entries:[]},{version:'script-speaker-decisions-v1',sourceVersion:'wrong',entries:[]},
  {...evidence,unknownMeaning:'keep'},{...evidence,entries:[{...evidence.entries[0],channel:'SPEECH'}]},
  {...evidence,entries:[{...evidence.entries[0],speaker:evidence.entries[0].speaker.map(p=>({...p,unknownMeaning:'keep'}))}]},
 ]){
  const saved={...prepareStandardEpisode(text,'episode-1',{inlinePerformanceVersion:'inline-performance-v1'}),speakerDecisions},before=JSON.stringify(saved);
  assert.throws(()=>prepareEpisodeReception(episode,null,saved as any),/SPEAKER_DECISIONS/);assert.equal(JSON.stringify(saved),before);
 }
});
test('frozen fact projection and its cache retain v1 subjects while fresh v2 uses the corrected speaker',()=>{
 const text='人物：苏远\n苏远抬头os：哦（恍然大悟的样子）是这里。';
 const index=buildSourceIndex([{number:1,title:'第1集',content:text}]),context={version:'context-fixture',background:[]} as any;
 const old=cachedFoundationFacts(index,context,null,{standard:true,inlinePerformanceVersion:'inline-performance-v1'});
 assert.deepEqual(old.facts.at(-1)!.subjects,['苏远抬头']);
 assert.equal(createHash('sha256').update(JSON.stringify(old)).digest('hex'),'5bd367de61d662c24d1511ba9cc4bbf654cf918a68414c408ebeba7d63768092');
 const fresh=cachedFoundationFacts(index,context,null,{standard:true,inlinePerformanceVersion:'inline-performance-v2'});
 assert.deepEqual(fresh.facts.at(-1)!.subjects,['苏远']);
 assert.notStrictEqual(fresh,old);
 assert.strictEqual(cachedFoundationFacts(index,context,null,{standard:true,inlinePerformanceVersion:'inline-performance-v1'}),old);
 assert.deepEqual(cachedFoundationFacts(index,context,null,{standard:true,inlinePerformance:false}).facts,old.facts);
});
test('saved resolutions use the requested grammar for facts without modifying saved decisions or source evidence',()=>{
 const text='人物：苏远\n苏远抬头os：哦（恍然大悟的样子）是这里。';
 const index=buildSourceIndex([{number:1,title:'第1集',content:text}]),context={version:'saved-facts-context',background:[]} as any;
 for(const [savedVersion,requested,subject] of [
  ['inline-performance-v1',{inlinePerformanceVersion:'inline-performance-v2'},'苏远'],
  ['inline-performance-v2',{inlinePerformanceVersion:'inline-performance-v1'},'苏远抬头'],
  ['inline-performance-v2',{inlinePerformance:false},'苏远抬头'],
 ] as const){
  const resolution=prepareStandardEpisode(text,'episode-1',{inlinePerformanceVersion:savedVersion}),before=JSON.stringify(resolution);
  const facts=buildFoundationFacts(index,context,null,{standard:true,resolutions:{1:resolution},...requested});
  assert.deepEqual(facts.facts.at(-1)!.subjects,[subject]);assert.equal(facts.facts.at(-1)!.statement,text.slice(text.indexOf('\n')+1));
  assert.deepEqual(facts,buildFoundationFacts(index,context,null,{standard:true,...requested}));
  assert.deepEqual(cachedFoundationFacts(index,context,null,{standard:true,resolutions:{1:resolution},...requested}),facts);
  assert.equal(JSON.stringify(resolution),before);
 }
});
test('light episode packets keep reception and facts aligned when saved resolutions cross grammar versions',async()=>{
 const text='人物：苏远\n苏远抬头os：哦（恍然大悟的样子）是这里。',episode={id:'ep',projectId:'p',number:1,title:'第1集',content:text};
 const index=buildSourceIndex([episode]),context={version:'packet-facts-context',background:[],notices:[]} as any;
 const document={revision:'fixture',sourceVersion:index.version,f2:null,editorialTodos:[]} as any;
 const db={episode:{findMany:async()=>[episode]},presentationContract:{findMany:async()=>[]},scriptScene:{findMany:async()=>[]}} as any;
 for(const [savedVersion,requested,subject] of [
  ['inline-performance-v1',{inlinePerformanceVersion:'inline-performance-v2'},'苏远'],
  ['inline-performance-v2',{inlinePerformanceVersion:'inline-performance-v1'},'苏远抬头'],
  ['inline-performance-v2',{inlinePerformance:false},'苏远抬头'],
 ] as const){
  const resolution=prepareStandardEpisode(text,'episode-1',{inlinePerformanceVersion:savedVersion}),before=JSON.stringify(resolution);
  const input={project:{id:'p',episodes:[episode]},sourceIndex:index,sourceContext:context,scriptResolutions:{1:resolution}} as any;
  const [packet]=await buildLightEpisodePackets('p',document,db,[1],input,requested);
  assert.equal(packet.standardScript!.script.entries.at(-1)!.speaker!.text,subject);
  assert.deepEqual(packet.facts.current.at(-1)!.subjects,[subject]);assert.equal(packet.sourceText,text);
  assert.equal(JSON.stringify(resolution),before);
 }
});
test('frozen boundary reception preserves complete source, context evidence and request identities',async()=>{
 const episodes=[{id:'ep1',projectId:'p',number:1,title:'第1集',content:'导演备注抬头os：先看表情。'},{id:'ep2',projectId:'p',number:2,title:'第2集',content:'人物：苏远\n苏远抬头os：是这里。'}];
 const index=buildSourceIndex(episodes),context={version:'frozen-boundary',background:[],notices:[]} as any;
 const document={revision:'fixture',sourceVersion:index.version,f2:null,editorialTodos:[]} as any;
 const db={episode:{findMany:async()=>episodes},presentationContract:{findMany:async()=>[]},scriptScene:{findMany:async()=>[]}} as any;
 const project={id:'p',episodes},rules=captureRules();for(const flag of ['modelProjectionVersion','fantasyTimingVersion','visualSubjectsVersion'])delete rules[flag];
 const inputOf=(packet:unknown)=>splitProductionMaterials(makeEpisodeInput({episode:episodes[1],project,handoff:{readiness:'READY',reasons:[],packet},inputProtocol:'upstream-material-v2'}));
 const requestOf=(input:any)=>buildRequest({stage:'plan',source:input.source,settings:{maxUnits:null},rulesSnapshot:rules});
 for(const options of [{inlinePerformanceVersion:'inline-performance-v1'},{inlinePerformance:false}] as const){
  const saved=Object.fromEntries(episodes.map(ep=>[ep.number,prepareStandardEpisode(ep.content,`episode-${ep.number}`,options)])),before=JSON.stringify(saved);
  const originalInput={project,sourceIndex:index,sourceContext:context,scriptResolutions:saved} as any;
  const [original]=await buildLightEpisodePackets('p',document,db,[2],originalInput,options);
  const [reloaded]=await buildLightEpisodePackets('p',document,db,[2],{...originalInput,scriptResolutions:undefined},options);
  const baseline=inputOf(original),current=inputOf(reloaded);
  assert.deepEqual(current.source,baseline.source);assert.equal(current.sourceVersion,baseline.sourceVersion);assert.equal(current.sourceBasisVersion,baseline.sourceBasisVersion);
  assert.deepEqual(current.contextEvidence,baseline.contextEvidence);assert.equal(digest(requestOf(current)),digest(requestOf(baseline)));assert.equal(JSON.stringify(saved),before);
  const expected=structuredClone(original.episodeBoundary);expected.previousSource!.selectionKind='FULL_EPISODE_EXPANSION';
  expected.unknowns.push('第1集已按完整原文节点补读，FULL_EPISODE_EXPANSION不是末场定位；故事直连、现实域及初态仍须据证判断。');
  const expanded=expandEpisodeBoundarySeed(reloaded.episodeBoundary,episodes[0].content,options);
  assert.deepEqual(expanded,expected);assert.deepEqual(retainExpandedEpisodeBoundarySeed(reloaded.episodeBoundary,expanded,options),expanded);
  const expandedInput=inputOf({...reloaded,episodeBoundary:expanded}),expectedInput=inputOf({...original,episodeBoundary:expected});
  assert.deepEqual(expandedInput.source,expectedInput.source);assert.deepEqual(expandedInput.contextEvidence,expectedInput.contextEvidence);assert.equal(digest(requestOf(expandedInput)),digest(requestOf(expectedInput)));
 }
});
test('new v2 boundary reads and expansions use corrected grammar while leaving existing seeds unchanged',()=>{
 const previous='导演备注抬头os：先看表情。',index=buildSourceIndex([{number:1,title:'第1集',content:previous},{number:2,title:'第2集',content:'苏远：走。'}]);
 const options={inlinePerformanceVersion:'inline-performance-v2'} as const,seed=buildEpisodeBoundarySeed(index,[],2,options),before=JSON.stringify(seed);
 assert.equal(seed.previousSource!.nodes[0].target,'UNRESOLVED');
 const expanded=expandEpisodeBoundarySeed(seed,previous,options);assert.equal(expanded.previousSource!.nodes[0].target,'UNRESOLVED');
 assert.deepEqual(retainExpandedEpisodeBoundarySeed(seed,expanded,options),expanded);assert.equal(JSON.stringify(seed),before);
 for(const inlinePerformanceVersion of [null,'inline-performance-v99']){
  const invalid={inlinePerformanceVersion} as any;
  assert.throws(()=>buildEpisodeBoundarySeed(index,[],2,invalid),/UNSUPPORTED_PERFORMANCE_VERSION/);
  assert.throws(()=>expandEpisodeBoundarySeed(expanded,previous,invalid),/UNSUPPORTED_PERFORMANCE_VERSION/);
  assert.throws(()=>retainExpandedEpisodeBoundarySeed(seed,null,invalid),/UNSUPPORTED_PERFORMANCE_VERSION/);
 }
});
test('fact cache rejects explicit null and unknown versions before a default cache hit or saved-resolution bypass',()=>{
 const text='人物：苏远\n苏远抬头os：是这里。',index=buildSourceIndex([{number:1,title:'第1集',content:text}]);
 const context={version:'cache-hit-context',background:[]} as any,resolutions={1:prepareStandardEpisode(text,'episode-1')};
 for(const saved of [undefined,resolutions]){
  const options={standard:true,resolutions:saved};
  const warm=cachedFoundationFacts(index,context,null,options);assert.strictEqual(cachedFoundationFacts(index,context,null,options),warm);
  for(const inlinePerformanceVersion of [null,'inline-performance-v99'])assert.throws(()=>cachedFoundationFacts(index,context,null,{...options,inlinePerformanceVersion} as any),/UNSUPPORTED_PERFORMANCE_VERSION|Unsupported inline performance version/);
 }
});
test('saved unresolved reception rejects null and unknown versions before returning its diagnostics',()=>{
 const content='这不是角色：未决。',episode={number:1,content},resolution=prepareStandardEpisode(content,'episode-1');
 assert.equal(resolution.compiled,null);const before=JSON.stringify(resolution);
 for(const inlinePerformanceVersion of [null,'inline-performance-v99'])for(const inlinePerformance of [true,false]){
  assert.throws(()=>prepareEpisodeReception(episode,null,resolution,{inlinePerformanceVersion,inlinePerformance} as any),/UNSUPPORTED_PERFORMANCE_VERSION|Unsupported inline performance version/);
 }
 assert.equal(JSON.stringify(resolution),before);
});
test('compact head cues remain exact in dialogue groups and mixed captions',()=>{
 for(const body of ['苏远抬头os：这里。林岚：哦（恍然大悟的样子）懂了。','苏远抬头os：这里。【字幕：地下室】']){
  const s=sourceOf(prepareStandardEpisode(`人物：苏远、林岚\n${body}`,'episode-1'));
  assert.equal(s.dialogue[0].speaker,'苏远');assert.equal(s.dialogue[0].cue,'os；抬头');
  if(body.includes('林岚：'))assert.equal(s.dialogue[1].quote,'哦懂了。');else assert.equal(s.onscreenTexts[0].text,'地下室');
 }
});
test('unknown performance versions are rejected even when the source has no dialogue',()=>{
 for(const inlinePerformanceVersion of [null,'inline-performance-v99'])assert.throws(()=>prepareStandardEpisode('▲他转身。','episode-1',{inlinePerformanceVersion} as any),/UNSUPPORTED_PERFORMANCE_VERSION|Unsupported inline performance version/);
});
