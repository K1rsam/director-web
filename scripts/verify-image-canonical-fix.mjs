import {readFile,writeFile,mkdtemp,cp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalFixSpecs,acceptsCanonicalPreimage} from './install-image-canonical-fix.mjs';

const home=process.argv[2];if(!home||!path.isAbsolute(home))throw Error('Absolute Bridge home required');
const fixture=await mkdtemp(path.join(tmpdir(),'director-image-canonical-'));
await cp(path.join(home,'src'),path.join(fixture,'src'),{recursive:true});
await writeFile(path.join(fixture,'package.json'),'{"type":"module"}');
const sha=value=>createHash('sha256').update(value).digest('hex');
for(const spec of canonicalFixSpecs){
 const {relative,original:expected,patch}=spec;
 const filename=path.join(fixture,relative);let original=await readFile(filename,'utf8');
 const installed=original;
 if(sha(original)!==expected)original=await readFile(new URL('../runtime-3008/bridge-image-canonical-fix/'+path.basename(filename)+'.original',import.meta.url),'utf8');
 assert.equal(sha(original),expected);const after=patch(original);
 assert.equal(acceptsCanonicalPreimage(spec,original,after),true);
 assert.equal(acceptsCanonicalPreimage(spec,installed,after),true,'known legacy/new installed postimage');
 assert.equal(acceptsCanonicalPreimage(spec,after,after),true,'idempotent postimage');
 assert.equal(acceptsCanonicalPreimage(spec,installed+'\n// unexpected drift',after),false);
 await writeFile(filename,after);
}
await mkdir(path.join(fixture,'test'));
await cp(path.join(home,'test/tabObservationAdapter.test.js'),path.join(fixture,'test/tabObservationAdapter.test.js'));
const upstream=spawnSync(process.execPath,['--test','--test-reporter=tap',path.join(fixture,'test/tabObservationAdapter.test.js')],{encoding:'utf8'});
if(upstream.status!==0)throw Error(upstream.stdout+upstream.stderr);
const upstreamCount=Number(upstream.stdout.match(/# tests (\d+)/)?.[1]||0);assert.ok(upstreamCount>0);
const {tabObservationToCanonicalEvent:adapt}=await import(pathToFileURL(path.join(fixture,'src/bridge/adapters/tabObservationAdapter.js')).href);
const {createInitialRequestState}=await import(pathToFileURL(path.join(fixture,'src/bridge/state/requestPolicy.js')).href);
const {createRequestEvent,RequestEventType}=await import(pathToFileURL(path.join(fixture,'src/bridge/state/requestEvents.js')).href);
const {reduceRequestState:reduce}=await import(pathToFileURL(path.join(fixture,'src/bridge/state/requestMachine.js')).href);
const id='11111111-1111-4111-8111-111111111111',client='extension:tab:17';
const first='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const envelope={source:{contentEpoch:'epoch-a',sequence:7},messageId:'event-7'};
const state=()=>({...createInitialRequestState({requestId:id,sourceClientId:client,leaseId:'lease-a',ownerServerInstanceId:'server-a',conversationId:'WEB:temporary',resumed:true,at:100}),source:{clientId:client,leaseId:'lease-a',ownerServerInstanceId:'server-a',observationEpoch:'epoch-a',observationSequence:1,conversationId:'WEB:temporary',url:'https://chatgpt.com/',connection:'connected'}});
const active=(overrides={})=>({requestId:id,submittedUserTurnKey:'',leaseId:'lease-a',ownerServerInstanceId:'server-a',...overrides});
const observation=(overrides={})=>({observerId:'epoch-a',revision:7,observedAt:200,url:'https://chatgpt.com/c/'+first,conversationId:first,activeRequest:active(),turn:{key:'',userKey:''},generation:{state:'active'},output:{state:'final',answer:'unproven'},artifact:{state:'ready',count:1},artifacts:[{id:'unproven'}],...overrides});
const event=(current,overrides={},transport=envelope,at=200)=>adapt(id,client,{observation:observation(overrides)},current,at,transport);
const pending=event(state());
assert.equal(pending.data.conversationChanged,false);
assert.equal(pending.data.conversationCanonicalized,false);
assert.equal(pending.data.conversationId,'WEB:temporary');
assert.equal(pending.data.pendingImageConversation.conversationId,first);
assert.equal(pending.data.completionCandidate,false);assert.deepEqual(pending.data.artifacts,[]);
let current=reduce(state(),pending).state;
assert.equal(current.terminal,null);assert.equal(current.source.conversationId,'WEB:temporary');
const heartbeat=createRequestEvent(RequestEventType.HEARTBEAT,id,{clientId:client,url:observation().url,conversationId:first},{source:'test',occurredAt:210,receivedAt:210});
current=reduce(current,heartbeat).state;assert.equal(current.source.conversationId,'WEB:temporary');
// client.changed heartbeat may arrive before any observation and must not bypass proof.
assert.equal(reduce(state(),heartbeat).state.source.conversationId,'WEB:temporary');
const native=event(current,{turn:{key:'native-assistant',userKey:'native-user'},activeRequest:active({submittedUserTurnKey:'native-user'})},{...envelope,source:{...envelope.source,sequence:8},messageId:'event-8'},220);
assert.equal(native.data.conversationCanonicalized,true);assert.equal(native.data.conversationChanged,false);
assert.equal(reduce(current,native).state.source.conversationId,first);
for(const [name,changed,transport,at] of [
 ['other-conversation',{conversationId:other,url:'https://chatgpt.com/c/'+other}],
 ['other-with-new-native-keys',{conversationId:other,url:'https://chatgpt.com/c/'+other,turn:{key:'other-assistant',userKey:'other-user'},activeRequest:active({submittedUserTurnKey:'other-user'})}],
 ['content-reload',{}, {source:{contentEpoch:'epoch-b',sequence:9},messageId:'event-9'}],
 ['deadline',{},undefined,20*60*1000+1000],
 ['replaced-request',{activeRequest:{requestId:'another',submittedUserTurnKey:''}}],
 ['visible-conflicting-user',{turn:{key:'other',userKey:'user-other'}}],
 ['lease-conflict',{activeRequest:active({leaseId:'other-lease'})}],
 ['owner-conflict',{activeRequest:active({ownerServerInstanceId:'other-server'})}],
]){
 const failed=event(current,changed,transport??{source:{contentEpoch:'epoch-a',sequence:9},messageId:'event-9'},at??230);
 assert.equal(failed.data.conversationChanged,true,name);
 assert.equal(failed.data.conversationCanonicalized,false,name);
 assert.ok(reduce(current,failed).state.terminal,name);
}
for(const mutation of [s=>({...s,source:{...s.source,leaseId:''}}),s=>({...s,source:{...s.source,observationEpoch:''}}),s=>({...s,source:{...s.source,conversationId:'real-original'}}),s=>({...s,response:{...s.response,userTurnKey:'bound-user'}})]){
 const failed=event(mutation(state()));assert.equal(failed.data.conversationChanged,true);
}
assert.equal(adapt('generic',client,{observation:observation({activeRequest:{requestId:'generic'}})},state(),200,envelope).data.conversationChanged,true);
// Chrome now creates a local-chatgpt temporary URL before assigning the native
// conversation ID. Preparation can still be accepted, with no prompt.submitted.
for(const temporary of ['local-chatgpt%3A'+first,'local-chatgpt:'+first]){
 const early={...state(),lifecycle:'preparing',submission:'accepted',source:{...state().source,conversationId:temporary},response:{...state().response,startedAt:0}};
 const placeholder={turn:{key:'',userKey:'',index:-1,scopeReason:'no_submitted_user_turn'},generation:{state:'idle'},output:{state:'none'},artifact:{state:'pending',count:1},artifacts:[{id:'unproven-placeholder'}]};
 const wait=event(early,placeholder);
 assert.equal(wait.data.conversationChanged,false);assert.equal(wait.data.conversationCanonicalized,false);
 assert.equal(wait.data.conversationId,temporary);assert.equal(wait.data.pendingImageConversation.conversationId,first);
 assert.equal(wait.data.scopedToRequest,false);assert.equal(wait.data.leaseScopedToRequest,true);
 assert.equal(wait.data.completionCandidate,false);assert.deepEqual(wait.data.artifacts,[]);assert.equal(wait.data.answer,'');
 assert.equal(wait.data.lifecycle,undefined);assert.equal(wait.data.artifactStatus,undefined);
 const waiting=reduce(early,wait).state;assert.equal(waiting.terminal,null);
 assert.equal(reduce(early,heartbeat).state.source.conversationId,temporary,'heartbeat before placeholder');
 assert.equal(reduce(waiting,heartbeat).state.source.conversationId,temporary,'heartbeat after placeholder');
 // Even an apparently final image cannot be accepted while native keys are absent.
 const unproven=event(waiting);assert.equal(unproven.data.completionCandidate,false);assert.deepEqual(unproven.data.artifacts,[]);assert.equal(unproven.data.answer,'');
 const promoted=event({...waiting,submission:'submitted'},{turn:{key:'native-assistant',userKey:'native-user'},activeRequest:active({submittedUserTurnKey:'native-user'})},{source:{contentEpoch:'epoch-a',sequence:8},messageId:'event-8'},220);
 assert.equal(promoted.data.conversationCanonicalized,true);assert.equal(promoted.data.conversationChanged,false);
 assert.equal(reduce({...waiting,submission:'submitted'},promoted).state.source.conversationId,first);
 for(const [name,mutated,changes,time] of [
  ['created-at-missing',{...early,timestamps:{...early.timestamps,createdAt:0}},placeholder,200],
  ['future-created-at',{...early,timestamps:{...early.timestamps,createdAt:300}},placeholder,200],
  ['created-at-deadline',early,placeholder,20*60*1000+101],
  ['epoch-change',{...early,response:{...early.response,epoch:1}},placeholder,200],
  ['owner-change',early,{...placeholder,activeRequest:active({ownerServerInstanceId:'different-owner'})},200],
  ['lease-change',early,{...placeholder,activeRequest:active({leaseId:'different-lease'})},200],
  ['real-navigation',{...early,source:{...early.source,conversationId:other}},placeholder,200],
  ['wrong-url',early,{...placeholder,url:'https://chatgpt.com/c/'+other},200],
 ])assert.equal(event(mutated,changes,envelope,time).data.conversationChanged,true,name);
 assert.equal(event(waiting,{conversationId:other,url:'https://chatgpt.com/c/'+other}).data.conversationChanged,true,'pending candidate cannot change');
 assert.equal(event(waiting,placeholder,{source:{contentEpoch:'epoch-reloaded',sequence:9},messageId:'event-reloaded'}).data.conversationChanged,true,'content reload');
}
for(const unknown of ['local-chatgpt%3Ainvalid','local-chatgpt:'+first+'/extra','local-chatgpt%253A'+first,'local-other:'+first]){
 assert.equal(event({...state(),source:{...state().source,conversationId:unknown}}).data.conversationChanged,true,'unknown alias '+unknown);
}
console.log('PASS canonical regression: '+upstreamCount+' upstream tests; exact local-chatgpt aliases, accepted/preparing zero-response-start placeholder wait, no unproven output/artifacts/completion, bounded createdAt fallback, promotion and navigation/reload/lease/owner/epoch/deadline rejection; legacy upgrade/idempotence/drift checks; zero network or live generation.');
