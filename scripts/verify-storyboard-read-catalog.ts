/** Actual filesystem and saved-index boundary; no production DB, dispatch or model. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,mkdir,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';

test('saved episode navigation does not reparse unrelated settled runs after discovery',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'storyboard-catalog-')),current=path.join(root,'current'),archive=path.join(root,'archive');
 await Promise.all([mkdir(path.join(current,'documents'),{recursive:true}),mkdir(path.join(archive,'documents'),{recursive:true})]);
 const previousRoot=process.env.DIRECTOR_STORYBOARD_DATA_DIR,previousArchive=process.env.DIRECTOR_STORYBOARD_ARCHIVE_DIR;
 const state=globalThis as any,previousService=state.storyboardIntegratedV1,previousHooks=state.storyboardRuntimeHooks;
 const hook=registerHooks({resolve(specifier,context,next){return next(specifier==='server-only'?'next/dist/compiled/server-only/empty.js':specifier,context);}});
 const reads:string[]=[];
 const read=async(id:string)=>{reads.push(id);return JSON.parse(await readFile(path.join(current,'documents',id+'.json'),'utf8'));};
 const make=(id:string,episodeId:string,projectId='p')=>({id,status:'planned',operations:[],source:{title:id},web:{binding:{projectId,episodeId},createdAt:'2026-10-16T00:00:00.000Z'}});
 const save=async(doc:any)=>{const temp=path.join(current,'documents',doc.id+'.tmp');await writeFile(temp,JSON.stringify(doc));await rename(temp,path.join(current,'documents',doc.id+'.json'));};
 try{
  process.env.DIRECTOR_STORYBOARD_DATA_DIR=current;process.env.DIRECTOR_STORYBOARD_ARCHIVE_DIR=archive;
  await Promise.all([save(make('one','e1')),save(make('two','e2')),save(make('foreign','other','q'))]);
  state.storyboardIntegratedV1={read,active:()=>false,list:async(binding:any={})=>{
   // Existing public coordinator contract: load documents, then filter.
   const documents=await Promise.all(['one','two','foreign'].map(read));return documents.filter(d=>!binding.episodeId||d.web.binding.episodeId===binding.episodeId);
  }};
  const {storyboardSavedIndex}=await import('../lib/storyboard-service');
  const episode={id:'e1',projectId:'p'};
  assert.deepEqual((await storyboardSavedIndex(episode)).index.runs.map((r:any)=>r.id),['one']);
  reads.length=0;
  const saved=await storyboardSavedIndex(episode);
  assert.deepEqual(saved.documents.map((r:any)=>r.id),['one']);
  assert.deepEqual(reads,['one'],'切换到一集不应重读其它集和其它项目的大正文');
  saved.documents[0].status='CLIENT_MUTATION';
  assert.equal((await storyboardSavedIndex(episode)).documents[0].status,'planned','no retained mutable document cache');
  await save({...make('one','e1'),status:'text_ready_for_review'});
  assert.equal((await storyboardSavedIndex(episode)).documents[0].status,'text_ready_for_review','atomic external writes are noticed immediately');
  await save(make('new-one','e1'));
  assert.deepEqual((await storyboardSavedIndex(episode)).documents.map((r:any)=>r.id).sort(),['new-one','one']);
  await save(make('two','e1'));
  assert.deepEqual((await storyboardSavedIndex(episode)).documents.map((r:any)=>r.id).sort(),['new-one','one','two'],'changed membership must not remain cached');
  await save(make('one','e1','q'));
  assert.ok(!(await storyboardSavedIndex(episode)).documents.some((r:any)=>r.id==='one'),'mixed project/episode binding is never returned');
  await rm(path.join(current,'documents','new-one.json'));
  assert.deepEqual((await storyboardSavedIndex(episode)).documents.map((r:any)=>r.id),['two'],'removed files are not retained');
 }finally{
  hook.deregister();state.storyboardIntegratedV1=previousService;state.storyboardRuntimeHooks=previousHooks;
  if(previousRoot===undefined)delete process.env.DIRECTOR_STORYBOARD_DATA_DIR;else process.env.DIRECTOR_STORYBOARD_DATA_DIR=previousRoot;
  if(previousArchive===undefined)delete process.env.DIRECTOR_STORYBOARD_ARCHIVE_DIR;else process.env.DIRECTOR_STORYBOARD_ARCHIVE_DIR=previousArchive;
  await rm(root,{recursive:true,force:true});
 }
});

test('read catalogue preserves active precedence, legacy read-only and project isolation',async()=>{
 const {createStoryboardReadCatalog}=await import('../lib/storyboard-read-catalog');
 const root=await mkdtemp(path.join(tmpdir(),'storyboard-catalog-archive-'));
 const current=path.join(root,'current'),archive=path.join(root,'archive');
 await Promise.all([mkdir(path.join(current,'documents'),{recursive:true}),mkdir(path.join(archive,'documents'),{recursive:true})]);
 const make=(id:string,projectId='p')=>({id,status:'saved',web:{binding:{episodeId:'e',projectId}}});
 const save=(directory:string,doc:any)=>writeFile(path.join(directory,'documents',doc.id+'.json'),JSON.stringify(doc));
 const source=(directory:string)=>({directory,read:async(id:string)=>JSON.parse(await readFile(path.join(directory,'documents',id+'.json'),'utf8'))});
 try{
  await Promise.all([save(current,make('same','q')),save(archive,make('same')),save(archive,make('legacy')),save(current,make('new'))]);
  const list=createStoryboardReadCatalog(source(current),source(archive));
  const local=await list({projectId:'p',episodeId:'e'});
  assert.deepEqual(local.map(d=>d.id).sort(),['legacy','new'],'an archived copy cannot bypass a current document with a different binding');
  assert.equal(local.find(d=>d.id==='legacy')!.web.legacyReadOnly,true);
  assert.equal(local.find(d=>d.id==='new')!.web.legacyReadOnly,undefined);
  assert.deepEqual((await list({projectId:'q'})).map(d=>d.id),['same']);
  assert.equal((await list()).length,3,'unfiltered administrative inventory remains complete');
  await save(archive,{...make('legacy'),status:'updated'});
  assert.equal((await list({projectId:'p'})).find(d=>d.id==='legacy')!.status,'updated');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('overlapping discoveries share file headers, and a broken file cannot poison later recovery',async()=>{
 const {createStoryboardReadCatalog}=await import('../lib/storyboard-read-catalog');
 const root=await mkdtemp(path.join(tmpdir(),'storyboard-catalog-overlap-')),directory=path.join(root,'current');
 await mkdir(path.join(directory,'documents'),{recursive:true});
 const file=(id:string)=>path.join(directory,'documents',id+'.json'),make=(id:string)=>({id,web:{binding:{projectId:'p',episodeId:id}}});
 const reads:string[]=[];
 const read=async(id:string)=>{reads.push(id);return JSON.parse(await readFile(file(id),'utf8'));};
 try{
  await Promise.all(['one','two'].map(id=>writeFile(file(id),JSON.stringify(make(id)))));
  const list=createStoryboardReadCatalog({directory,read},{directory:path.join(root,'absent'),read:async()=>assert.fail('absent archive cannot be read')});
  const [first,second]=await Promise.all([list({episodeId:'one'}),list({episodeId:'one'})]);
  assert.equal(first[0].id,'one');assert.equal(second[0].id,'one');assert.equal(reads.filter(id=>id==='two').length,1,'cold discovery is shared rather than scanning the repository per caller');
  await writeFile(file('two'),'{broken');await assert.rejects(()=>list({episodeId:'one'}),SyntaxError);
  await writeFile(file('two'),JSON.stringify(make('two')));
  assert.equal((await list({episodeId:'one'}))[0].id,'one','failed discovery promises are not retained');
 }finally{await rm(root,{recursive:true,force:true});}
});
