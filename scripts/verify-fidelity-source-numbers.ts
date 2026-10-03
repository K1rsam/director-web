import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertFidelityMaterialization,prepareFidelityReading,type FidelityDecision,type FidelityReceipt,type FidelityResult} from '../lib/fidelity-import';
import type {ImportedScript} from '../lib/import-script';
import {createSource,normalize} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function prepare(text:string,decisions:FidelityDecision[]=[]){
 const imported:ImportedScript={sourceName:'numbering-fixture.txt',sourceText:text,episodes:[],sourceStructure:{version:'SOURCE_STRUCTURE_V1',sections:[],issues:[]},readingView:{kind:'TEXT',view:'IN_MEMORY_TEXT',warnings:['保留既有读取提示']},originalFile:{encoding:'base64',mediaType:'text/plain',base64:Buffer.from(text).toString('base64')}};
 const before=structuredClone(imported),baseline=normalize(createSource(text),{decisions}) as FidelityResult;
 const prepared=prepareFidelityReading(imported,'fidelity',decisions,hash(text));
 assert.deepEqual(imported,before,'the caller input remains unchanged');
 assert.equal(prepared.imported.sourceText,text);assert.equal(prepared.receipt.readingHash,hash(text));assert.equal(prepared.receipt.originalHash,hash(text));
 assert.deepEqual(prepared.receipt.result.source,baseline.source);assert.deepEqual(prepared.receipt.result.plan,baseline.plan);
 assert.deepEqual(prepared.receipt.result.episodes,baseline.episodes,'receipt internal production ordinals remain unchanged');
 assert.deepEqual(prepared.receipt.result.segments,baseline.segments);assert.equal(prepared.receipt.result.normalizedText,baseline.normalizedText);
 assert.equal(prepared.receipt.result.segments.map(segment=>segment.text).join(''),text);
 assert.deepEqual(prepared.imported.originalFile,before.originalFile);assert.ok(prepared.receipt.reader.warnings.includes('保留既有读取提示'));
 assertFidelityMaterialization(prepared.imported,prepared.receipt);
 return prepared;
}

test('unconfirmed zero introduction cannot shift the first and second source episodes',()=>{
 const text='第0集\n作者自述。\n第一集：\n1-1 日 外\n甲：走。\n第二集：\n2-1 夜 内\n乙：好。\n';
 const prepared=prepare(text);
 assert.deepEqual(prepared.imported.episodes.map(episode=>episode.number),[1,2]);
 assert.equal(prepared.receipt.episodeNumbering,'SOURCE_NUMBER_V1');
 assert.deepEqual(prepared.receipt.result.episodes.map(episode=>episode.number),[1,2,3]);
 assert.ok(prepared.imported.sourceStructure.sections.some(section=>section.kind==='UNRESOLVED'&&text.slice(section.start,section.end).includes('作者自述。')));
});

test('all true duplicate branches retain source slices without selecting the first or shifting later source numbers',()=>{
 const text='第一集\n1-1 日 外\n甲：正稿。\n第一集\n1-1 日 外\n甲：异稿。\n第二集\n2-1 日 外\n乙：后续。\n';
 const prepared=prepare(text);
 assert.equal(prepared.receipt.episodeNumbering,'SOURCE_NUMBER_V1');assert.deepEqual(prepared.imported.episodes.map(episode=>episode.number),[2]);
 assert.ok(prepared.imported.sourceStructure.sections.some(section=>section.kind==='UNRESOLVED'&&text.slice(section.start,section.end).includes('异稿')));
});

test('source gaps and fragmented episode sections preserve their explicit number with unique keys',()=>{
 const text='第5集\n5-1 日 外\n甲：前段。\n单独保留的背景资料。\n甲：后段。\n第7集\n7-1 日 外\n乙：继续。\n';
 const start=text.indexOf('单独保留'),end=text.indexOf('甲：后段');
 const prepared=prepare(text,[{start,end,kind:'context',note:'明确只将这一行保留为资料'}]);
 assert.equal(prepared.receipt.episodeNumbering,'SOURCE_NUMBER_V1');assert.deepEqual(prepared.imported.episodes.map(episode=>episode.number),[5,7]);
 const sections=prepared.imported.sourceStructure.sections.filter(section=>section.kind==='EPISODE');
 assert.equal(sections.filter(section=>section.episodeNumber===5).length,2);
 assert.equal(new Set(sections.map(section=>section.key)).size,sections.length);
 for(const section of sections)assert.match(section.key,new RegExp(`^EPISODE-${section.episodeNumber}-`));
});

test('an explicit true zero decision retains source zero without changing receipt ordinals',()=>{
 const text='第0集\n0-1 日 外\n甲：序章剧情。\n第一集\n1-1 日 外\n乙：正篇。\n',end=text.indexOf('第一集');
 const prepared=prepare(text,[{start:0,end,kind:'body',episodeNumber:0,sceneNumber:1,note:'明确第0集为序章剧情'}]);
 assert.equal(prepared.receipt.episodeNumbering,'SOURCE_NUMBER_V1');assert.deepEqual(prepared.imported.episodes.map(episode=>episode.number),[0,1]);
 assert.deepEqual(prepared.receipt.result.episodes.map(episode=>episode.number),[1,2]);
 assert.ok(prepared.imported.sourceStructure.sections.some(section=>section.kind==='EPISODE'&&section.episodeNumber===0));
});

