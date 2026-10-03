import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {recordProofSpecs} from './install-image-record-proof.mjs';
const context=vm.createContext({crypto:webcrypto,TextEncoder,TextDecoder,URL});vm.runInContext(await readFile(new URL('./bridge-image-record-proof.js',import.meta.url),'utf8'),context);
const adapter=context.ChatGptImageRecordProof,prompt='draw one blue glass cube task-unique';
const expected={mode:'image_record_v1',requestId:'job-1',conversationId:'conversation-1',promptSha256:await adapter.digest(prompt),imageCount:1};
const record={conversation_id:'conversation-1',current_node:'assistant',mapping:{root:{parent:null,message:null},user:{parent:'root',message:{id:'native-user',author:{role:'user'},content:{parts:[prompt]}}},assistant:{parent:'user',message:{id:'native-assistant',author:{role:'assistant'},status:'finished_successfully',end_turn:true,recipient:'all',channel:'final',content:{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'sediment://file_image1'}]}}}}};
const snapshot={artifacts:[{id:'artifact-1',kind:'image',generatedImage:true,downloadUrl:'https://chatgpt.com/backend-api/estuary/content?id=file_image1&sig=not-logged'}]};
const facts={userCount:1,assistantCount:1,userText:prompt};const clone=()=>structuredClone(record);
const status=async(r=record,e=expected,s=snapshot,f=facts)=>(await adapter.evaluate(r,e,s,f));
assert.equal((await status()).status,'matched_complete');
assert.equal((await status(record,{...expected,mode:'image_record_probe'})).status,'diagnostic_only');
assert.equal((await status(record,expected,snapshot,{...facts,userText:'other prompt'})).reason,'dom_user_boundary');
assert.equal((await status(record,expected,snapshot,{...facts,userCount:2})).reason,'dom_user_boundary');
assert.equal((await status(record,expected,snapshot,{...facts,assistantCount:2})).reason,'dom_user_boundary');
let changed=clone();changed.conversation_id='other';assert.equal((await status(changed)).reason,'unsupported_branch');
changed=clone();changed.mapping.user.message.content.parts=['old prompt'];assert.equal((await status(changed)).reason,'backend_prompt');
changed=clone();changed.mapping.assistant.message.end_turn=false;assert.equal((await status(changed)).status,'matched_incomplete');
changed=clone();changed.mapping.assistant.message.status='in_progress';assert.equal((await status(changed)).status,'matched_incomplete');
changed=clone();changed.mapping.assistant.message.content.parts[0].asset_pointer='sediment://file_other';assert.equal((await status(changed)).reason,'backend_image_identity');
changed=clone();changed.mapping.root.parent='assistant';assert.equal((await status(changed)).reason,'unsupported_branch');
changed=clone();changed.mapping.root.message={id:'native-user',author:{role:'user'},content:{parts:[prompt]}};assert.equal((await status(changed)).reason,'unsupported_branch');
assert.equal((await status(record,expected,{...snapshot,stopVisible:true})).status,'matched_incomplete');
assert.equal((await status(record,expected,{artifacts:[...snapshot.artifacts,...snapshot.artifacts]})).reason,'dom_image_identity');
assert.equal((await status(record,{...expected,imageCount:2})).reason,'backend_image_identity');
console.log('PASS: 15 single-user native image proof checks, including branch, prompt, duplicate, stale image and incomplete generation rejection.');

// Native IDs are projected only after a complete, unchanged, active request proof.
context.location={href:'https://chatgpt.com/c/conversation-1',pathname:'/c/conversation-1'};
Object.assign(context,{AbortController,setTimeout,clearTimeout});
const userNode={isConnected:true,innerText:prompt,querySelectorAll:()=>[]};
const assistantNode={isConnected:true,innerText:'',querySelectorAll:()=>[{src:snapshot.artifacts[0].downloadUrl}]};
context.ChatGptTurnDom={createTurnDom:()=>({getTurnNodes:()=>[userNode,assistantNode],role:n=>n===userNode?'user':'assistant'})};
context.fetch=async()=>new Response(JSON.stringify(record));
let active={requestId:expected.requestId},bound=0;
const deps={getActiveRequest:()=>active,readLatestAssistantSnapshot:()=>snapshot,onBound:()=>bound++};
assert.equal((await adapter.read(expected,snapshot,deps)).status,'matched_complete');
assert.equal(bound,1);assert.equal(adapter.key(userNode),'native-user');assert.equal(adapter.key(assistantNode),'native-assistant');
assistantNode.innerText='different response';assert.equal(adapter.key(assistantNode),'');assistantNode.innerText='';
context.location.href='https://chatgpt.com/c/other';assert.equal(adapter.key(userNode),'');context.location.href='https://chatgpt.com/c/conversation-1';
context.fetch=async()=>{active={requestId:'different-job'};return new Response(JSON.stringify(record));};
assert.equal((await adapter.read(expected,snapshot,deps)).reason,'active_request_identity');assert.equal(bound,1);
console.log('PASS: native ID projection rejects page, content and in-flight request changes.');

