import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as agreements from './production-agreements.mjs';
const {createAgreementStore}=agreements;
test('agreement basis binds full source, not an expandable view or unrelated series index',()=>{
 const seed={fromEpisode:1,toEpisode:2,sourceVersion:'index-one',previousSource:{episode:1,sourceTextHash:'previous-full-hash',sourceLength:5000,text:'尾段',sourceRange:{start:4900,end:5000}},currentOpening:{episode:2,sourceTextHash:'current-full-hash',sourceLength:1000,text:'开场'}};
 const basis=agreements.agreementSourceBasis(seed);
 assert.equal(agreements.agreementSourceBasis({...seed,sourceVersion:'index-two',previousSource:{...seed.previousSource,text:'完整上集',sourceRange:{start:0,end:5000}}}),basis);
 assert.notEqual(agreements.agreementSourceBasis({...seed,previousSource:{...seed.previousSource,sourceTextHash:'changed'}}),basis);
 assert.throws(()=>agreements.agreementSourceBasis({...seed,previousSource:{text:'不可信旧种子'}}),{code:'AGREEMENT_SOURCE_UNVERIFIED'});
});
test('parallel preparation locks only before prior author; first accepted choice is immutable',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'production-agreements-'));
 try{
  const s=createAgreementStore(root),boundary={chainId:'chain',fromEpisode:1,toEpisode:2},options={sourceBasis:'source',choices:[{key:'PR01/hand',value:'右手',authority:'DESIGN',sourceRefs:[]}],producerRunId:'e2',predecessorUnstarted:true};
  assert.equal(await s.publish(boundary,{...options,predecessorUnstarted:false}),null);
  const first=await s.publish(boundary,options),conflict=await s.publish(boundary,{...options,choices:[{...options.choices[0],value:'左手'}]});
  assert.equal(conflict.proposalConflict,true);assert.deepEqual((await s.read(boundary)).choices,first.choices);
  await assert.rejects(s.publish(boundary,{...options,sourceBasis:'changed'}),{code:'AGREEMENT_SOURCE_CHANGED'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('author admission atomically seals the shared boundary against a stale later proposal',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'production-agreement-admit-'));
 try{
  const s=createAgreementStore(root),boundary={chainId:'race',fromEpisode:1,toEpisode:2},options={sourceBasis:'source',choices:[{key:'PR01/hand',value:'右手',authority:'DESIGN',sourceRefs:[]}],producerRunId:'e2',predecessorUnstarted:true};
  const seal=await s.seal(boundary,{sourceBasis:'source',predecessorRunId:'e1'});
  assert.equal(seal.sealed,true);assert.deepEqual(seal.choices,[]);
  const late=await s.publish(boundary,options);assert.deepEqual(late.choices,[],'a stale unstarted observation cannot add a new lock');
  const second={...boundary,chainId:'publish-first'};
  const published=await s.publish(second,options),admitted=await s.seal(second,{sourceBasis:'source',predecessorRunId:'e1'});
  assert.deepEqual(admitted.choices,published.choices,'the author must see every proposal accepted before admission');
  for(let i=0;i<5;i++){
   const concurrent={...boundary,chainId:`concurrent-${i}`};
   const [proposal,closed]=await Promise.all([s.publish(concurrent,options),s.seal(concurrent,{sourceBasis:'source',predecessorRunId:'e1'})]);
   const saved=await s.read(concurrent);assert.equal(saved.sealed,true);assert.deepEqual(saved.choices,closed.choices);
   assert.deepEqual((await s.publish(concurrent,{...options,choices:[{...options.choices[0],value:'左手'}]})).choices,closed.choices);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a changed selected successor replaces only an open proposal, never an admitted lock',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'production-agreement-selection-'));
 try{
  const s=createAgreementStore(root),boundary={chainId:'selection',fromEpisode:1,toEpisode:2},options={sourceBasis:'source',choices:[{key:'PR01/hand',value:'右手',authority:'DESIGN',sourceRefs:[]}],producerRunId:'old-e2',predecessorUnstarted:true};
  await s.publish(boundary,options);
  const next=await s.publish(boundary,{...options,producerRunId:'new-e2',choices:[{...options.choices[0],value:'左手'}]});
  assert.equal(next.producerRunId,'new-e2');assert.equal(next.choices[0].value,'左手');assert.equal(next.supersededProposals[0].producerRunId,'old-e2');
  const closed=await s.seal(boundary,{sourceBasis:'source',predecessorRunId:'e1',selectedSuccessorRunId:'different-e2'});
  assert.deepEqual(closed.choices,[]);assert.equal(closed.supersededProposals.length,2);
  const late=await s.publish(boundary,{...options,producerRunId:'different-e2'});assert.deepEqual(late.choices,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
