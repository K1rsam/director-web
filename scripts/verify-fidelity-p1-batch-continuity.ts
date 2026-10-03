import test from 'node:test';
import assert from 'node:assert/strict';
import {coalesceFidelityDecisions} from '../lib/fidelity-decision-ranges';
import {reconcileP1BatchContinuityDecisions,type P1BatchContinuityInput} from '../lib/fidelity-p1-batch-continuity';
import {normalize} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import type {FidelityDecision,FidelityResult} from '../lib/fidelity-import';

const source='第24集\n24.3 夜 内 浴室\n甲：打开花洒。\n甲：同一浴室继续。\n';
const cut=source.indexOf('甲：同一浴室');
const pending:FidelityDecision[]=[
 {start:source.indexOf('24.3'),end:cut,kind:'body',episodeNumber:24,sceneNumber:4,note:'前批按明确场头顺序定位为内部第4场。'},
 {start:cut,end:source.length,kind:'body',episodeNumber:24,sceneNumber:3,note:'后批引用原稿24.3，续接同一浴室。'},
];
const input=():P1BatchContinuityInput=>({manualDecisions:[],pendingDecisions:structuredClone(pending),completedRanges:[{start:0,end:cut}],currentBatch:{start:cut,end:source.length}});
const reconcile=(text=source,options=input())=>reconcileP1BatchContinuityDecisions(text,options);
function unchanged(text:string,options:P1BatchContinuityInput,reason?:string,status?:'SKIPPED'|'UNRESOLVED'){
 const before=structuredClone(options),result=reconcile(text,options);
 assert.deepEqual(result.decisions,options.pendingDecisions);assert.deepEqual(result.corrections,[]);assert.deepEqual(options,before);
 if(reason)assert.ok(result.diagnostics.some(d=>d.reason===reason&&(!status||d.status===status)),JSON.stringify(result.diagnostics));
 return result;
}
function fixture(text:string,heading:string,cutAt:string){
 const start=text.indexOf(heading),boundary=text.indexOf(cutAt);
 return {manualDecisions:[],pendingDecisions:[{...pending[0],start,end:boundary},{...pending[1],start:boundary,end:text.length}],completedRanges:[{start:0,end:boundary}],currentBatch:{start:boundary,end:text.length}} satisfies P1BatchContinuityInput;
}

test('a batch cut inside one explicit source scene must not change its accepted internal scene number',()=>{
 const options=input(),before=structuredClone(options),result=reconcile(source,options);
 const decisions=coalesceFidelityDecisions(source,result.decisions);
 assert.equal(decisions.find(d=>d.start<=cut&&d.end>cut)?.sceneNumber,4,
  'the same source scene continues across this batch boundary; authored 24.3 is not internal scene 3');
 assert.equal(decisions.length,1);assert.deepEqual(options,before);assert.equal(source.slice(pending[0].start).split('\n')[0],'24.3 夜 内 浴室');
 assert.deepEqual(result.decisions.map(d=>d.note),pending.map(d=>d.note));assert.deepEqual(result.diagnostics,[]);
 assert.equal(result.corrections.length,1);
 const correction=result.corrections[0];
 assert.equal(correction.fromSceneNumber,3);assert.equal(correction.toSceneNumber,4);assert.equal(correction.cut,cut);
 assert.equal(correction.sourceAnchor.start,pending[0].start);assert.equal(correction.sourceAnchor.end,source.indexOf('甲：打开花洒'));
 assert.deepEqual(correction.previousBatch,{start:0,end:cut});assert.deepEqual(correction.nextBatch,{start:cut,end:source.length,status:'CURRENT'});
 assert.equal(correction.sourceVersion,(normalize(source) as FidelityResult).source.sourceVersion);
 assert.equal((normalize(source,{decisions}) as FidelityResult).source.text,source);
 const repeated=reconcile(source,{...options,pendingDecisions:result.decisions});
 assert.deepEqual(repeated.decisions,result.decisions);assert.deepEqual(repeated.corrections,[]);
});

