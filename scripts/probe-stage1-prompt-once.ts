/** One remaining local F2 comparison, using an already-authorized synthetic probe input. Never replays P1/Q1. */
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {buildSourceIndex} from '../lib/project-foundation-contracts';
import {scriptStructureTable} from '../lib/standard-script-reception';
import {buildLightFoundationPrompt} from '../lib/foundation-production-prompts';
import {requireProductionCatalogAuthor} from '../lib/foundation-production-contracts';
import {normalizeFoundationSceneRefWire} from '../lib/foundation-scene-ref-wire';
import {summarizeFoundationRunUsage} from '../lib/foundation-run-usage';

async function main() {
  const parent=resolve(process.argv[2]||''),read=(name:string)=>JSON.parse(readFileSync(join(parent,name),'utf8'));
  const manifest=read('manifest.json'),summary=read('summary.json'),previous=read('2-F2-request.json');
  if(manifest.schema!=='STAGE1_PROBE_V1'||manifest.live!==true||summary.count!==3||manifest.callLimit!==4)throw Error('Only the unused fourth-call allowance of a three-call synthetic probe is supported.');
  const input=JSON.parse(previous.taskPrompt.split('INPUT_JSON:\n')[1]);
  const index=buildSourceIndex(input.source.episodes.map((e:any)=>({number:e.number,title:e.title,content:e.lines.map((line:any[])=>line[1]).join('')})));
  const originalSource=JSON.stringify(input.source);
  const structure=scriptStructureTable(index,null,input.scope);
  if(structure.rows.length)input.scriptStructure=structure;else delete input.scriptStructure;
  const prompt=buildLightFoundationPrompt('F2',input),systemPrompt=previous.systemPrompt;
  const directory=join(parent,'final-prompt-local-check');mkdirSync(directory,{recursive:true,mode:0o700});
  const reservation=join(directory,'call-reserved.json');
  if(existsSync(reservation))throw Error('The fourth-call allowance has already been reserved; records are preserved and no automatic retry is allowed.');
  const save=(name:string,value:unknown)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2),{mode:0o600});
  const metadata={schema:'STAGE1_LOCAL_PROMPT_COMPARISON_V1',stage:'F2',sourceUnchanged:JSON.stringify(input.source)===originalSource,
    previousSentChars:previous.sentChars,sentChars:systemPrompt.length+prompt.length+28,thirdStageCalls:0,limit:1,contextProfile:'foundation-source'};
  save('request.json',{...metadata,systemPrompt,taskPrompt:prompt});
  if(!process.argv.includes('--live-once')){console.log(JSON.stringify({...metadata,status:'PREPARED_ONLY'}));return;}
  if(process.env.CODEX_CLI_MINIMAL_RUNTIME==='0')throw Error('The minimal context profile is explicitly disabled; no comparison call was sent.');
  writeFileSync(reservation,JSON.stringify({at:new Date().toISOString(),limit:1}),{flag:'wx',mode:0o600});
  process.env.DATABASE_URL=`file:${manifest.database}`;
  process.env.CODEX_CLI_TIMEOUT_MS='300000';
  const {runRoleByProvider}=await import('../lib/role-runner');
  const start=Date.now();let usage:unknown=null,requestOutcome='NOT_SENT';
  try {
    console.log(JSON.stringify({...metadata,event:'local_call_started'}));
    requestOutcome='UNKNOWN';
    const result=await runRoleByProvider({provider:'CLI',projectId:summary.projectId,sessionMode:'ephemeral',role:{code:'F2',skill:'',model:'gpt-5.6-terra',reasoningEffort:'medium',systemPrompt},prompt});
    requestOutcome='RESPONDED';
    usage=summarizeFoundationRunUsage({schema:'FOUNDATION_RUN_EVIDENCE_V1',calls:[{provider:'CLI',providerCallCount:1,requestOutcome:'RESPONDED',response:{stdout:result.stdout}}]});
    save('response.json',{data:result.data,rawOutput:result.rawOutput,usage});
    const catalog=requireProductionCatalogAuthor(normalizeFoundationSceneRefWire(result.data),index,input.scope);
    save('result.json',{...metadata,status:'MECHANICALLY_ACCEPTED',durationMs:Date.now()-start,usage,assets:catalog.assets.map(a=>({name:a.name,type:a.type,variants:a.variants.map(v=>v.name)})),semanticAcceptance:'REQUIRES_REVIEW',note:'Only F2 checked with final prompt. This is not a second full-pipeline measurement.'});
    console.log(JSON.stringify({event:'local_call_finished',directory,usage,durationMs:Date.now()-start}));
  } catch(error) {
    const e=error as Error&{requestOutcome?:string;stdout?:string};
    if(!usage&&e.stdout)usage=summarizeFoundationRunUsage({schema:'FOUNDATION_RUN_EVIDENCE_V1',calls:[{provider:'CLI',providerCallCount:1,requestOutcome:e.requestOutcome??'UNKNOWN',response:{stdout:e.stdout}}]});
    save('result.json',{...metadata,status:'FAILED',error:e.message,outcome:e.requestOutcome??requestOutcome,usage,durationMs:Date.now()-start});throw error;
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
