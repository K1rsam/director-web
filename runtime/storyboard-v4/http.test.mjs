import test from 'node:test';
import assert from 'node:assert/strict';
import {readCommand,assertEpisodeBinding} from './http.mjs';
const post=(body,headers={})=>new Request('http://127.0.0.1:3007/api/episodes/e/storyboard',{method:'POST',headers:{'content-type':'application/json','x-storyboard-action':'1',...headers},body:JSON.stringify(body)});
test('mutation requires same origin, local intent header and object JSON',async()=>{
 await assert.rejects(readCommand(post({action:'create'},{origin:'https://evil.example'})),e=>e.status===403);
 await assert.rejects(readCommand(post({action:'create'},{'x-storyboard-action':'0'})),e=>e.status===403);
 await assert.rejects(readCommand(post([])),e=>e.status===400);
});
test('create admits only bounded controls, never browser-provided source or model',async()=>{
 assert.equal((await readCommand(post({action:'create',settings:{maxUnitSeconds:30,fantasyMode:'review'},maxCalls:0,maxTokens:0}))).settings.fantasyMode,'review');
 await assert.rejects(readCommand(post({action:'create',source:'override'})));
 await assert.rejects(readCommand(post({action:'create',settings:{model:'gpt-6-astra'}})));
 await assert.rejects(readCommand(post({action:'create',notes:'a'.repeat(4001)})));
});
test('scope identifiers, repair instructions, and numbers are checked before dispatch',async()=>{
 await assert.rejects(readCommand(post({action:'start',runId:'../../other',mode:'all'})));
 await assert.rejects(readCommand(post({action:'repair',runId:'r',packageIds:['p'],notes:''})));
 await assert.rejects(readCommand(post({action:'budget',runId:'r',maxCalls:3.5,maxTokens:1000})));
 await assert.rejects(readCommand(post({action:'choice',runId:'r',overrides:{f:'yes'}})));
});
test('cross-episode run cannot be read or mutated through another authorized episode',()=>{
 assert.throws(()=>assertEpisodeBinding({web:{binding:{projectId:'p',episodeId:'e2'}}},{projectId:'p',id:'e1'}),e=>e.status===404);
 assert.doesNotThrow(()=>assertEpisodeBinding({web:{binding:{projectId:'p',episodeId:'e1'}}},{projectId:'p',id:'e1'}));
});
test('Next internal URL alias cannot reject the actual loopback browser origin',async()=>{
 const r=new Request('http://localhost:3007/api/episodes/e/storyboard',{method:'POST',headers:{host:'127.0.0.1:3007',origin:'http://127.0.0.1:3007','x-storyboard-action':'1','content-type':'application/json'},body:JSON.stringify({action:'create'})});
 assert.equal((await readCommand(r)).action,'create');
 await assert.rejects(readCommand(post({action:'create'},{host:'evil.example',origin:'http://evil.example'})),e=>e.status===403);
});
test('pause is explicit and cancellation acknowledgement requires scoped affirmative consent',async()=>{
 assert.equal((await readCommand(post({action:'pause',runId:'r'}))).action,'pause');
 const request={action:'acknowledge_cancel',runId:'r',attemptId:'a',acceptUnknownUsage:true};
 assert.equal((await readCommand(post(request))).acceptUnknownUsage,true);
 for(const bad of [{...request,acceptUnknownUsage:false},{...request,acceptUnknownUsage:'true'},{...request,acceptUnknownUsage:undefined},{...request,attemptId:'../other'},{...request,maxTokens:2000000}])await assert.rejects(readCommand(post(bad)));
});
