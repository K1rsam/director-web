import test from 'node:test';
import assert from 'node:assert/strict';
import {readCommand} from './http.mjs';
const basis='a'.repeat(64);
const post=body=>new Request('http://127.0.0.1:3008/api/episodes/e/storyboard',{method:'POST',headers:{'content-type':'application/json','x-storyboard-action':'1',origin:'http://127.0.0.1:3008'},body:JSON.stringify(body)});
test('one directed refinement accepts only bounded event choices and a bound base',async()=>{
 const body={action:'refine',runId:'r',eventIds:['e1','e2'],expectedBaseHash:basis};
 assert.deepEqual(await readCommand(post(body)),body);
 assert.deepEqual((await readCommand(post({...body,eventIds:['e1','e2','e3']}))).eventIds,['e1','e2','e3'],'the frozen engine checks version-specific scope, not HTTP');
 for(const fields of [{eventIds:[]},{eventIds:['e1','e1']},{eventIds:Array.from({length:501},(_,i)=>`e${i}`)},{expectedBaseHash:'old'},{maxCalls:40},{source:'override'}])await assert.rejects(readCommand(post({...body,...fields})),e=>e.status===400);
});
test('free refinement adoption requires candidate and the immutable base identity',async()=>{
 const body={action:'accept_refinement',runId:'r',candidateId:'c1',expectedBaseHash:basis};
 assert.deepEqual(await readCommand(post(body)),body);
 for(const fields of [{candidateId:undefined},{candidateId:'../c'},{expectedBaseHash:undefined},{expectedBaseHash:'old'},{model:'gpt-6.1-sol'}])await assert.rejects(readCommand(post({...body,...fields})),e=>e.status===400);
});
test('work orders accept bounded complete unit identifiers and two small optional notes, never truncate or accept unknown fields',async()=>{
 const body={action:'refine',runId:'r',eventIds:['e1'],unitIds:['u2','u3'],reviewNotes:'反问摊慢',preserveNotes:'保留听者反应',expectedBaseHash:basis};
 assert.deepEqual(await readCommand(post(body)),body);
 for(const fields of [{unitIds:[]},{unitIds:['u2','u2']},{reviewNotes:'x'.repeat(1201)},{preserveNotes:3},{reviewNotes:'a\0b'},{reference:'unknown'}])await assert.rejects(readCommand(post({...body,...fields})),e=>e.status===400);
});
test('free adoption accepts explicit saved group ids and rejects empty or duplicate selections',async()=>{
 const body={action:'accept_refinement',runId:'r',candidateId:'c1',expectedBaseHash:basis,groupIds:['rg-abc','rg-def']};
 assert.deepEqual(await readCommand(post(body)),body);
 for(const groupIds of [[],['rg-abc','rg-abc'],['../group'],null,'rg-abc'])await assert.rejects(readCommand(post({...body,groupIds})),e=>e.status===400);
});
test('source-note correction is explicit and bounded, not an unrestricted conflict override',async()=>{
 const body={action:'accept_refinement',runId:'r',candidateId:'c1',expectedBaseHash:basis,sourceResolution:{conflictHash:basis,reason:'候选遵守原文，工作单笔误。'}};
 assert.deepEqual(await readCommand(post(body)),body);
 for(const value of [null,[],{}, {conflictHash:'old',reason:'按原文'}, {conflictHash:basis,reason:' '}, {conflictHash:basis,reason:'x'.repeat(1201)}, {conflictHash:basis,reason:'按原文',override:true}])await assert.rejects(readCommand(post({...body,sourceResolution:value})),e=>e.status===400);
 await assert.rejects(readCommand(post({action:'refine',runId:'r',eventIds:['e1'],expectedBaseHash:basis,sourceResolution:body.sourceResolution})),e=>e.status===400);
});
