import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runModel,readAttemptEvidence} from './runner.mjs';
import {digest} from './shared.mjs';
import {createProductionBudgetStore,withProductionBudget} from '../../production-budget.mjs';

const emptyUsage={inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const schema=object({key:{type:'string',pattern:'^[A-Z]+$'}});
const request={stage:'author',prompt:'本地 schema 准入回归',instructions:'输出 JSON',settings:{model:'gpt-6.1-sol',reasoning:'medium'},inputHash:'schema-admission-fixture',promptHash:digest('本地 schema 准入回归'),schema,schemaHash:digest(schema)};
const rejection={type:'error',status:400,error:{message:'Invalid JSON schema: regex lookaround is not supported.',type:'invalid_request_error',param:'text.format.schema',code:'invalid_json_schema'}};
const serialized=JSON.stringify(rejection);
const emit=value=>`emit(${JSON.stringify(value)});`;
const rejected=(payload=rejection,raw=false)=>[emit(raw?{type:'error',message:JSON.stringify(payload)}:payload),emit(raw?{type:'turn.failed',error:{message:JSON.stringify(payload)}}:{...payload,type:'turn.failed'})].join('\n');
async function fixture(t,body,{schema:overrideSchema=schema,budget=false,...options}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'v4-schema-admission-')),attemptId='admission',script=path.join(directory,'fake-cli.mjs');
 t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(script,`import {writeFile,readFile} from 'node:fs/promises';\nfor await(const _ of process.stdin){}\nawait writeFile(new URL('./spawned',import.meta.url),'yes');\nconst emit=e=>process.stdout.write(JSON.stringify(e)+'\\n');\n${body}`);
 let result,error,ledger=null;
 const context={directory:path.join(directory,'budget'),id:'ledger',attemptId,projectId:'synthetic-project',stage:'stage3:author',provider:'CLI',model:request.settings.model};
 if(budget){ledger=createProductionBudgetStore(context.directory);await ledger.create(context.id,{projectIds:[context.projectId],maxCalls:2,maxTokens:100});}
 try{result=await withProductionBudget(budget?context:null,()=>runModel({...request,schema:overrideSchema,schemaHash:digest(overrideSchema)},{directory,attemptId,executable:process.execPath,executableArgs:[script],timeoutMs:2500,startupTimeoutMs:1500,idleTimeoutMs:1000,...options}));}catch(e){error=e;}
 const evidence=await readAttemptEvidence({directory,attemptId});
 return {directory,result,error,ledger,context,...evidence,spawned:await readFile(path.join(directory,'spawned'),'utf8').then(()=>true,()=>false)};
}
const success=`emit({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}});emit({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}});`;

test('nested lookaround is rejected locally before CLI launch with immutable schema evidence and no invented usage',async t=>{
 const bad=object({entry:{type:'array',items:{anyOf:[object({key:{type:'string',pattern:'^(?!reserved$).+$'}})]}}});
 const f=await fixture(t,success,{schema:bad});
 assert.equal(f.error?.code,'SCHEMA_ADMISSION_REJECTED');assert.equal(f.error.requestOutcome,'NOT_SENT');assert.equal(f.spawned,false);
 assert.deepEqual(f.error.usage,emptyUsage);assert.deepEqual(f.receipt.usage,emptyUsage);assert.equal(f.receipt.localProcess,null);
 assert.equal(f.receipt.admission.source,'local_schema_preflight');assert.equal(f.receipt.admission.requestSent,false);assert.equal(f.receipt.admission.inferenceStarted,false);
 assert.equal(f.receipt.admission.schemaHash,digest(bad));assert.match(f.receipt.admission.schemaPath,/entry.*items.*anyOf.*key.*pattern/);
 const saved=JSON.parse(await readFile(path.join(f.directory,'attempts/admission/request.json'),'utf8'));assert.deepEqual(saved.schema,bad);
});

