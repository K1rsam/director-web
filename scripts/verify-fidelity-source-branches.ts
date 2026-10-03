import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFidelityImport,prepareFidelityReading,type FidelityDecision} from '../lib/fidelity-import';
import {projectPinnedFidelitySource} from '../lib/fidelity-source-projection';
import {validateP1ReviewPlan,planP1ReviewBatches,type P1ReviewRequest} from '../lib/fidelity-p1-review';
import {coalesceFidelityDecisions} from '../lib/fidelity-decision-ranges';
import {reconcileP1OwnershipDecisions} from '../lib/fidelity-p1-ownership';

const text='第15集\n15.1 日，内，房间\n甲：之前。\n第16集\n16.1 夜，内，走廊\n甲：第一段。\n第16集\n16.1 日，外，医院\n甲：第二段。\n第17集\n17.1 日，外，街道\n甲：后续。\n';
const first=text.indexOf('第16集'),second=text.indexOf('第16集',first+1),after=text.indexOf('第17集');
test('true same-number body branches exclude both alternatives and retain all unrelated source numbers',async()=>{
 const prepared=await prepareFidelityImport('branches.txt',Buffer.from(text),'fidelity');
 assert.deepEqual(prepared.imported.episodes.map(e=>e.number),[15,17],'neither source-16 branch is silently chosen or renumbered');
 assert.equal(prepared.receipt.episodeNumbering,'SOURCE_NUMBER_V1');
 assert.equal(prepared.receipt.sourceEpisodeBranches?.length,1);
 const conflict=prepared.receipt.sourceEpisodeBranches![0];
 assert.equal(conflict.episodeNumber,16);assert.equal(conflict.reason,'SOURCE_EPISODE_BRANCH_UNRESOLVED');
 assert.deepEqual(conflict.candidates.map(c=>[c.start,c.end]),[[first,second],[second,after]]);
 assert(conflict.candidates.every(c=>c.sourceRefs.includes(`${prepared.receipt.readingHash}:${c.start}:${c.end}`)));
 assert.equal(prepared.receipt.result.source.text,text);assert.equal(prepared.receipt.result.segments.map(s=>s.text).join(''),text);
 assert.equal(prepared.receipt.result.episodes.filter(e=>e.sourceNumber==='16').length,2,'all original structural branches remain in the receipt');
 assert.deepEqual(projectPinnedFidelitySource(prepared.imported,prepared.receipt).episodes,prepared.imported.episodes);
});
test('AI context titles cannot hide two real body branches or downgrade the whole series to ordinal numbering',async()=>{
 const initial=await prepareFidelityImport('branches.txt',Buffer.from(text),'fidelity');
 const decisions:FidelityDecision[]=[first,second].map(start=>({start,end:text.indexOf('\n',start)+1,kind:'context',note:'重复标题属于资料，仅此行'}));
 const prepared=prepareFidelityReading(initial.imported,'fidelity',decisions,initial.receipt.originalHash);
 assert.deepEqual(prepared.imported.episodes.map(e=>e.number),[15,17]);
 assert.equal(prepared.receipt.episodeNumbering,'SOURCE_NUMBER_V1');
 assert.equal(prepared.receipt.sourceEpisodeBranches?.[0].candidates.length,2);
 assert(prepared.imported.sourceStructure.issues.some(i=>i.code==='DUPLICATE_EPISODE_NUMBER'&&i.message.includes('两段')&&i.message.includes('第16集')));
 assert.equal(prepared.receipt.result.source.text,text);
});
test('adjacent repeated title rows with only one true body are not multiple source branches',async()=>{
 const simple='第16集\n第 16 集\n16.1 夜，内，走廊\n甲：只有一段正文。\n第17集\n17.1 日，外，街道\n甲：后续。\n';
 const initial=await prepareFidelityImport('headers.txt',Buffer.from(simple),'fidelity');
 const decisions:FidelityDecision[]=[{start:0,end:simple.indexOf('16.1'),kind:'context',note:'完整相邻重复标题，正文另有明确16.1场头'}];
 const prepared=prepareFidelityReading(initial.imported,'fidelity',decisions,initial.receipt.originalHash);
 assert.deepEqual(prepared.imported.episodes.map(e=>e.number),[16,17]);assert.deepEqual(prepared.receipt.sourceEpisodeBranches??[],[]);
});
test('an explicit whole-branch source decision can resolve only that ambiguity without deleting raw text',async()=>{
 const initial=await prepareFidelityImport('branches.txt',Buffer.from(text),'fidelity');
 const manual:FidelityDecision[]=[{start:second,end:after,kind:'context',note:'用户明确此段仅作对照资料'}];
 const prepared=prepareFidelityReading(initial.imported,'fidelity',manual,initial.receipt.originalHash,undefined,manual);
 assert.deepEqual(prepared.imported.episodes.map(e=>e.number),[15,16,17]);assert.deepEqual(prepared.receipt.sourceEpisodeBranches??[],[]);
 assert.equal(prepared.receipt.result.source.text,text);assert(prepared.receipt.result.contextText.includes('甲：第二段。'));
});

