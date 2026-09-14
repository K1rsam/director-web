/** Real role runner and prompt loaders; provider boundaries throw unless intercepted. No DB/AI. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require=createRequire(import.meta.url);
const sentCli:Array<Record<string,unknown>>=[],sentApi:Array<Record<string,unknown>>=[];
const stub=(path:string,exports:unknown)=>{const id=require.resolve(path);require.cache[id]={id,filename:id,loaded:true,exports} as NodeModule;};
stub('../lib/codex-cli',{runCodexJson:async (input:Record<string,unknown>)=>{sentCli.push(input);return {data:{ok:true},sessionId:null,stdout:'{}',stderr:''};}});
stub('../lib/deepseek-api',{isFlashModel:()=>false,resolveApiOutputCap:()=>8000,runDeepSeekJson:async(input:Record<string,unknown>)=>{sentApi.push(input);return {data:{ok:true},stdout:'{}',stderr:''};}});
stub('../lib/pipeline-skills',{loadStageSkillText:async()=>assert.fail('explicit foundation system must not load an unrelated legacy skill')});
stub('../lib/provider-credentials',{getProjectDeepSeekCredential:async()=>assert.fail('offline test cannot read credentials')});
stub('../lib/prisma',{prisma:new Proxy({}, {get:()=>assert.fail('offline test cannot access DB')})});
stub('../lib/local-diagnostic-log',{recordLocalDiagnosticLog:()=>assert.fail('offline test cannot write diagnostics')});

async function main(){
 const {runCliRoleJson,runApiRoleJson}=require('../lib/role-runner') as typeof import('../lib/role-runner');
 const {loadFoundationSystemPrompt}=require('../lib/project-foundation-contracts') as typeof import('../lib/project-foundation-contracts');
 const {buildLightFoundationPrompt}=require('../lib/foundation-production-prompts') as typeof import('../lib/foundation-production-prompts');
 const {P1_REVIEW_PROMPT}=require('../lib/fidelity-p1-review') as typeof import('../lib/fidelity-p1-review');
 const delivery=readFileSync('lib/foundation-delivery.ts','utf8');
 const state=readFileSync('lib/foundation-state.ts','utf8');
 assert.ok(state.includes('loadFoundationSystemPrompt(stage.code)'));
 assert.ok(delivery.includes('systemPrompt: input.systemPrompts[stage]'));
 assert.ok(delivery.includes('const prompt = buildLightFoundationPrompt(stage, callInput)'));
 assert.ok(delivery.includes('${P1_REVIEW_PROMPT}'));
 const p1System=delivery.match(/const systemPrompt = fullReview \? '([^']+)'/)?.[1];assert.ok(p1System);
 const source='不可改写的原文。';
 for(const stage of ['F1','F2','Q1'] as const){
  const systemPrompt:string=stage==='F1'?p1System:loadFoundationSystemPrompt(stage);
  const input={scope:[23],source:[{number:23,content:source}],delivery:{mode:'REPAIR',targets:{episodes:[23]}}};
  const before=JSON.stringify(input);
  const prompt=stage==='F1'?`${P1_REVIEW_PROMPT}\nINPUT_JSON:\n${JSON.stringify({blocks:[['B1',source]]})}`:buildLightFoundationPrompt(stage,input);
  const role={code:stage,skill:'',systemPrompt,model:'offline-model',reasoningEffort:'low' as const};
  await runCliRoleJson({projectId:'offline',role,prompt,sessionMode:'ephemeral'});
  await runApiRoleJson({role,prompt,noSession:true});
  const cli=sentCli.at(-1)!,api=sentApi.at(-1)!;
  assert.equal(cli.prompt,`### 岗位规则（内嵌指令）\n\n${systemPrompt}\n\n### 当前任务\n\n${prompt}`);
  assert.equal(cli.instructionProfile,'foundation');assert.equal(cli.ephemeral,true);
  const messages=api.messages as Array<{role:string;content:string}>;
  assert.equal(messages.filter(message=>message.role==='system').length,1);
  assert.equal(messages[0].content,systemPrompt);assert.equal(messages.at(-1)!.content,prompt);
  assert.equal(api.retry,false,'inline foundation does not enable hidden provider retry');
  assert.equal(JSON.stringify(input),before);
  if(stage==='F1'){assert.ok(prompt.includes('assignments只列需要纠正的范围'));assert.ok(prompt.includes('同岗内部局部返修仍沿用这些判断规则'));}
  else {assert.ok(prompt.includes('只输出可执行结果'));assert.ok(prompt.includes('不得包装成humanChoices'));assert.ok(systemPrompt.includes('自检过程不输出'));assert.ok(systemPrompt.includes('同岗内部返修仍'));}
  if(stage==='Q1')for(const text of ['只发实际差异patch','APPLY_DECISION','delivery.targets','没有实际完成的事项不得给关闭回执'])assert.ok(systemPrompt.includes(text),text);
 }
 assert.equal(sentCli.length,3);assert.equal(sentApi.length,3);
 console.log('PASS P1/F2/Q1 real prompt loaders and CLI/API role runner: scoped actionable instructions reach intercepted provider requests; no DB/AI');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
