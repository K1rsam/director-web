import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from './storyboard-v4/core/store.mjs';
import {withStoryboardArchive} from './storyboard-archive.mjs';
test('old records remain readable/exportable and cannot invoke the new engine',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'storyboard-archive-'));
 try{
  const prior=createStore(path.join(root,'old')),current=createStore(path.join(root,'new'));
  const d={id:'old',web:{binding:{projectId:'p',episodeId:'e'}},assembly:{text:'完整旧稿'}};
  await prior.create('old',d);await current.create('new',{...d,id:'new'});let dispatched=0;
  const facade=withStoryboardArchive({...current,list:async()=>[await current.read('new')],start:async()=>{dispatched++;}},path.join(root,'old'));
  assert.equal((await facade.read('old')).assembly.text,'完整旧稿');assert.equal((await facade.read('old')).web.legacyReadOnly,true);
  assert.equal((await facade.list({episodeId:'e'})).length,2);
  await assert.rejects(facade.start('old'),{code:'LEGACY_READ_ONLY'});assert.equal(dispatched,0);
  await facade.start('new');assert.equal(dispatched,1);assert.deepEqual(await prior.read('old'),d);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('project and episode filters apply equally to current and archived tasks',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'storyboard-archive-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const archive=createStore(path.join(root,'old')),current=createStore(path.join(root,'new'));
 const doc=(id,projectId,episodeId)=>({id,web:{binding:{projectId,episodeId}},assembly:{text:`${id}完整稿`}});
 const active=[doc('p-current','p','e'),doc('q-current','q','q-e')];
 await archive.create('p-previous',doc('p-previous','p','e'));
 await archive.create('q-previous',doc('q-previous','q','q-e'));
 const service=withStoryboardArchive({...current,list:async()=>active},path.join(root,'old'));
 assert.deepEqual((await service.list({projectId:'p'})).map(d=>d.id).sort(),['p-current','p-previous']);
 assert.deepEqual((await service.list({projectId:'p',episodeId:'q-e'})).map(d=>d.id),[],'mixed bindings cannot return another project');
 assert.equal((await service.list()).length,4,'unfiltered administrative inventory remains available');
 assert.deepEqual(active,[doc('p-current','p','e'),doc('q-current','q','q-e')],'read filters do not mutate saved records');
});
