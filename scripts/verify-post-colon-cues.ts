import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {compileStandardScript} from '../lib/standard-script';
import * as planner from '../lib/standard-script-plan';
import * as reception from '../lib/standard-script-reception';
import * as boundarySeed from '../lib/episode-boundary-seed';
import {applyScriptResolutions} from '../lib/script-resolution-plan';
import * as sourceContracts from '../lib/project-foundation-contracts';
import {buildFoundationFacts, selectFoundationFacts} from '../lib/foundation-facts';

const require=createRequire(import.meta.url);
const {standardPackageSource}=require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource}=require('../runtime/storyboard-v4/core/source.mjs');
const prepare=(text:string,postColonCue=true)=>planner.prepareStandardEpisode(text,'post-cue',{postColonCue});
const receive=(pkg:any,text:string)=>normalizeSource(standardPackageSource(pkg,{key:'ep',sourceText:text}));
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value)),'utf16le').digest('hex');
function resign(pkg:any){const {packageId,...payload}=pkg,{receipt,...fidelity}=payload.fidelity;const hash=fingerprint({...payload,fidelity});pkg.packageId=`standard:${hash}`;pkg.fidelity.receipt.packageDigest=hash;return pkg;}

for(const [head,cue,channel] of [
 ['林岚：（压住颤音）','压住颤音','SPEECH'],['林岚：(压住颤音)','压住颤音','SPEECH'],
 ['林岚（OS）：（低声）','低声','OS'],['林岚（vo）：(低声)','低声','VO'],
 ['林岚：（OS，低声）','低声','OS'],['林岚：(低声,vo)','低声','VO'],['林岚：（OS）',null,'OS']
] as const)test(`V2 post-colon cue and voice remain source bound: ${head}`,()=>{
 for(const eol of ['\n','\r\n','\r']){
  const text=`人物：林岚、程野${eol}${head}我不是来认输的。${eol}`,p=prepare(text);
  assert.deepEqual(p.diagnostics,[]);assert.ok(p.compiled);
  const line=p.compiled.package.script.entries.at(-1)!;
  assert.equal(line.text,'我不是来认输的。');assert.equal(line.cue?.text??null,cue);assert.equal(line.channel,channel);
  assert.equal(p.plan.schemaVersion,'STANDARD_SCRIPT_PLAN_V2');assert.equal(p.compiled.package.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V2');
  assert.equal((p.compiled.receipt.checks as any).postColonCues,'VERIFIED');
  assert.equal(p.index.units.map(u=>u.text).join(''),text);
  const source=receive(p.compiled.package,text);assert.equal(source.dialogue[0].quote,'我不是来认输的。');
  assert.equal(source.dialogue[0].channel,channel==='SPEECH'?'现场对白':channel);
  assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(source))),source);
 }
});

test('current named heads need no cast; legacy and ambiguous nested/duplicate/quoted content stay guarded',()=>{
 assert.equal(planner.prepareStandardEpisode('林岚：（低声）不能猜出说者。','old-post',{syntax:'legacy'}).compiled,null);
 assert.equal(prepare('林岚：（低声）原文明示说者。').compiled?.package.script.entries[0].speaker?.text,'林岚');
 assert.equal(prepare('未知标签：（低声）不能猜成说者。').compiled,null);
 assert.ok(prepare('林岚：（OS）明确声道能证明语法。').compiled);
 for(const line of [
  '林岚：（低声）（忍泪）我还在。','林岚（低声）：（忍泪）我还在。','林岚：（压住（明显）颤音）我还在。',
  '林岚：（低声)我还在。','林岚：（）我还在。','林岚：（乙：别走）我还在。','林岚：（“别走”）我还在。',
  '林岚：（OS，VO）我还在。','林岚（OS）：（OS）我还在。','林岚：（低声，OS，忍泪）我还在。',
  '林岚：（VO、轻声）我还在。','林岚：（OS/VO）我还在。'
 ]){const p=prepare(`人物：林岚\n${line}`);assert.equal(p.compiled,null,line);assert.ok(p.diagnostics.length,line);assert.equal(p.index.text,`人物：林岚\n${line}`);}
});

