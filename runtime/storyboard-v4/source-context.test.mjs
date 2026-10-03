import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {digest} from './core/shared.mjs';
import {makeEpisodeInput} from './input.mjs';
import {readEpisodeSourceContext} from './source-context.mjs';
const episode={id:'ep5',projectId:'p1',number:5,title:'局部样本',content:'甲：好强！\n△甲后退两步，仍站着。'};
const project={id:'p1',style:'3D国漫',aspectRatio:'16:9'};
const profile=()=>({schemaVersion:'independent-source-context-v1',projectId:'p1',episodeId:'ep5',contentHash:digest(episode.content),title:'测试段',scene:'日 外 城墙',origin:{episode:'原第18集',range:'L0559-L0565'},contextRows:[{id:'prior:L0558',text:'△甲收起火焰。'}],entryFacts:[{id:'fire-stowed',subject:'甲',statement:'甲已收起火焰',sourceRefs:['prior:L0558'],evidence:'收起火焰'}]});
test('independent fragment consumes current DB text and exact context without old project contamination',()=>{
 const result=makeEpisodeInput({episode,project,independentSource:profile(),handoff:{packet:{sourceText:episode.content,assets:[{name:'旧剧人物'}],scenes:[{heading:'旧场景'}],boundaryContext:{previousSource:{episode:4,text:'旧剧前情'}}}}});
 assert.equal(result.source.dialogue[0].quote,'好强！');assert.equal(result.source.contextRows[0].text,'△甲收起火焰。');assert.equal(result.source.entryFacts[0].id,'fire-stowed');
 assert.deepEqual(result.source.assets,[]);assert.ok(!JSON.stringify(result.source).includes('旧剧'));assert.equal(result.readiness,'INDEPENDENT_FRAGMENT');
});
test('stale or cross-episode context is rejected, never silently inherited',()=>{
 assert.throws(()=>makeEpisodeInput({episode:{...episode,content:'另一个片段'},project,independentSource:profile()}),e=>e.code==='SOURCE_CONTEXT_STALE');
 assert.throws(()=>makeEpisodeInput({episode:{...episode,id:'ep6'},project,independentSource:profile()}),e=>e.code==='SOURCE_CONTEXT_BINDING');
 const extra={...profile(),goldStoryboard:'不应传入生成答案'};assert.throws(()=>makeEpisodeInput({episode,project,independentSource:extra}),e=>e.code==='SOURCE_CONTEXT_SCHEMA');
});
test('context evidence changes source identity but extra user notes do not replace the original',()=>{
 const a=makeEpisodeInput({episode,project,independentSource:profile()});const p=profile();p.contextRows[0].text='△甲刚刚收起火焰。';
 const b=makeEpisodeInput({episode,project,independentSource:p,notes:'保持严肃'});assert.notEqual(a.sourceVersion,b.sourceVersion);assert.equal(b.source.dialogue[0].quote,a.source.dialogue[0].quote);
});
test('fixed local context reader uses exact episode binding and missing profile means normal source path',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'source-context-check-'));
 try{assert.equal(await readEpisodeSourceContext(root,episode),null);await mkdir(path.join(root,'source-contexts'));await writeFile(path.join(root,'source-contexts','ep5.json'),JSON.stringify(profile()));assert.equal((await readEpisodeSourceContext(root,episode)).title,'测试段');await assert.rejects(readEpisodeSourceContext(root,{...episode,id:'../escape'}));}
 finally{await rm(root,{recursive:true,force:true});}
});