async function blobProof(changedBytes=false){
 const scoped=vm.createContext({crypto:webcrypto,TextEncoder,TextDecoder,URL,AbortController,setTimeout,clearTimeout,location:{href:'https://chatgpt.com/c/conversation-1',pathname:'/c/conversation-1'}});
 vm.runInContext(await readFile(new URL('./bridge-image-record-proof.js',import.meta.url),'utf8'),scoped);const proof=scoped.ChatGptImageRecordProof;
 const blob='blob:https://chatgpt.com/local-image',originalUrl='https://chatgpt.com/backend-api/estuary/content?id=file_image1&sig=fixture';
 const image={isConnected:true,src:blob,closest:()=>({})},user={isConnected:true,innerText:prompt,querySelectorAll:()=>[]},assistant={isConnected:true,innerText:'',querySelectorAll:()=>[image]};
 scoped.ChatGptTurnDom={createTurnDom:()=>({getTurnNodes:()=>[user,assistant],role:n=>n===user?'user':'assistant'})};
 const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yMNoAAAAASUVORK5CYII=','base64');
 scoped.fetch=async url=>{
  if(url.endsWith('/api/auth/session'))return Response.json({accessToken:'fixture-token-never-returned'});
  if(url.includes('/files/download/'))return Response.json({download_url:originalUrl});
  if(url===blob||url===originalUrl){const bytes=Uint8Array.from(imageBytes);if(url===blob&&changedBytes)bytes[bytes.length-1]^=1;return new Response(bytes,{headers:{'Content-Type':'image/png'}});}
  return Response.json(record);
 };
 const readSnapshot=()=>({artifacts:[{...snapshot.artifacts[0],downloadUrl:proof.imageSource(image)||blob}]});
 const result=await proof.read(expected,readSnapshot(),{getActiveRequest:()=>({requestId:expected.requestId}),readLatestAssistantSnapshot:readSnapshot});return {result,source:proof.imageSource(image)};
}
assert.equal((await blobProof()).result.status,'matched_complete');
const wrongBlob=await blobProof(true);assert.equal(wrongBlob.result.reason,'blob_original_bytes_differ');assert.equal(wrongBlob.source,'');
console.log('PASS: native Blob source requires exact byte equality with the selected backend image.');