test('GROUP with post cues and manual neighboring classifications retain V2',()=>{
 const text='人物：林岚、程野\n林岚：（低声）你好。程野：（OS，忍泪）再见。\n';
 const p=prepare(text);assert.ok(p.compiled);assert.deepEqual(p.diagnostics,[]);
 const source=receive(p.compiled.package,text);assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.quote,d.channel]),[['林岚','你好。','现场对白'],['程野','再见。','OS']]);
 const raw='人物：林岚\n林岚：（压住颤音）我不是来认输的。\n导演处理：关注双手。';
 for(const decisions of [
  [{startLine:2,endLine:2,type:'DIALOGUE' as const,speaker:'林岚',channel:'SPEECH' as const}],
  [{startLine:3,endLine:3,type:'CREATIVE_GUIDANCE' as const}]
 ]){const result=applyScriptResolutions(raw,'manual-post',decisions);assert.ok(result.compiled);assert.equal(result.plan.schemaVersion,'STANDARD_SCRIPT_PLAN_V2');assert.equal(result.compiled.package.script.entries.find(e=>e.kind==='DIALOGUE')?.text,'我不是来认输的。');}
});

test('compiler and independent receiver reject changed cue/voice/version even after re-signing',()=>{
 const text='人物：林岚\n林岚：（OS，压住颤音）我不是来认输的。',p=prepare(text);assert.ok(p.compiled);
 for(const mutate of [(entry:any)=>{entry.channel='SPEECH';},(entry:any)=>{entry.cue[0].end++;},(entry:any)=>{entry.parts[0].start++;}]){
  const plan:any=structuredClone(p.plan);mutate(plan.entries.at(-1));assert.throws(()=>compileStandardScript(p.index,plan));
 }
 const downgraded=structuredClone(p.plan);downgraded.schemaVersion='STANDARD_SCRIPT_PLAN_V1';assert.throws(()=>compileStandardScript(p.index,downgraded),/SCHEMA/);
 for(const mutate of [
  (pkg:any)=>{pkg.script.entries.at(-1).channel='SPEECH';},
  (pkg:any)=>{pkg.script.entries.at(-1).cue.text='改写提示';},
  (pkg:any)=>{pkg.schemaVersion='DIRECTOR_STANDARD_SCRIPT_SLICE_V1';pkg.assemblerVersion='standard-script-compiler-v1';pkg.fidelity.receipt.schemaVersion='STANDARD_SCRIPT_MECHANICAL_RECEIPT_V1';pkg.fidelity.receipt.assemblerVersion='standard-script-compiler-v1';delete pkg.fidelity.receipt.checks.postColonCues;}
 ]){const pkg:any=structuredClone(p.compiled.package);mutate(pkg);assert.throws(()=>receive(resign(pkg),text),(e:any)=>e.code?.startsWith('STANDARD_'));}
});

test('single V2 post-cue entry cannot hide the next speaker inside its spoken body',()=>{
 const text='人物：林岚、程野\n林岚：（低声）你好。\n程野：再见。',p=prepare(text);assert.ok(p.compiled);
 const plan:any=structuredClone(p.plan),first=plan.entries[1],second=plan.entries[2];
 first.unitIds.push(...second.unitIds);first.parts.at(-1).end=p.index.units[1].end;
 first.parts.push({kind:'SOURCE_SLICE',unitId:p.index.units[2].id,start:p.index.units[2].start,end:p.index.units[2].end});
 first.layout=first.layout.filter((part:any)=>part.start<first.parts[0].start);plan.entries.pop();
 assert.throws(()=>compileStandardScript(p.index,plan),/HEAD|DIALOGUE|CUE|BOUNDARY/);
});

