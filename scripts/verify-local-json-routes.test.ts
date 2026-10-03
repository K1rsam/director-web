/** Real route handlers, isolated auth/storage/provider edges: no DB or model calls. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const origin='http://127.0.0.1:3008';
type TestRoute={name:string;file:string;limit:number;command:Record<string,unknown>;status:number};
const routes:TestRoute[]=[
 {name:'workflow',file:'app/api/projects/[projectId]/production-workflow/route.ts',limit:32768,command:{action:'create',episodeNumbers:[1]},status:201},
 {name:'direction',file:'app/projects/[projectId]/series-direction/route.ts',limit:32768,command:{action:'confirm',stateToken:'s'},status:200},
 {name:'adoption',file:'app/projects/[projectId]/asset-prompts/adoption/route.ts',limit:16000,command:{action:'adopt',assetKey:'CH'},status:200},
 {name:'reception',file:'app/projects/[projectId]/script-reception/route.ts',limit:8000,command:{action:'confirm',sourceVersion:'s'},status:200},
 {name:'asset',file:'app/projects/[projectId]/asset-prompts/api/route.ts',limit:65536,command:{action:'save',key:'CH',revision:1,body:'保留正文'},status:200},
];
function fixture(route:TestRoute){
 let signedIn=true,calls=0,received:unknown;
 const actorMutation=async(projectId:string,actorId:string,input:unknown)=>{
  assert.equal(projectId,'fixture');assert.equal(actorId,'session-user');calls++;received=input;return {ok:true};
 };
 const edge=(...args:unknown[])=>{calls++;received=args;return {ok:true};};
 class AdoptionError extends Error{constructor(message:string,public status=409){super(message);}}
 const failure=(error:any)=>({status:error.status??500,body:{code:error.code,error:error.message}});
 const dependencies:Record<string,unknown>={
  '@/lib/auth':{getCurrentUser:async()=>signedIn?{id:'session-user'}:null,requireSessionUser:async()=>assert.ok(signedIn),requireProjectAccess:async(projectId:string)=>assert.equal(projectId,'fixture')},
  '@/lib/production-workflow':{mutateProductionWorkflow:actorMutation,productionWorkflowFailure:failure},
  '@/lib/series-direction-service':{mutateSeriesDirection:actorMutation,generateSeriesDirectionCandidate:actorMutation,seriesDirectionFailure:failure},
  '@/lib/asset-design-adoption':{adoptAssetDesign:actorMutation,revokeAssetDesign:actorMutation,restoreAssetDesign:actorMutation,AssetDesignAdoptionError:AdoptionError},
  '@/lib/script-resolution-service':{confirmScriptResolution:actorMutation,revokeScriptResolution:actorMutation,assistScriptResolution:actorMutation},
  '@/lib/script-resolution-judgment':{createScriptResolutionJudgment:()=>assert.fail('No judgment needed for these transport tests')},
  '@/lib/asset-prompt-service':{saveAssetPrompt:edge},
  '@/lib/asset-image-options-service':{uploadAssetReference:edge},'@/lib/asset-prompt-automation':{},'@/lib/foundation-state':{},'@/lib/episode-upstream-material':{},
  '@/lib/fidelity-import':{},'@/lib/source-cleaning':{},'@/lib/import-script':{},'@/lib/fidelity-external':{},
 };
 function load(file:string):Record<string,any>{
  const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{} as Record<string,any>};
  new Function('require','module','exports',compiled)((name:string)=>{
   if(name==='@/lib/local-json-request')return load('lib/local-json-request.ts');
   assert.ok(Object.hasOwn(dependencies,name),`Unexpected dependency: ${name}`);return dependencies[name];
  },module,module.exports);
  return module.exports;
 }
 const post=load(route.file).POST;
 const send=(body:BodyInit=JSON.stringify(route.command),headers:Record<string,string>={},url=`${origin}/test`)=>post(new Request(url,{
  method:'POST',headers:{host:'127.0.0.1:3008',origin,'content-type':'application/json',...headers},body,duplex:'half',
 } as RequestInit),{params:Promise.resolve({projectId:'fixture'})}) as Promise<Response>;
 return {send,get calls(){return calls;},get received(){return received;},signOut:()=>{signedIn=false;}};
}
test('asset upload: multipart bytes, filename and fields survive bounded reading',async()=>{
 const f=fixture(routes[4]),form=new FormData(),bytes=new Uint8Array([0,0xff,0x89,0x50]);
 form.set('key','CH');form.set('revision','2');form.set('file',new File([bytes],'参考图.png',{type:'image/png'}));
 const encoded=new Request(`${origin}/upload`,{method:'POST',body:form});
 assert.equal((await f.send(await encoded.arrayBuffer(),{'content-type':encoded.headers.get('content-type')!})).status,200);
 const received=f.received as [string,string,number,File];
 assert.deepEqual(received.slice(0,3),['fixture','CH',2]);assert.equal(received[3].name,'参考图.png');
 assert.deepEqual(new Uint8Array(await received[3].arrayBuffer()),bytes);
});
test('asset upload: oversized chunked multipart stops before allocation of the entire upload',async()=>{
 const f=fixture(routes[4]);let pulls=0,cancelled=false;
 const body=new ReadableStream<Uint8Array>({pull(controller){
  pulls++;controller.enqueue(new TextEncoder().encode(pulls===1?'--bounded\r\nContent-Disposition: form-data; name="file"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n':'x'.repeat(1024*1024)));
  if(pulls===21){controller.enqueue(new TextEncoder().encode('\r\n--bounded--\r\n'));controller.close();}
 },cancel(){cancelled=true;}},{highWaterMark:0});
 assert.equal((await f.send(body,{'content-type':'multipart/form-data; boundary=bounded','content-length':'1'})).status,413);
 assert.equal(cancelled,true);assert.ok(pulls<=13);assert.equal(f.calls,0);
});
test('asset upload: malformed multipart reports bad request rather than a version conflict',async()=>{
 const f=fixture(routes[4]);assert.equal((await f.send('invalid multipart',{'content-type':'multipart/form-data'})).status,400);assert.equal(f.calls,0);
});
for(const name of ['preview','material'])test(`source ${name}: oversized chunked form is rejected before unlimited allocation`,async()=>{
 const f=fixture({name,file:`app/api/fidelity/${name}/route.ts`,limit:41*1024*1024,command:{action:'read'},status:200});
 let pulls=0,cancelled=false;
 const body=new ReadableStream<Uint8Array>({pull(controller){
  pulls++;controller.enqueue(new TextEncoder().encode(pulls===1?'--bounded\r\nContent-Disposition: form-data; name="scriptText"\r\n\r\n':'x'.repeat(1024*1024)));
  if(pulls===45){controller.enqueue(new TextEncoder().encode('\r\n--bounded--\r\n'));controller.close();}
 },cancel(){cancelled=true;}},{highWaterMark:0});
 assert.equal((await f.send(body,{'content-type':'multipart/form-data; boundary=bounded','content-length':'1'})).status,413);
 assert.equal(cancelled,true);assert.ok(pulls<=42);assert.equal(f.calls,0);
});
for(const route of routes){
 test(`${route.name}: browser Host is authoritative when Next rebuilds URL as localhost`,async()=>{
  const f=fixture(route),response=await f.send(undefined,{},'http://localhost:3008/test');
  assert.equal(response.status,route.status);assert.equal(f.calls,1);
 });
 test(`${route.name}: foreign origin, foreign port, malformed Host and missing Origin cannot mutate`,async()=>{
  const f=fixture(route);
  const cases:Record<string,string>[]=[{origin:'https://foreign.invalid'},{origin:'http://127.0.0.1:3007'},{host:'foreign.invalid',origin:'http://foreign.invalid'},{host:'127.0.0.1:3008/path'},{origin:''}];
  for(const headers of cases){
   assert.equal((await f.send(undefined,headers)).status,403);
  }
  assert.equal(f.calls,0);
 });
 test(`${route.name}: only exact JSON media type is accepted`,async()=>{
  const f=fixture(route);
  for(const contentType of ['application/jsonp','text/application/json','text/plain',''])assert.equal((await f.send(undefined,{'content-type':contentType})).status,415);
  assert.equal(f.calls,0);assert.equal((await f.send(undefined,{'content-type':'application/json; charset=utf-8'})).status,route.status);
 });
 test(`${route.name}: malformed JSON, non-object input and invalid UTF-8 report bad request`,async()=>{
  const f=fixture(route);
  for(const body of ['{bad','null','[]','"text"'])assert.equal((await f.send(body)).status,400);
  const prefix=new TextEncoder().encode(JSON.stringify({...route.command,note:'UTF8'}).replace('UTF8',''));
  const at=prefix.length-2,invalid=new Uint8Array([...prefix.slice(0,at),0xc3,0x28,...prefix.slice(at)]);
  assert.equal((await f.send(invalid)).status,400);assert.equal(f.calls,0);
 });
 test(`${route.name}: byte limit applies to multibyte JSON even with a false Content-Length`,async()=>{
  const f=fixture(route),body=JSON.stringify({...route.command,note:'甲'.repeat(Math.floor(route.limit/2))});
  assert.ok(body.length<route.limit);assert.ok(new TextEncoder().encode(body).length>route.limit);
  assert.equal((await f.send(body,{'content-length':'1'})).status,413);assert.equal(f.calls,0);
 });
 test(`${route.name}: oversized stream is cancelled before unbounded reading`,async()=>{
  const f=fixture(route);let pulls=0,cancelled=false;
  const body=new ReadableStream<Uint8Array>({pull(controller){
   pulls++;controller.enqueue(new TextEncoder().encode(pulls===1?'{"padding":"':'x'.repeat(route.limit)));
   if(pulls===12){controller.enqueue(new TextEncoder().encode('"}'));controller.close();}
  },cancel(){cancelled=true;}},{highWaterMark:0});
  assert.equal((await f.send(body)).status,413);assert.equal(cancelled,true);assert.ok(pulls<=3,`Consumed ${pulls} chunks despite the limit`);assert.equal(f.calls,0);
 });
 test(`${route.name}: auth boundary and valid Unicode/source text remain unchanged`,async()=>{
  const f=fixture(route),command={...route.command,actorId:'body-cannot-impersonate',note:'甲：台词\n（轻声）多：冒号'};
  assert.equal((await f.send(JSON.stringify(command))).status,route.status);assert.equal(f.calls,1);
  if(route.name==='workflow'||route.name==='direction'||route.name==='adoption')assert.deepEqual(f.received,command);
  if(route.name==='reception')assert.deepEqual(f.received,Object.fromEntries(Object.entries(command).filter(([key])=>key!=='action')));
  f.signOut();assert.equal((await f.send()).status,401);assert.equal(f.calls,1);
 });
}
