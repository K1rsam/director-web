/** Pure in-memory frozen-v4 verification and v5 upgrade; no DB, provider or files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CONTRACT_VERSION,normalize,validatePlan} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import {CONTRACT_VERSION as V4_VERSION,normalize as normalizeV4,validatePlan as validateV4} from '../lib/fidelity-v4.mjs';
import {prepareFidelityImport,type FidelityResult} from '../lib/fidelity-import';

const text='第1集\r\n\r\n1.1 日，内，道观\r\n人物：甲、乙\r\n甲：逐字 😀 é。  \r\n\r\n1.2 夜，外，山门\r\n△乙停步。\r\n第2集\n2.1 晨，内，客厅\n乙：到了。\n';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
type FrozenPlan=Record<string,unknown>&{
 contractVersion:string;sourceVersion:string;decisionVersion:string;
 segments:Array<{start:number;end:number;kind:string;sceneId:string|null;speakerLabels:string[]}>;
 issues:Array<{code:string;message:string;start:number;end:number}>;
};
type Packet={source:FidelityResult['source'];plan:FrozenPlan};
const old=normalizeV4(text) as FidelityResult,current=normalize(text) as FidelityResult;
const packet:Packet={source:old.source,plan:old.plan as FrozenPlan};
const pristine=structuredClone(packet),oldBefore=structuredClone(old),bytes=Buffer.from(JSON.stringify(packet)),bytesBefore=Buffer.from(bytes);
const bindings=(result:FidelityResult)=>result.segments.map(row=>[row.start,row.end,row.text]);

test('frozen v4 retains comma-heading issues while the current contract recognizes the same exact source',()=>{
 assert.equal(V4_VERSION,'fidelity/4');assert.equal(CONTRACT_VERSION,'fidelity/6');
 assert.equal(old.contractVersion,V4_VERSION);assert.ok(old.validation.issues.some(issue=>issue.code==='SCENE_BOUNDARY_UNCONFIRMED'));
 assert.equal(current.validation.ok,true);assert.deepEqual(current.validation.issues,[]);
 assert.deepEqual(current.episodes.map(episode=>episode.scenes.length),[2,1]);
 assert.deepEqual(bindings(current),bindings(old));assert.deepEqual(current.source,old.source);
 assert.equal(current.source.coordinateSystem,'utf16');assert.equal(current.source.length,text.length);
 assert.notEqual(text.length,[...text].length,'fixture includes a surrogate pair, not only BMP characters');
 assert.equal(text.slice(text.indexOf('😀'),text.indexOf('😀')+2),'😀');
 assert.equal(current.source.sourceVersion,hash(text));assert.equal(current.segments.map(row=>row.text).join(''),text);
 assert.equal(validateV4(old.source,old.plan).ok,true);assert.equal(validatePlan(old.source,old.plan).ok,false);
});

test('a strictly valid v4 package upgrades automatically without changing source, UTF16 bindings or raw package bytes',async()=>{
 const upgraded=await prepareFidelityImport('comma-v4.json',bytes,'direct');
 assert.equal(upgraded.receipt.result.contractVersion,CONTRACT_VERSION);
 assert.equal(upgraded.receipt.result.plan.contractVersion,CONTRACT_VERSION);
 assert.deepEqual(upgraded.receipt.result.validation.issues,[]);
 assert.deepEqual(upgraded.receipt.result.source,pristine.source);
 assert.deepEqual(bindings(upgraded.receipt.result),bindings(old));
 assert.equal(upgraded.imported.sourceText,text);assert.equal(upgraded.receipt.result.segments.map(row=>row.text).join(''),text);
 assert.equal(upgraded.receipt.readingHash,hash(text));assert.equal(upgraded.receipt.originalHash,hash(bytes));
 assert.equal(upgraded.receipt.externalPackage?.hash,hash(bytes));
 assert.deepEqual(Buffer.from(upgraded.imported.originalFile!.base64,'base64'),bytes);
 assert.ok(upgraded.receipt.reader.warnings.some(warning=>warning.includes('已核验旧清洗包')));
 assert.deepEqual(packet,pristine);assert.deepEqual(old,oldBefore);assert.deepEqual(bytes,bytesBefore);
});

test('paired raw source bytes keep their own hash distinct from the legacy package hash',async()=>{
 const sourceBytes=Buffer.from(text),before=Buffer.from(sourceBytes);
 const upgraded=await prepareFidelityImport('paired-v4.json',bytes,'direct',[],false,{name:'original.txt',bytes:sourceBytes});
 assert.equal(upgraded.receipt.result.contractVersion,CONTRACT_VERSION);assert.equal(upgraded.receipt.result.source.text,text);
 assert.deepEqual(bindings(upgraded.receipt.result),bindings(old));
 assert.equal(upgraded.receipt.originalHash,hash(sourceBytes));assert.equal(upgraded.receipt.readingHash,hash(text));
 assert.equal(upgraded.receipt.externalPackage?.hash,hash(bytes));assert.notEqual(hash(bytes),hash(sourceBytes));
 assert.deepEqual(Buffer.from(upgraded.imported.originalFile!.base64,'base64'),sourceBytes);
 assert.deepEqual(sourceBytes,before);assert.deepEqual(bytes,bytesBefore);assert.deepEqual(packet,pristine);assert.deepEqual(old,oldBefore);
});

const tampering:Array<{name:string;mutate:(value:Packet)=>void}>=[
 {name:'removed old issues',mutate:value=>{value.plan.issues=[];}},
 {name:'changed old issue message',mutate:value=>{value.plan.issues[0].message='假称已解决';}},
 {name:'changed old issue coordinate',mutate:value=>{value.plan.issues[0].start++;}},
 {name:'changed segment kind',mutate:value=>{value.plan.segments[0].kind='body';}},
 {name:'changed segment coordinate',mutate:value=>{value.plan.segments[1].end++;}},
 {name:'forged segment scene',mutate:value=>{value.plan.segments[1].sceneId='forged-scene';}},
 {name:'forged speaker label',mutate:value=>{value.plan.segments[1].speakerLabels=['伪造人物'];}},
 {name:'changed source text',mutate:value=>{value.source.text=value.source.text.replace('逐字','改字');}},
 {name:'changed source UTF16 length',mutate:value=>{value.source.length++;}},
 {name:'changed coordinate system',mutate:value=>{value.source.coordinateSystem='codepoint';}},
 {name:'changed source hash',mutate:value=>{value.source.sourceVersion='0'.repeat(64);}},
 {name:'changed plan source hash',mutate:value=>{value.plan.sourceVersion='0'.repeat(64);}},
 {name:'changed decision hash',mutate:value=>{value.plan.decisionVersion='0'.repeat(64);}},
 {name:'v4 semantics relabeled as current version',mutate:value=>{value.plan.contractVersion=CONTRACT_VERSION;}},
 {name:'unknown contract version',mutate:value=>{value.plan.contractVersion='fidelity/999';}},
];
for(const {name,mutate} of tampering)test(`strict legacy import rejects ${name}`,async()=>{
 const bad=structuredClone(packet);mutate(bad);const before=structuredClone(bad),badBytes=Buffer.from(JSON.stringify(bad)),rawBefore=Buffer.from(badBytes);
 await assert.rejects(prepareFidelityImport('tampered-v4.json',badBytes,'direct'),/被修改|保真|来源文本与版本信息不一致/);
 assert.deepEqual(bad,before);assert.deepEqual(badBytes,rawBefore);assert.deepEqual(packet,pristine);assert.deepEqual(old,oldBefore);
});

test('the frozen v4 validator rejects current semantic bindings even when disguised with a v4 label',async()=>{
 assert.equal(validateV4(current.source,current.plan).ok,false);
 const disguised=structuredClone(current.plan) as FrozenPlan;disguised.contractVersion=V4_VERSION;
 const verdict=validateV4(current.source,disguised);
 assert.equal(verdict.ok,false);assert.ok(verdict.errors.some(error=>error.code==='SOURCE_BINDING_CHANGED'||error.code==='ISSUES_CHANGED'));
 await assert.rejects(prepareFidelityImport('disguised-v4.json',Buffer.from(JSON.stringify({source:current.source,plan:disguised})),'direct'),/被修改|保真/);
 assert.deepEqual(old,oldBefore);assert.deepEqual(packet,pristine);assert.deepEqual(bytes,bytesBefore);
});
