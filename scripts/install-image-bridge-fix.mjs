import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {install as installImageCanonicalFix} from './install-image-canonical-fix.mjs';
const home=process.argv[2];if(!home||!path.isAbsolute(home))throw Error('Bridge home must be absolute');
const file=path.join(home,'src/bridge/hub/clientMessageRouter.js');
const original=await readFile(file,'utf8');
const before=`  #pageChanged(client, payload, envelope) {
    this.#applyPageChanged(client, payload);
    const publicClient = this.publicClient(client);
    this.emit('client.changed', publicClient);`;
const previousFix=`  #pageChanged(client, payload, envelope) {
    // director3008: an observation refresh is not a document/session reload.
    const previous = { observerId: client.tabObservation?.observerId, contentEpoch: client.contentEpoch, url: client.url, sessionId: client.session?.id };
    this.#applyPageChanged(client, payload);
    const publicClient = this.publicClient(client);
    const sameDocument = previous.observerId && previous.contentEpoch && previous.url && previous.sessionId
      && previous.observerId === client.tabObservation?.observerId
      && previous.contentEpoch === String(envelope?.source?.contentEpoch || client.contentEpoch || '')
      && previous.url === client.url && previous.sessionId === client.session?.id;
    if (!sameDocument) this.emit('client.changed', publicClient);`;
const after=previousFix.replace(`    const sameDocument = previous.observerId && previous.contentEpoch && previous.url && previous.sessionId
      && previous.observerId === client.tabObservation?.observerId
      && previous.contentEpoch === String(envelope?.source?.contentEpoch || client.contentEpoch || '')
      && previous.url === client.url && previous.sessionId === client.session?.id;`, `    const incomingObserver = payload.observation?.observerId || payload.tabObservation?.observerId;
    const sameDocument = previous.observerId && previous.contentEpoch && previous.url && previous.sessionId
      && previous.observerId === incomingObserver
      && previous.contentEpoch === envelope?.source?.contentEpoch
      && previous.url === payload.url && previous.sessionId === payload.session?.id;`);
const normalized=original.replaceAll('\r\n','\n');
if(normalized.includes(after)&&createHash('sha256').update(original).digest('hex')!=='3d60e5809c0c4a697c76c42964c4ec912c3472dad7496bea40b2017e11da0d10')throw Error('Installed fix has drifted; launch refused');
if(!normalized.includes(after)){
 const sha=createHash('sha256').update(original).digest('hex');
 const expected=sha==='a12216d6c7187886a15c798ce16229816da8d2367b440984235b28d1721574d1'?before:sha==='ecb28d5d23be4d0d4def973a8748d2765c9d054f6de4e42f8545afa81955dff9'?previousFix:null;
 if(!expected||normalized.split(expected).length!==2)throw Error('Unexpected vendor preimage; fix not applied');
 await writeFile(file,normalized.replace(expected,after));
}
// Run against the actual installed router, including its upstream normalizers.
const {HubClientMessageRouter}=await import(pathToFileURL(file).href);
const events=[];
const router=new HubClientMessageRouter({recordDebugEvent:()=>{},publicClient:client=>({...client}),emit:type=>events.push(type)});
const fresh=()=>({id:'fixture',url:'https://chatgpt.com/',contentEpoch:'epoch-a',session:{id:'new'},tabObservation:{observerId:'observer-a',revision:1},activeRequest:null});
const run=(change={},envelope={source:{contentEpoch:'epoch-a'}})=>{events.length=0;router.handle(fresh(),{type:'page.changed',url:'https://chatgpt.com/',session:{id:'new'},observation:{observerId:'observer-a',revision:2},...change},envelope);return [...events];};
assert.deepEqual(run({activeRequest:{requestId:'fixture-request'}}),['client.activity']);
assert.deepEqual(run({title:'New title'}),['client.activity']);
assert.deepEqual(run({observation:{observerId:'observer-b',revision:1}}),['client.changed','client.activity']);
assert.deepEqual(run({}, {source:{contentEpoch:'epoch-b'}}),['client.changed','client.activity']);
assert.deepEqual(run({url:'https://chatgpt.com/c/new-session'}),['client.changed','client.activity']);
assert.deepEqual(run({session:{id:'different-session'}}),['client.changed','client.activity']);
assert.deepEqual(run({observation:undefined}),['client.changed','client.activity']);
assert.deepEqual(run({session:undefined}),['client.changed','client.activity']);
assert.deepEqual(run({}, {source:{}}),['client.changed','client.activity']);
const unknown=fresh();unknown.tabObservation=null;events.length=0;router.handle(unknown,{type:'page.changed',url:unknown.url},{source:{contentEpoch:'epoch-a'}});assert.deepEqual(events,['client.changed','client.activity']);
console.log('PASS installed Bridge guard: ordinary activity preserved; document reload, session navigation, epoch change and unknown identity retain reconciliation.');
await installImageCanonicalFix(home);