test('all lookaround directions and regex backreferences fail preflight, including definitions',async t=>{
 for(const pattern of ['(?=x)x','(?!x)y','(?<=x)y','(?<!x)y',String.raw`(x)\1`,String.raw`(?<x>x)\k<x>`]){
  const f=await fixture(t,success,{schema:{...object({key:{$ref:'#/$defs/value'}}),$defs:{value:{type:'string',pattern}}}});
  assert.equal(f.error?.code,'SCHEMA_ADMISSION_REJECTED',pattern);assert.equal(f.spawned,false,pattern);assert.equal(f.error.requestOutcome,'NOT_SENT');
 }
});

test('compatible patterns and lookaround-looking literals are delivered unmodified',async t=>{
 const valid={...object({key:{type:'string',pattern:String.raw`^\(\?=literal\)$`},mark:{type:'string',pattern:'^[()?!]+$'},choice:{type:'string',pattern:'^(?:A|B)+$'}}),description:'Literal prose (?=example) is not a regex constraint',examples:[{pattern:'(?=example)'}]};
 const f=await fixture(t,`const args=process.argv.slice(2),file=args[args.indexOf('--output-schema')+1];const delivered=JSON.parse(await readFile(file,'utf8'));emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({delivered})}});emit({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}});`,{schema:valid});
 assert.equal(f.error,undefined);assert.deepEqual(f.result.output.delivered,valid);assert.equal(f.receipt.admission,undefined);assert.equal(f.receipt.requestOutcome,'RESPONDED');
});

for(const raw of [false,true])test(`typed invalid-json-schema admission rejection settles after native close (${raw?'nested raw JSON':'typed event'})`,async t=>{
 const f=await fixture(t,[emit({type:'thread.started',thread_id:'synthetic-native-thread'}),emit({type:'item.completed',item:{id:'warning-0',type:'error',message:'local startup warning'}}),emit({type:'turn.started'}),rejected(rejection,raw),'setTimeout(()=>{},3000);'].join('\n'));
 assert.equal(f.error?.code,'SCHEMA_ADMISSION_REJECTED');assert.equal(f.error.requestOutcome,'NOT_SENT');assert.equal(f.receipt.requestOutcome,'NOT_SENT');
 assert.deepEqual(f.error.usage,emptyUsage);assert.deepEqual(f.receipt.usage,emptyUsage);assert.equal(f.hasResponseBody,false);assert.equal(f.receipt.responseDisposition,'none');
 assert.equal(f.receipt.localProcess.closeObserved,true);assert.equal(f.receipt.admission.source,'cli_schema_validation');
 assert.equal(f.receipt.admission.requestSent,true);assert.equal(f.receipt.admission.inferenceStarted,false);assert.equal(f.receipt.admission.status,400);
 assert.equal(f.receipt.admission.code,'invalid_json_schema');assert.equal(f.receipt.admission.param,'text.format.schema');assert.equal(f.receipt.admission.schemaHash,request.schemaHash);
 assert.match(f.receipt.admission.evidenceHash,/^[a-f0-9]{64}$/);assert.deepEqual(f.error.admission,f.receipt.admission);
});

test('generic HTTP failures, untyped prose and incomplete typed tuples remain UNKNOWN',async t=>{
 for(const payload of [
  {...rejection,status:500},
  {...rejection,error:{...rejection.error,code:'bad_request'}},
  {...rejection,error:{...rejection.error,type:'server_error'}},
  {...rejection,error:{...rejection.error,param:'input'}},
  {...rejection,usage:{input_tokens:1,output_tokens:0}},
  {...rejection,response:{id:'prior-response'}},
  {...rejection,usage:null},
  {...rejection,output:[]},
  {...rejection,error:{...rejection.error,details:{usage:null}}},
  {...rejection,error:{...rejection.error,message:JSON.stringify({output:'possible-content'})}},
  {type:'error',status:400,error:{message:'Invalid JSON schema: regex lookaround is not supported.'}},
  {type:'error',message:'400 invalid_json_schema text.format.schema'}
 ]){
  const f=await fixture(t,rejected(payload,true));assert.equal(f.error?.code,'CLI_FAILED');assert.equal(f.error.requestOutcome,'UNKNOWN');assert.equal(f.receipt.requestOutcome,'UNKNOWN');assert.equal(f.receipt.admission,undefined);assert.deepEqual(f.receipt.usage,emptyUsage);
 }
});