test('non-numeric prologue keeps the entire legacy production-order projection with a warning',()=>{
 const text='序章\n0-1 日 外\n甲：先前。\n第5集\n5-1 日 外\n乙：后续。\n';
 const prepared=prepare(text);
 assert.equal(prepared.receipt.episodeNumbering,'PRODUCTION_ORDER_V1');assert.deepEqual(prepared.imported.episodes.map(episode=>episode.number),[1,2]);
 assert.equal(prepared.imported.episodes.length,2);assert.ok(prepared.imported.episodes[0].content.startsWith('序章'));
 assert.ok(prepared.receipt.reader.warnings.some(warning=>/源集号/.test(warning)&&/生产顺序/.test(warning)));
 for(const section of prepared.imported.sourceStructure.sections.filter(section=>section.kind==='EPISODE'))assert.equal(section.key,prepared.receipt.result.segments.find(segment=>segment.start===section.start)!.id,'fallback preserves the original segment key');
});

test('distinct source labels resolving to the same number remain a source choice, never an ordinal renumbering',()=>{
 const text='第1集\n1-1 日 外\n甲：第一份。\n第一集\n1-1 日 外\n甲：第二份。\n第5集\n5-1 日 外\n乙：后续。\n';
 const prepared=prepare(text);
 assert.equal(prepared.receipt.episodeNumbering,'SOURCE_NUMBER_V1');assert.deepEqual(prepared.imported.episodes.map(episode=>episode.number),[5]);
 assert.equal(prepared.receipt.sourceEpisodeBranches?.[0].candidates.length,2);assert.ok(prepared.imported.sourceStructure.issues.some(issue=>issue.code==='DUPLICATE_EPISODE_NUMBER'));
});

test('unsafe source integers use one explicit fallback mode instead of rounding or partial mapping',()=>{
 const text='第9007199254740992集\n甲：超出安全编号。\n第7集\n7-1 日 外\n乙：继续。\n';
 const prepared=prepare(text);
 assert.equal(prepared.receipt.episodeNumbering,'PRODUCTION_ORDER_V1');assert.deepEqual(prepared.imported.episodes.map(episode=>episode.number),[1,2]);
 assert.ok(prepared.receipt.reader.warnings.some(warning=>/源集号/.test(warning)));
});

test('legacy receipts without a numbering marker retain validation compatibility',()=>{
 const prepared=prepare('第5集\n5-1 日 外\n甲：原话。\n第7集\n7-1 日 外\n乙：后话。\n');
 const legacyReceipt={...prepared.receipt};delete legacyReceipt.episodeNumbering;
 const legacyImported=structuredClone(prepared.imported),ordinals=new Map([[5,1],[7,2]]);
 legacyImported.episodes=legacyImported.episodes.map(episode=>({...episode,number:ordinals.get(episode.number)!}));
 legacyImported.sourceStructure.sections=legacyImported.sourceStructure.sections.map(section=>section.kind==='EPISODE'?{...section,episodeNumber:ordinals.get(section.episodeNumber!),key:prepared.receipt.result.segments.find(segment=>segment.start===section.start)!.id}:section);
 assert.doesNotThrow(()=>assertFidelityMaterialization(legacyImported,legacyReceipt));
});

test('numbering warnings do not accumulate and disappear when an explicit decision resolves source numbers',()=>{
 const text='序章\n0-1 日 外\n甲：先前。\n第5集\n5-1 日 外\n乙：后续。\n',first=prepare(text);
 const repeated=prepareFidelityReading(first.imported,'fidelity',[],hash(text));
 assert.equal(repeated.receipt.reader.warnings.filter(warning=>warning.includes('生产顺序')).length,1);
 const resolved=prepareFidelityReading(repeated.imported,'fidelity',[{start:0,end:text.indexOf('第5集'),kind:'body',episodeNumber:0,sceneNumber:1,note:'明确序章属于源第0集'}],hash(text));
 assert.equal(resolved.receipt.episodeNumbering,'SOURCE_NUMBER_V1');assert.deepEqual(resolved.imported.episodes.map(episode=>episode.number),[0,5]);
 assert.ok(!resolved.receipt.reader.warnings.some(warning=>warning.includes('生产顺序')));assert.ok(resolved.receipt.reader.warnings.includes('保留既有读取提示'));
});

test('an unknown numbering strategy cannot pass materialization validation',()=>{
 const prepared=prepare('第一集\n1-1 日 外\n甲：原话。\n');
 const receipt={...prepared.receipt,episodeNumbering:'UNKNOWN_NUMBERING'} as unknown as FidelityReceipt;
 assert.throws(()=>assertFidelityMaterialization(prepared.imported,receipt),/编号策略/);
});