test('ordinary V1, frozen old literal syntax and existing GROUP V2 receipts stay fixed',()=>{
 const old=planner.prepareStandardEpisode('人物：林岚、程野\n林岚：（压住颤音）我不是来认输的。','old-v1',{postColonCue:false});assert.ok(old.compiled);
 assert.deepEqual([old.compiled.receipt.packageDigest,old.compiled.receipt.planDigest,old.compiled.receipt.readingTextDigest],[
  '1600282c94f10c3b12b6d33eee1d96522482285539948f36452f4e913e0a8239','64157e1715a586bb1500025c3153a7a765581c4d6f40745ff0a2c778a7c6c410','794db49e70e8e92ee73fd375de95cc00e95f3c61f7aca76e86c72ec8de359b0e']);
 assert.equal(receive(old.compiled.package,old.index.text).dialogue[0].quote,'（压住颤音）我不是来认输的。');
 const group=planner.prepareStandardEpisode('人物：甲、乙\n甲（低声）：甲句。乙（OS）：乙句。\n','old-group');assert.ok(group.compiled);
 assert.deepEqual([group.compiled.receipt.packageDigest,group.compiled.receipt.planDigest,group.compiled.receipt.readingTextDigest],[
  'c741ef5eab412367ea87d359d4294df09c40464b78c32411e5411ebed130967a','db9fce7ce4e76e35dedf412a7f935ba7d62f1c66fbffa2752cf12f5077349355','6b632d0565a812169ed3020cd3ed4cd88e82676287e8f799b8ee45b2dd52fdb4']);
 assert.equal(Object.hasOwn(group.compiled.receipt.checks,'postColonCues'),false);
});

test('old standard reader explicitly freezes reception and facts grammar; new default enables post cues',async()=>{
 const imports:any={
  './foundation-application-scope':{readApplicationScope:()=>({kind:'ALL'}),scopeApplies:()=>true},
  './foundation-choice-store':{loadFoundationChoices:async()=>({confirmed:[]})},'./foundation-facts':{selectFoundationFacts},
  './foundation-fact-cache':{cachedFoundationFacts:buildFoundationFacts},'./foundation-state':{foundationJson:(value:string)=>JSON.parse(value||'{}')},
  './foundation-source':{loadFoundationSourceContext:()=>{throw new Error('no production reads');}},
  './project-foundation-contracts':sourceContracts,'./standard-script-reception':reception,'./standard-script-plan':planner,'./episode-boundary-seed':boundarySeed,
  './foundation-production-contracts':{projectProductionCatalog:()=>({assets:[]}),assertUnresolvedSourceScopes:()=>{},unresolvedOwner:()=>'',unresolvedEpisodeScope:()=>[]},
  'node:crypto':require('node:crypto')
 };
 const module={exports:{} as any},output=ts.transpileModule(readFileSync('lib/light-foundation-supply.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(output,{module,exports:module.exports,require:(name:string)=>{if(!Object.hasOwn(imports,name))throw new Error(`unexpected dependency: ${name}`);return imports[name];},console});
 const build=async(content:string,protocol:string)=>{
  const episodes=[{number:1,title:null,content}],index=sourceContracts.buildSourceIndex(episodes),input={project:{id:'p',episodes},sourceIndex:index,sourceContext:{version:'ctx',background:[],notices:[]}};
  return (await module.exports.buildLightEpisodePackets('p',{sourceVersion:index.version,revision:1,f2:null,editorialTodos:[]},{scriptScene:{findMany:async()=>[]}},[1],input,{protocol}))[0];
 };
 const text='人物：林岚\n林岚：（压住颤音）我不是来认输的。';
 const old=await build(text,'standard-episode-v1'),current=await build(text,'upstream-material-v2');
 assert.equal(old.standardScript.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V1');assert.equal(old.standardScript.script.entries.at(-1).text,'（压住颤音）我不是来认输的。');
 assert.equal(current.standardScript.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V2');assert.equal(current.standardScript.script.entries.at(-1).cue.text,'压住颤音');
 const ambiguous='人物：林岚\n林岚：（低声）（忍泪）我还在。';
 const oldAmbiguous=await build(ambiguous,'standard-episode-v1'),newAmbiguous=await build(ambiguous,'upstream-material-v2');
 assert.equal(oldAmbiguous.scriptReception.ready,true);assert.equal(oldAmbiguous.facts.sourceFactIndex.at(-1).kind,'UTTERANCE');
 assert.equal(newAmbiguous.scriptReception.ready,false);assert.equal(newAmbiguous.facts.sourceFactIndex.at(-1).kind,'CONTEXT');
});