test('inference activity or a conflicting error prevents admission from clearing unknown usage',async t=>{
 for(const preceding of [
  {type:'item.started',item:{type:'reasoning',text:''}},
  {type:'item.completed',item:{type:'reasoning',text:'PRIVATE_REASONING_MUST_NOT_ENTER_PROOF'}},
  {type:'item.completed',item:{type:'agent_message',text:'{"partial":true}'}},
  {type:'item.completed',item:{type:'command_execution',command:'synthetic command'}},
  {type:'item.completed',item:{message:'unclassified item'}},
  {type:'turn.completed'},
  {...rejection,type:'turn.failed'},
  {type:'error',message:'connection reset'},
  {type:'turn.started'}
 ]){
  const f=await fixture(t,[emit({type:'turn.started'}),emit(preceding),rejected(rejection,true)].join('\n'));
  assert.equal(f.error?.code,'CLI_FAILED');assert.equal(f.error.requestOutcome,'UNKNOWN');assert.equal(f.receipt.admission,undefined);
  assert.ok(!JSON.stringify(f.receipt).includes('PRIVATE_REASONING_MUST_NOT_ENTER_PROOF'));
 }
});

test('a paid completed body and native usage survive a later schema rejection',async t=>{
 const f=await fixture(t,success+'\n'+rejected(rejection,true));assert.equal(f.error?.code,'CLI_FAILED');assert.equal(f.error.requestOutcome,'RESPONDED');assert.equal(f.receipt.usage.totalTokens,3);assert.equal(f.receipt.admission,undefined);assert.equal(f.hasResponseBody,true);
});

test('review reproductions never settle mixed outer or item evidence as a free admission',async t=>{
 for(const [name,events]of [
  ['item usage',[{type:'thread.started'},{type:'item.completed',item:{type:'error',message:'local startup warning',usage:{input_tokens:1,output_tokens:1}}},{type:'turn.started'},{type:'error',message:serialized},{type:'turn.failed',error:{message:serialized}}]],
  ['outer response',[{type:'error',message:serialized},{type:'turn.failed',error:{message:serialized},response:{id:'possible-paid-response'}}]],
  ['outer output',[{type:'error',message:serialized},{type:'turn.failed',error:{message:serialized},output:[{text:'possible-paid-content'}]}]],
  ['thread response',[{type:'thread.started',response:{output_text:'possible-paid-content'}},{type:'error',message:serialized},{type:'turn.failed',error:{message:serialized}}]],
  ['turn item',[{type:'turn.started',item:{type:'reasoning',text:''}},{type:'error',message:serialized},{type:'turn.failed',error:{message:serialized}}]]
 ])await t.test(name,async t=>{
  const f=await fixture(t,events.map(emit).join('\n'),{budget:true});
  assert.equal(f.error?.code,'CLI_FAILED');assert.equal(f.error.requestOutcome,'UNKNOWN');assert.equal(f.receipt.admission,undefined);assert.deepEqual(f.receipt.usage,emptyUsage);
  const ledger=await f.ledger.read('ledger');assert.equal(ledger.attempts[0].status,'UNKNOWN');assert.equal(ledger.attempts[0].totalTokens,null);assert.equal(ledger.summary.unknownAttempts,1);
 });
});