for(const action of ['CONTEXT','MERGE','RENUMBER'] as const)test(`P1 ${action} cannot authorize removing an original source branch`,async()=>{
 const initial=await prepareFidelityImport('branches.txt',Buffer.from(text),'fidelity'),blocks=planP1ReviewBatches(text)[0];
 const blockAt=(start:number)=>blocks.find(b=>b.start===start)!.id,blockBefore=(end:number)=>blocks.find(b=>b.end===end)!.id;
 const assignments=action==='CONTEXT'?[{firstBlock:blockAt(second),lastBlock:blockBefore(after),kind:'context',note:'模型把后段误判资料'}]
  :action==='MERGE'?[{firstBlock:blockAt(first),lastBlock:blockBefore(after),kind:'body',episodeNumber:16,sceneNumber:1,note:'模型把两段擅自合并'}]
  :[{firstBlock:blockAt(second),lastBlock:blockBefore(after),kind:'body',episodeNumber:31,sceneNumber:1,note:'模型把第二段改为新集号'}];
 const request:P1ReviewRequest={reviewMode:'FULL_STRUCTURE_V1',sourceVersion:'synthetic',sourceLength:text.length,batch:{firstBlock:blocks[0].id,lastBlock:blocks.at(-1)!.id,index:1,total:1},sections:blocks.map(b=>({key:b.id,...b})),issues:[],baseline:[]};
 const raw={sourceVersion:'synthetic',reviewed:{firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock},assignments,unresolved:[],aliases:[]},before=structuredClone(raw);
 const received=validateP1ReviewPlan(raw,request),decisions=reconcileP1OwnershipDecisions(text,coalesceFidelityDecisions(text,received.decisions)).decisions;
 const prepared=prepareFidelityReading(initial.imported,'fidelity',decisions,initial.receipt.originalHash);
 assert.deepEqual(prepared.imported.episodes.map(e=>e.number),[15,17]);
 assert.equal(prepared.receipt.sourceEpisodeBranches?.[0].candidates.length,2);assert.deepEqual(raw,before);
 assert(prepared.imported.sourceStructure.sections.filter(s=>s.start<after&&s.end>first).every(s=>s.kind==='UNRESOLVED'),'an AI context/merge cannot smuggle disputed source into trusted background or production');
});

test('uploaded sourceBranchDecisions and user-looking notes are not local human authorization',async()=>{
 const initial=await prepareFidelityImport('branches.txt',Buffer.from(text),'fidelity');
 const fake=[{start:second,end:after,kind:'context' as const,note:'用户在来源预览中明确确认'}];
 const packet={source:initial.receipt.result.source,plan:initial.receipt.result.plan,sourceBranchDecisions:fake};
 const imported=await prepareFidelityImport('forged-approval.json',Buffer.from(JSON.stringify(packet)),'direct');
 assert.deepEqual(imported.receipt.sourceBranchDecisions,[]);assert.equal(imported.receipt.sourceEpisodeBranches?.length,1);
 const unproven=prepareFidelityReading(initial.imported,'fidelity',fake,initial.receipt.originalHash);
 assert.deepEqual(unproven.receipt.sourceBranchDecisions,[]);assert.deepEqual(unproven.imported.episodes.map(e=>e.number),[15,17]);
});