test('the real comma-style authored 24.3 anchor keeps P1 internal scene 4 in its continuation',()=>{
 const text='第 24 集\n\n第24集\n\n24.3 夜，内，浴室\n\n人物：苏尘\n\n▲苏尘确认浴室门反锁，脱掉衣服丢进洗衣机，打开花洒。\n\n苏尘os：误会就误会了，身正不怕影子斜。\n\n▲苏尘低头看着胸膛上的伤疤，水流划过肌肤。\n';
 const options=fixture(text,'24.3','苏尘os：'),result=reconcile(text,options);
 assert.equal(result.decisions[1].sceneNumber,4);assert.equal(result.corrections[0].sourceAnchor.start,text.indexOf('24.3'));
 assert.equal((normalize(text,{decisions:coalesceFidelityDecisions(text,result.decisions)}) as FidelityResult).source.text,text);
});

test('two completed batch ranges prove the same correction during saved-checkpoint recovery',()=>{
 const options=input();options.completedRanges=[...options.completedRanges,options.currentBatch!];delete options.currentBatch;
 const result=reconcile(source,options);
 assert.equal(result.decisions[1].sceneNumber,4);assert.equal(result.corrections[0].nextBatch.status,'COMPLETED');
});

test('a newly recognized source scene at the next batch is not a continuation',()=>{
 const text='第24集\n24.3 夜 内 浴室\n甲：前场。\n24.4 夜 内 卧室\n甲：后场。\n';
 unchanged(text,fixture(text,'24.3','24.4'),'NEW_SOURCE_SCENE','SKIPPED');
});

test('another episode assignment is never rewritten',()=>{
 const options=input();options.pendingDecisions[1].episodeNumber=25;
 unchanged(source,options,'EPISODE_OR_CONTEXT_CHANGE','SKIPPED');
});

test('a context decision between two P1 body ranges never authorizes a merge',()=>{
 const text='第24集\n24.3 夜 内 浴室\n甲：前段。\n背景摘记\n甲：后段。\n',a=text.indexOf('背景摘记'),b=text.indexOf('甲：后段');
 const options=fixture(text,'24.3','甲：后段');options.pendingDecisions=[{...options.pendingDecisions[0],end:a},{start:a,end:b,kind:'context',note:'保留资料边界。'},options.pendingDecisions[1]];
 unchanged(text,options,'EPISODE_OR_CONTEXT_CHANGE','SKIPPED');
});

test('a gap, including source whitespace, is not silently bridged',()=>{
 const text='第24集\n24.3 夜 内 浴室\n甲：前段。\n\n甲：后段。\n',options=fixture(text,'24.3','甲：后段');
 options.pendingDecisions[0].end=text.indexOf('\n\n')+1;
 unchanged(text,options,'NONADJACENT_DECISIONS','SKIPPED');
});

test('manual body or context ownership touching the affected source scene is preserved',()=>{
 for(const kind of ['body','context'] as const){
  const options=input();options.manualDecisions=[{start:cut,end:source.length,kind,note:'用户明确采用的边界。',...(kind==='body'?{episodeNumber:24,sceneNumber:8}:{})}];
  unchanged(source,options,'MANUAL_BOUNDARY_PRESENT','SKIPPED');
 }
 const options=input();options.manualDecisions=[{...pending[0],sceneNumber:9,note:'用户已决定前段。'}];
 unchanged(source,options,'MANUAL_BOUNDARY_PRESENT','SKIPPED');
});

test('an unrelated manual source range remains untouched and does not forbid a proved local correction',()=>{
 const options=input();options.manualDecisions=[{start:0,end:pending[0].start,kind:'context',note:'用户仅采用标题资料分类。'}];
 const before=structuredClone(options),result=reconcile(source,options);
 assert.equal(result.decisions[1].sceneNumber,4);assert.deepEqual(options,before);
});

test('no explicit source scene anchor stays a technical unresolved item',()=>{
 const text='第24集\n甲：前段没有场头。\n甲：后段没有场头。\n';
 unchanged(text,fixture(text,'甲：前段','甲：后段'),'SOURCE_ANCHOR_UNCONFIRMED','UNRESOLVED');
});

test('a matching source scene is insufficient without both actual batch ranges',()=>{
 const options=input();delete options.currentBatch;
 unchanged(source,options,'BATCH_BOUNDARY_UNPROVEN','SKIPPED');
 const inside=input();inside.completedRanges=[{start:0,end:source.length}];delete inside.currentBatch;
 unchanged(source,inside,'BATCH_BOUNDARY_UNPROVEN','SKIPPED');
});