test('unknown fields or encoded content and late warnings cannot prove startup-only activity',async t=>{
 const warning={type:'item.completed',item:{type:'error',message:'local startup warning'}};
 const mixed=[
  {...warning,usage:null},
  {...warning,content:'possible-content'},
  {...warning,item:{...warning.item,id:1}},
  {...warning,item:{...warning.item,text:'possible-content'}},
  {...warning,item:{...warning.item,body:'possible-content'}},
  {...warning,item:{...warning.item,extra:{usage:null}}},
  {...warning,item:{...warning.item,message:JSON.stringify({usage:{input_tokens:1}})}},
  {type:'turn.started',response:{id:'possible-response'}},
  {type:'thread.started',content:'possible-content'}
 ];
 for(const event of mixed){
  const f=await fixture(t,[emit({type:'thread.started'}),emit(event),rejected(rejection,true)].join('\n'));
  assert.equal(f.error?.code,'CLI_FAILED');assert.equal(f.error.requestOutcome,'UNKNOWN');assert.equal(f.receipt.admission,undefined);
 }
 for(const prefix of [[{type:'thread.started'},{type:'turn.started'},warning],[{type:'error',message:serialized},{type:'turn.failed',error:{message:serialized}},warning]]){
  const f=await fixture(t,prefix.map(emit).join('\n')+'\n'+(prefix[0].type==='thread.started'?rejected(rejection,true):''));
  assert.equal(f.error?.code,'CLI_FAILED');assert.equal(f.error.requestOutcome,'UNKNOWN');assert.equal(f.receipt.admission,undefined);
 }
});

test('a schema-shaped error without a terminal failure cannot turn timeout into NOT_SENT',async t=>{
 const f=await fixture(t,emit({type:'error',message:serialized})+'setInterval(()=>{},1000);',{timeoutMs:350,startupTimeoutMs:250,idleTimeoutMs:200});
 assert.equal(f.error?.code,'TIMEOUT');assert.equal(f.error.requestOutcome,'UNKNOWN');assert.equal(f.receipt.admission,undefined);assert.deepEqual(f.receipt.usage,emptyUsage);
});

test('typed rejection without observed native close remains UNKNOWN',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t,`import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setTimeout(()=>{},6000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]});
await writeFile(new URL('./owned-child-pid',import.meta.url),String(child.pid));
${rejected(rejection,true)}
setTimeout(()=>{},6000);`);
 const pid=Number(await readFile(path.join(f.directory,'owned-child-pid'),'utf8'));t.after(()=>{try{process.kill(pid,'SIGKILL');}catch{}});
 assert.equal(f.error?.code,'CLI_FAILED');assert.equal(f.error.requestOutcome,'UNKNOWN');assert.equal(f.receipt.localProcess.closeObserved,false);assert.equal(f.receipt.admission,undefined);assert.deepEqual(f.receipt.usage,emptyUsage);
});

test('temporary shared accounting preserves native null usage and blocks every unproved failure',async t=>{
 const admission=await fixture(t,rejected(rejection,true),{budget:true}),settled=await admission.ledger.read('ledger');
 assert.equal(settled.attempts[0].status,'NOT_SENT');assert.equal(settled.attempts[0].totalTokens,0,'accounting zero is based only on admission proof, not invented native usage');
 assert.equal(settled.summary.calls,1,'rejected attempt still occupies its existing call slot');assert.equal(settled.summary.unknownAttempts,0);assert.deepEqual(admission.receipt.usage,emptyUsage);
 const unknown=await fixture(t,rejected({...rejection,error:{...rejection.error,code:'bad_request'}},true),{budget:true}),blocked=await unknown.ledger.read('ledger');
 assert.equal(blocked.attempts[0].status,'UNKNOWN');assert.equal(blocked.attempts[0].totalTokens,null);assert.equal(blocked.summary.unknownAttempts,1);
 await assert.rejects(unknown.ledger.reserve('ledger',{...unknown.context,attemptId:'must-not-dispatch'}),{code:'PRODUCTION_USAGE_UNKNOWN'});
 assert.deepEqual(unknown.receipt.usage,emptyUsage);
});
