import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {compileStandardScript,createSourceIndex} from '../lib/standard-script';

const require=createRequire(import.meta.url);
const {standardPackageSource}=require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource}=require('../runtime/storyboard-v4/core/source.mjs');
const VERSION='source-regroup-v1';
function fixture(eol='\n',head='林岚：',tail='程野抬手🙂。',prefix='先登记。',stage='△清单推来。'){
 const text=`${head}${prefix}别只拆完${stage}便算完成。${eol}${tail}${eol}`;
 const index=createSourceIndex(text,'synthetic-regroup');
 const slice=(start:number,end:number)=>index.units.flatMap(unit=>{
  const a=Math.max(start,unit.start),b=Math.min(end,unit.end);
  return a<b?[{kind:/^[\t \r\n]+$/.test(text.slice(a,b))?'SOURCE_SEPARATOR':'SOURCE_SLICE',unitId:unit.id,start:a,end:b}]:[];
 });
 const actionStart=text.indexOf('△'),actionEnd=text.indexOf('便算'),tailStart=index.units[1].start,tailEnd=index.units[1].end-eol.length;
 const bodyStart=head.length,speakerEnd=head.indexOf('（')<0?head.indexOf('：'):head.indexOf('（');
 const voice:any={id:'voice',kind:'DIALOGUE',parts:[...slice(bodyStart,actionStart),...slice(actionEnd,index.units[0].end-eol.length)],layout:[],speaker:slice(0,speakerEnd),channel:'SPEECH',cue:null,channelSource:null};
 const cue=/（([^）]+)）/.exec(head);
 if(cue){voice.cue=slice(cue.index+1,cue.index+1+cue[1].length);}
 const action={id:'stage',kind:'ACTION',parts:[...slice(actionStart,actionEnd),...slice(tailStart,tailEnd)],layout:[]};
 const fields=[...voice.parts,...voice.speaker,...(voice.cue??[]),...action.parts].sort((a:any,b:any)=>a.start-b.start);
 let cursor=0;const layout:any[]=[];
 for(const field of fields){if(cursor<field.start)layout.push(...slice(cursor,field.start));cursor=field.end;}
 if(cursor<text.length)layout.push(...slice(cursor,text.length));
 const entry:any={id:'regroup',target:'BODY',kind:'SOURCE_REGROUP',sourceRegroupVersion:VERSION,unitIds:index.units.map(unit=>unit.id),parts:slice(0,text.length),layout,children:[voice,action],
  approval:{origin:'SESSION',ref:'synthetic-approval-1',explanation:'核对源文中的交错对白和动作，保留原件及对照。',actorId:'synthetic-reviewer',approvedAt:'2026-10-21T00:00:00.000Z'}};
 const plan:any={schemaVersion:'STANDARD_SCRIPT_PLAN_V6',sourceId:index.sourceId,sourceVersion:index.sourceVersion,entries:[entry]};
 return {text,index,plan,entry,slice,voice,action};
}
const compile=(value:ReturnType<typeof fixture>)=>compileStandardScript(value.index,value.plan);
test('shared regroup validator preserves explicit typed source slices',async()=>{
 assert.ok(existsSync('runtime/source-regroup.mjs'),'shared source regroup validator is required');
 const shared:any=await import('../runtime/source-regroup.mjs' as string),value=fixture('\r\n');
 const compiled=shared.compileSourceRegroup(value.index,value.entry);
 assert.equal(compiled.children[0].text,'先登记。别只拆完便算完成。');
 assert.equal(compiled.children[1].text,'△清单推来。程野抬手🙂。');
 assert.deepEqual(shared.sourceRegroupPlanFromCompiled(compiled),value.entry);
});
test('single physical-line selections preserve CRLF CR and emoji original UTF16 coordinates',async()=>{
 const shared:any=await import('../runtime/source-regroup.mjs' as string);
 assert.equal(typeof shared.selectSourceRegroupLineParts,'function');
 for(const eol of ['\n','\r\n','\r']){
  const text=`首行${eol}甲🙂乙${eol}`,index=createSourceIndex(text,'line-selection'),unit=index.units[1];
  const selected=shared.selectSourceRegroupLineParts(index,unit.id,1,3);
  assert.equal(selected.map((part:any)=>text.slice(part.start,part.end)).join(''),'🙂');assert.equal(selected[0].start,unit.start+1);
  assert.throws(()=>shared.selectSourceRegroupLineParts(index,unit.id,1,2));
  assert.throws(()=>shared.selectSourceRegroupLineParts(index,unit.id,3,unit.text.length));
 }
});
const receiver=(value:ReturnType<typeof fixture>,pkg:any,version:any=VERSION)=>normalizeSource(standardPackageSource(pkg,{key:'synthetic',sourceText:value.text,sourceRegroupVersion:version}));
function fingerprint(value:any){
 const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
 return createHash('sha256').update(JSON.stringify(canonical(value)),'utf16le').digest('hex');
}
function resign(pkg:any){
 const {packageId,...body}=pkg,{receipt,...fidelity}=body.fidelity;
 const digest=fingerprint({...body,fidelity});
 pkg.packageId=`standard:${digest}`;receipt.packageDigest=digest;
}
function resignedStage(stage:string){
 const masked=stage.replace(/[:：]/gu,'·'),value=fixture('\n','林岚：','程野抬手🙂。','先登记。',stage),safe=fixture('\n','林岚：','程野抬手🙂。','先登记。',masked);
 // Equal-width source masking keeps every covered UTF16 slice intact; runtime must validate the restored source independently.
 const restore=(item:any):any=>typeof item==='string'?item.replaceAll(safe.index.sourceVersion,value.index.sourceVersion).replaceAll(masked,stage):Array.isArray(item)?item.map(restore):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).map(([key,part])=>[key,restore(part)])):item;
 const pkg=restore(compile(safe).package);
 Object.assign(pkg.binding,{sourceIndexDigest:fingerprint(value.index),planDigest:fingerprint(value.plan)});Object.assign(pkg.fidelity.receipt,pkg.binding);resign(pkg);
 return {value,pkg};
}
test('explicit V6 preserves interleaved source and delivers independent canonical dialogue and action',()=>{
 for(const eol of ['\n','\r\n','\r']){
  const value=fixture(eol);let compiled:ReturnType<typeof compile>|undefined;
  assert.doesNotThrow(()=>{compiled=compile(value);},'V6 source regroup must compile without altering source');
  assert.ok(compiled);assert.equal(compiled.package.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V6');
  assert.equal(compiled.receipt.semantic,'NOT_RUN');assert.equal(compiled.receipt.acceptedForDispatch,false);
  assert.equal(compiled.package.evidence.map(unit=>unit.text).join(''),value.text);
  const source=receiver(value,compiled.package);
  assert.deepEqual(source.dialogue.map((voice:any)=>[voice.speaker,voice.quote,voice.channel]),[['林岚','先登记。别只拆完便算完成。','现场对白']]);
  const action=source.sourceRows.find((row:any)=>row.standard?.regroup?.childId==='stage');assert.ok(action);
  assert.equal(action.kind,'action');assert.equal(action.text,'△清单推来。程野抬手🙂。');
  assert.equal(source.sourceRows.filter((row:any)=>row.standard?.regroup).length,2);
  assert.equal(source.contextRows.find((row:any)=>row.standard?.kind==='SOURCE_REGROUP_ORIGINAL')?.text,value.text);
  assert.deepEqual(action.standard.regroup.originalSourceParts.body,value.action.parts);
  assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(source))),source);
 }
});
test('V6 is frozen behind an explicit new-task source regroup capability',()=>{
 const value=fixture(),compiled=compile(value);
 for(const version of [undefined,false,'source-regroup-v0'])assert.throws(()=>normalizeSource(standardPackageSource(compiled.package,{key:'synthetic',sourceText:value.text,sourceRegroupVersion:version})),/REGROUP|重组/);
});
test('V1 through V5 cannot smuggle SOURCE_REGROUP or widen BODY_GROUP',()=>{
 for(const version of [1,2,3,4,5]){
  const value=fixture();value.plan.schemaVersion=`STANDARD_SCRIPT_PLAN_V${version}`;
  assert.throws(()=>compile(value),/SCHEMA|REGROUP|UNKNOWN_FIELD/);
 }
 const value=fixture();value.entry.kind='BODY_GROUP';value.plan.schemaVersion='STANDARD_SCRIPT_PLAN_V3';
 assert.throws(()=>compile(value));
});
for(const [name,mutate] of [
 ['literal insertion',(v:any)=>{v.voice.literal='新增正文';}],
 ['empty body',(v:any)=>{v.voice.parts=[];}],
 ['overlap',(v:any)=>{v.action.parts[0].start--;}],
 ['omission',(v:any)=>{v.action.parts[1].end--;}],
 ['out of order',(v:any)=>{v.voice.parts.reverse();}],
 ['swapped children',(v:any)=>{v.entry.children.reverse();}],
 ['hidden body as layout',(v:any)=>{v.entry.layout.push(v.voice.parts.pop());}],
 ['surrogate cut',(v:any)=>{v.action.parts[1].end-=2;}],
 ['forged speaker',(v:any)=>{v.voice.speaker[0].end--;}],
 ['unsupported channel',(v:any)=>{v.voice.channel='VOICE';}],
 ['source channel mismatch',(v:any)=>{v.voice.channel='VO';}],
 ['missing approval',(v:any)=>{delete v.entry.approval;}],
 ['empty approval ref',(v:any)=>{v.entry.approval.ref='';}],
 ['client pass flag',(v:any)=>{v.entry.approval.accepted=true;}],
] as Array<[string,(value:any)=>void]>)test(`regroup rejects ${name}`,()=>{
 const value=fixture();mutate(value);
 assert.throws(()=>compile(value),(error:any)=>/^SOURCE_REGROUP_/.test(error.code),'must fail the specific regroup contract');
});
test('a regroup cannot consume source structure or cross a scene boundary',()=>{
 const value=fixture(),extra='2-1 夜 外 山口\n';
 value.text+=extra;value.index=createSourceIndex(value.text,'synthetic-regroup');
 const unit=value.index.units.at(-1)!;
 // Rebind the same source slices so the failure concerns structure, not a stale source version.
 const old=value.plan.sourceVersion;value.plan.sourceVersion=value.index.sourceVersion;
 for(const part of [value.entry.parts,value.entry.layout,value.voice.parts,value.voice.speaker,value.action.parts].flat())part.unitId=part.unitId.replace(old,value.index.sourceVersion);
 value.entry.unitIds=value.index.units.map(item=>item.id);
 const span={kind:'SOURCE_SLICE',unitId:unit.id,start:unit.start,end:unit.end};value.entry.parts.push(span);value.action.parts.push(span);
 assert.throws(()=>compile(value),(error:any)=>error.code==='SOURCE_REGROUP_STRUCTURE');
});
test('the independent receiver rejects rewritten canonical children even with a resigned receipt',()=>{
 const value=fixture(),compiled=compile(value);
 for(const mutate of [(pkg:any)=>{pkg.script.entries[0].children[0].text+='新增';},(pkg:any)=>{pkg.script.entries[0].children[0].channel='VO';},(pkg:any)=>{pkg.script.entries[0].children[1].textAssembly.parts.reverse();}]){
  const pkg=structuredClone(compiled.package);mutate(pkg);resign(pkg);assert.throws(()=>receiver(value,pkg),/REGROUP|重组/);
 }
});
test('regroup rejects an orphan closing quote instead of certifying malformed speech',()=>{
 assert.throws(()=>compile(fixture('\n','林岚：','程野抬手🙂。','先登记。”')),(error:any)=>error.code==='SOURCE_REGROUP_DIALOGUE');
});
test('regroup cannot hide another explicit physical source speaker inside action',()=>{
 assert.throws(()=>compile(fixture('\n','林岚：','顾宁：停。')),(error:any)=>error.code==='SOURCE_REGROUP_HEAD');
});
test('regroup does not downgrade an unquoted explicit onscreen caption to action',()=>{
 assert.throws(()=>compile(fixture('\n','林岚：','程野抬手🙂。','先登记。','△清单【字幕：稍后】推来。')),(error:any)=>error.code==='SOURCE_REGROUP_CAPTION');
 assert.throws(()=>compile(fixture('\n','林岚：','程野抬手🙂。','先登记【字幕：稍后】。')),(error:any)=>error.code==='SOURCE_REGROUP_CAPTION');
});
for(const [name,stage,code] of [
 ['embedded speaker','△清单推来。顾宁：停。','SOURCE_REGROUP_HEAD'],
 ['embedded speaker with cue','△清单推来；顾宁（低声）：停。','SOURCE_REGROUP_HEAD'],
 ['speaker after action marker','△顾宁：停。','SOURCE_REGROUP_HEAD'],
 ['screen caption','△屏幕字幕：稍后。','SOURCE_REGROUP_CAPTION'],
 ['embedded screen text','△清单推来。屏幕文字：稍后。','SOURCE_REGROUP_CAPTION'],
] as const){
 test(`compiler rejects swallowed ${name}`,()=>{
  assert.throws(()=>compile(fixture('\n','林岚：','程野抬手🙂。','先登记。',stage)),(error:any)=>error.code===code);
 });
 test(`independent receiver rejects swallowed ${name} with a resigned receipt`,()=>{
  const {value,pkg}=resignedStage(stage);assert.throws(()=>receiver(value,pkg),(error:any)=>error.code===code);
 });
}
test('regroup preserves business property colons and quoted source labels',()=>{
 for(const value of [
  fixture('\n','林岚：','程野抬手🙂。','工种变更：先登记。'),
  fixture('\n','林岚：','程野抬手🙂。','先登记。','△清单推来。工种变更：登记。'),
  fixture('\n','林岚：','程野抬手🙂。','先登记。','△清单写着“顾宁：停。屏幕字幕：稍后。”。'),
  fixture('\n','Alice Smith：'),
 ])assert.doesNotThrow(()=>receiver(value,compile(value).package));
});