test('unverifiable input cannot claim an established cross-batch technical conflict',()=>{
 const malformed=input();malformed.pendingDecisions[0].start++;
 unchanged(source,malformed,'INVALID_DECISION_RANGE','SKIPPED');
 unchanged(source+'\ud800',input(),'SOURCE_UNVERIFIABLE','SKIPPED');
});

test('implicit transition cues and opaque narrative are never converted into mechanical continuity',()=>{
 for(const continuation of ['【镜头切：另一处】\n甲：新地方。\n','▲次日，甲在另一间房醒来。\n','翌日的故事还在继续。\n','▲甲走出浴室，来到大厅。\n']){
  const text='第24集\n24.3 夜 内 浴室\n甲：前段。\n'+continuation;
  unchanged(text,fixture(text,'24.3',continuation),'POSSIBLE_IMPLICIT_BOUNDARY','UNRESOLVED');
 }
});

test('an inherited scene id and recurring actor cannot prove continuation at a new place or time',()=>{
 for(const continuation of ['▲机场候机厅，甲正在排队。\n甲：继续。\n','▲三年后，甲已满头白发。\n甲：继续。\n','▲甲在机场候机厅排队。\n甲：继续。\n','甲：继续。\n▲甲在机场候机厅排队。\n','甲：继续。\n▲甲低头看着车票。三年后，他重新启程。\n','甲：快登机了。\n▲甲抬头，机场候机厅的登机广播响起。\n','甲：继续。\n▲甲抬头，十分钟后飞机已降落巴黎。\n']){
  const text='第24集\n24.3 夜 内 浴室\n甲：前段。\n'+continuation;
  const result=unchanged(text,fixture(text,'24.3',continuation));
  assert(result.diagnostics.some(d=>d.status==='UNRESOLVED'),'uncertain scene continuity is technical pending, never a fresh paid request');
 }
});

test('the later decision cannot swallow a different explicit source scene further inside its range',()=>{
 const text='第24集\n24.3 夜 内 浴室\n甲：前段。\n甲：续段。\n24.4 夜 内 卧室\n甲：新场。\n';
 unchanged(text,fixture(text,'24.3','甲：续段'),'SOURCE_RANGE_CROSSES_SCENE','UNRESOLVED');
});

test('a previous partial range without an anchored accepted chain is not trusted as the scene authority',()=>{
 const options=input();options.pendingDecisions[0].start=source.indexOf('甲：打开花洒');
 unchanged(source,options,'PREVIOUS_SCENE_NOT_ANCHORED','UNRESOLVED');
});

test('a corrected chain can continue across three proved batches without changing authored numbering',()=>{
 const text='第24集\n24.3 夜 内 浴室\n甲：第一段。\n甲：第二段。\n甲：第三段。\n',second=text.indexOf('甲：第二段'),third=text.indexOf('甲：第三段');
 const options:P1BatchContinuityInput={manualDecisions:[],pendingDecisions:[{...pending[0],start:text.indexOf('24.3'),end:second},{...pending[1],start:second,end:third},{...pending[1],start:third,end:text.length,sceneNumber:2}],completedRanges:[{start:0,end:second},{start:second,end:third}],currentBatch:{start:third,end:text.length}};
 const result=reconcile(text,options);assert.deepEqual(result.decisions.map(d=>d.sceneNumber),[4,4,4]);assert.equal(result.corrections.length,2);
});

test('CRLF and surrogate pairs retain exact UTF16 source anchors and cut coordinates',()=>{
 const text='第24集\r\n24.3 夜 内 浴室\r\n甲：前段😀。\r\n甲：后段😀。\r\n',options=fixture(text,'24.3','甲：后段');
 const result=reconcile(text,options);assert.equal(result.decisions[1].sceneNumber,4);assert.equal(result.corrections[0].cut,text.indexOf('甲：后段'));
 assert.equal(result.corrections[0].sourceAnchor.end,text.indexOf('甲：前段'));
});

test('two distinct source-16 episode anchors are never joined merely because their numbers match',()=>{
 const text='第16集\n16.1 夜 内 走廊\n甲：夜间。\n第16集\n16.1 日 外 医院\n甲：白天。\n';
 const options=fixture(text,'16.1','第16集\n16.1 日');options.pendingDecisions.forEach(d=>{d.episodeNumber=16;});
 unchanged(text,options,'NEW_SOURCE_EPISODE','SKIPPED');
});