async function backgroundProof(options={}){
 const scoped=vm.createContext({crypto:webcrypto,TextEncoder,TextDecoder,URL,AbortController,setTimeout,clearTimeout,location:{href:'https://chatgpt.com/c/conversation-1',pathname:'/c/conversation-1'}});
 vm.runInContext(await readFile(new URL('./bridge-image-record-proof.js',import.meta.url),'utf8'),scoped);const proof=scoped.ChatGptImageRecordProof;
 const id='11111111-1111-4111-8111-111111111111';
 const message=prompt+'\n\n任务关联码：'+id+'。仅用于关联本次生成，请勿将编号或文字画入图片。';
 const spec={...expected,requestId:id,promptSha256:await proof.digest(message),mode:options.probe?'image_record_probe':'image_record_v1'};
 const nativeRecord=clone();nativeRecord.mapping.user.message.content.parts=[message];
 let active={requestId:id,leaseId:'lease-a',ownerServerInstanceId:'server-a',responseEpoch:0},epoch='epoch-a',recordReads=0,bound=0;
 const image={isConnected:true,src:options.directNative?'https://chatgpt.com/backend-api/estuary/content?id=file_image1&sig=not-returned':'',naturalWidth:0,naturalHeight:0,closest:()=>options.noGallery?null:{}};
 const user={isConnected:true,innerText:message,querySelectorAll:()=>[]},assistant={isConnected:true,innerText:'',querySelectorAll:()=>options.ambiguous?[image,{...image}]:[image]};
 scoped.ChatGptTurnDom={createTurnDom:()=>({getTurnNodes:()=>[user,assistant],role:n=>n===user?'user':'assistant'})};
 const originalUrl='https://chatgpt.com/backend-api/estuary/content?id=file_image1&sig=not-returned';
 const original=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yMNoAAAAASUVORK5CYII=','base64');
 scoped.fetch=async url=>{
  if(url.endsWith('/api/auth/session'))return Response.json({accessToken:'private-token-never-returned'});
  if(url.includes('/files/download/'))return Response.json({download_url:options.wrongFile?'https://chatgpt.com/backend-api/estuary/content?id=file_wrong':originalUrl});
  if(url===originalUrl){
   if(options.race==='lease')active={...active,leaseId:'lease-b'};
   if(options.race==='owner')active={...active,ownerServerInstanceId:'server-b'};
   if(options.race==='epoch')epoch='epoch-b';
   if(options.race==='request')active={...active,requestId:'other-job'};
   if(options.race==='page')scoped.location.href='https://chatgpt.com/c/other';
   if(options.race==='src')image.src='blob:https://chatgpt.com/replaced';
   if(options.race==='user')user.innerText='different user content';
   return new Response(options.badMagic?new Uint8Array(32):original,{headers:{'Content-Type':options.badMime?'image/svg+xml':'image/png',...(options.oversize?{'Content-Length':String(20*1024*1024+1)}:{})}});
  }
  if(url.includes('/backend-api/conversation/')){
   recordReads++;const response=structuredClone(nativeRecord);
   if(recordReads===1&&options.incomplete)response.mapping.assistant.message.end_turn=false;
   if(recordReads===2&&options.branchRace)response.mapping.assistant.message.id='changed-native-assistant';
   return Response.json(response);
  }
  throw Error('Unexpected URL');
 };
 const readSnapshot=()=>({artifacts:proof.imageReady(image)?[{id:'local-verified-native-artifact',kind:'image',generatedImage:true,downloadUrl:proof.imageSource(image),...proof.imageMetadata(image)}]:[]});
 const dependencies={getActiveRequest:()=>active,getContentEpoch:()=>epoch,readLatestAssistantSnapshot:readSnapshot,onBound:()=>bound++};
 const outcome=await proof.read(spec,readSnapshot(),dependencies);
 return {outcome,proof,image,user,assistant,recordReads,bound,original,originalUrl,mutate:kind=>{if(kind==='lease')active={...active,leaseId:'other'};if(kind==='epoch')epoch='other';if(kind==='page')scoped.location.href='https://chatgpt.com/c/other';if(kind==='src')image.src='changed';if(kind==='user')user.innerText='changed';}};
}
const background=await backgroundProof();
assert.equal(background.outcome.status,'matched_complete');assert.equal(background.outcome.proofVersion,2);
assert.equal(background.outcome.reason,'exact_single_user_native_download');assert.equal(background.outcome.proofSource,'native_record_download');
assert.equal(background.recordReads,2);assert.equal(background.bound,1);
assert.equal(background.proof.key(background.user),'native-user');assert.equal(background.proof.key(background.assistant),'native-assistant');
assert.equal(background.proof.imageReady(background.image),true);assert.equal(background.proof.imageReady({...background.image}),false);
const originalSha=[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',background.original))].map(v=>v.toString(16).padStart(2,'0')).join('');
assert.equal(background.outcome.bindings[0].bytesSha256,originalSha);assert.equal(background.outcome.bindings[0].size,background.original.length);
assert.match(background.outcome.bindings[0].recordSha256,/^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(background.outcome).includes('private-token'),false);assert.equal(JSON.stringify(background.outcome).includes('sig='),false);
const downloaded=background.proof.downloadBytes({sourceTurnKey:'native-assistant',requestId:'11111111-1111-4111-8111-111111111111'},background.originalUrl);
assert.deepEqual(Buffer.from(downloaded.bytes),background.original);downloaded.bytes[0]=0;
assert.equal(background.proof.downloadBytes({sourceTurnKey:'native-assistant'},background.originalUrl).bytes[0],137);
assert.equal(background.proof.downloadBytes({sourceTurnKey:'other'},background.originalUrl),null);
const directNative=await backgroundProof({directNative:true});assert.equal(directNative.outcome.status,'matched_complete');assert.equal(directNative.outcome.proofSource,'dom_native_url_download');assert.equal(directNative.outcome.bindings[0].bytesSha256,originalSha);
for(const options of [{wrongFile:true},{badMime:true},{badMagic:true},{oversize:true},{branchRace:true},{incomplete:true},{probe:true},{noGallery:true},{ambiguous:true},...['lease','owner','epoch','request','page','src','user'].map(race=>({race}))]){
 const failed=await backgroundProof(options);assert.notEqual(failed.outcome.status,'matched_complete',JSON.stringify(options));assert.equal(failed.bound,0,JSON.stringify(options));
 assert.equal(failed.proof.imageReady(failed.image),false,JSON.stringify(options));
}
for(const kind of ['lease','epoch','page','src','user']){const accepted=await backgroundProof();accepted.mutate(kind);assert.equal(accepted.proof.imageReady(accepted.image),false,kind);assert.equal(accepted.proof.downloadBytes({sourceTurnKey:'native-assistant'},accepted.originalUrl),null,kind);}
console.log('PASS: background 0x0 native original proof, byte SHA/cache identity, branch reread, privacy and 21 negative/race/invalidation checks; zero real browser calls.');

// Compile the real pinned installer postimages without writing or reloading the vendor.
const home=process.argv[2]||path.join(process.env.LOCALAPPDATA,'Programs/Director-3008-ChatGPT-Bridge/671815e');
const sha=source=>createHash('sha256').update(source).digest('hex');
const postimages=new Map();
for(const spec of recordProofSpecs){
 let source=await readFile(path.join(home,'tools/chrome-bridge-extension',spec.relative),'utf8');
 if(sha(source)!==spec.hash)source=await readFile(new URL('../runtime-3008/bridge-image-parser-experiment/'+spec.relative.replaceAll('/','_')+'.original',import.meta.url),'utf8');
 assert.equal(sha(source),spec.hash,spec.relative+' pinned original');
 const patched=spec.patch(source);assert.notEqual(patched,source,spec.relative+' hook');new vm.Script(patched,{filename:spec.relative});postimages.set(spec.relative,patched);
}
const actualReady=postimages.get('content/artifactDom.js');
const readinessContext=vm.createContext({ChatGptImageRecordProof:background.proof,isVisible:()=>false});
vm.runInContext(actualReady.slice(actualReady.indexOf('function generatedImageReady'),actualReady.indexOf('function generatedImageSourceKey'))+'\nglobalThis.fixtureReady=generatedImageReady;',readinessContext);
assert.equal(readinessContext.fixtureReady(background.image),true);assert.equal(readinessContext.fixtureReady({...background.image}),false);
const actualTransfer=postimages.get('content/artifactTransfer.js');
assert.equal(sha(actualTransfer),'62d4e6c1e325f575d9e8753fcae0bcdfb05facae3d1a11e7c56bf98914579e3b','restart installs native-byte cache plus image-only microtask transfer');
const transferContext=vm.createContext({ChatGptImageRecordProof:background.proof,validateArtifactBuffer:buffer=>Buffer.from(buffer).toString('base64'),fetch:()=>{throw Error('Trusted native cache must not make a second network request');}});
vm.runInContext(actualTransfer.slice(actualTransfer.indexOf('    async function fetchArtifactData'),actualTransfer.indexOf('    function gmFetchArtifact'))+'\nglobalThis.fixtureFetch=fetchArtifactData;',transferContext);
const cached=await transferContext.fixtureFetch(background.originalUrl,{sourceTurnKey:'native-assistant',requestId:'11111111-1111-4111-8111-111111111111',name:'original.png'});
assert.equal(cached.mime,'image/png');assert.deepEqual(Buffer.from(cached.contentBase64,'base64'),background.original);
assert.ok(postimages.get('content.js').includes('getContentEpoch: () => CONTENT_EPOCH'));
assert.ok(postimages.get('content/responseRecovery.js').includes("!['image_record_v1', 'image_record_probe'].includes(payload.reconcileConversation?.mode)"));
console.log('PASS: seven pinned installer postimages compile; actual 0x0 readiness and native-cache transfer hooks work without relaxing ordinary IMG checks or changing native URLs.');
