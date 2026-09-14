import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import type { FoundationStageRunner } from '@/lib/project-foundation';

async function main() {
 const reviewOnly = process.argv.includes('--review-only');
 const withP1 = reviewOnly || process.argv.includes('--review-source');
 const callLimit = reviewOnly ? 1 : withP1 ? 4 : 3;
 const directory=resolve('runtime-3008/live-evidence',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(directory,{recursive:true});
 const save=(name:string,data:unknown)=>writeFileSync(join(directory,name),JSON.stringify(data,null,2));
 const dbPath=join(directory,'isolated.db');const sqlite=new DatabaseSync(dbPath);
 for(const name of readdirSync('prisma/migrations').sort())if(/^\d/.test(name))sqlite.exec(readFileSync(join('prisma/migrations',name,'migration.sql'),'utf8'));sqlite.close();
 process.env.DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
 const db=new PrismaClient({datasourceUrl:process.env.DATABASE_URL});(globalThis as unknown as {prisma:PrismaClient}).prisma=db;
 const cli=await import('@/lib/codex-cli');const runner=await import('@/lib/role-runner');const core=await import('@/lib/project-foundation');
 let count=0;const stages=new Set<string>();const evidence:{stage:string;model:string;reasoning:string;inputChars:number;status:string;error?:string}[]=[];
 try {
  const preflight=await cli.assertCodexCliReady();
  save('preflight.json',{...preflight,apiKeyPresent:!!process.env.DEEPSEEK_API_KEY,credentialCount:0,provider:'CLI',callLimit,perStageInitialLimit:1,additionalLocalRepairLimit:1,maxOutputTokens:null,maxOutputNote:'现行CLI未设置输出token硬上限，保留现有偏好；应用预计输出预算为24000字符',timeoutMs:Number(process.env.CODEX_CLI_TIMEOUT_MS)||1800000,budget:core.FOUNDATION_REQUEST_BUDGET});
  const user=await db.user.create({data:{username:'isolated-role-acceptance',email:'isolated-role@example.invalid',name:'隔离岗位验收',passwordHash:'unused-isolated-account'}});
  const source='第一集\n1-1 仓库 内 夜\n张三的左臂被划伤，鲜血浸湿袖口。他把铜钥匙交给李四。\n张三：替我保管，明天还我。\n李四VO：我记住了。\n第二集\n2-1 仓库 内 日\n张三再次走进仓库，左臂伤口尚未愈合。李四把铜钥匙交还张三。\n张三：钥匙没有丢。';
  const {prepareFidelityImport}=await import('@/lib/fidelity-import');const {importParsedProject}=await import('@/lib/workflow');
  const prepared=await prepareFidelityImport('bounded-synthetic.txt',Buffer.from(source),'fidelity');
  if(withP1)prepared.receipt.p1Review={status:'PENDING'};
  if(!prepared.receipt.result.validation.ok)throw Error('合成源未通过保真验证');
  const {project}=await importParsedProject({ownerUserId:user.id,title:'隔离岗位流水线验收',sourceName:'bounded-synthetic.txt',executionMode:'CLI',fidelityReceipt:prepared.receipt},prepared.imported,db);
  save('source-receipt.json',prepared.receipt);
  const api=await import('@/lib/foundation-delivery');
  const stageRunner:FoundationStageRunner=async(stage,prompt,call)=>{
   if((stage!=='F2'&&stage!=='Q1'&&!(withP1&&stage==='F1'))||count>=callLimit||(stages.has(stage)&&!prompt.includes('allowedPaths')))throw Object.assign(Error('隔离验收调用上限：禁止额外全岗重跑或超过单次局部修复'),{requestOutcome:'NOT_SENT'});
   core.assertFoundationRequestBudget(call.role.systemPrompt??'',prompt);count++;stages.add(stage);
   const model=runner.resolveCliModel(stage,call.role.model),reasoning=runner.resolveCliReasoning(stage,call.role.reasoningEffort);
   if(model!=='gpt-6-astra'||reasoning!=='low')throw Error('验收只允许GPT6-low');const item={stage,model,reasoning,inputChars:(call.role.systemPrompt??'').length+prompt.length,status:'SENT'};evidence.push(item);
   save(`${count}-${stage}-request.json`,{model,reasoning,systemPrompt:call.role.systemPrompt,prompt,inputChars:item.inputChars,utf8Bytes:Buffer.byteLength((call.role.systemPrompt??'')+prompt),estimatedOutputChars:24000,maxOutputTokens:null});save('calls.json',evidence);
   try {const result=await runner.runRoleByProvider({provider:'CLI',projectId:project.id,role:call.role,prompt,sessionMode:'ephemeral'});item.status='RESPONDED';save(`${count}-${stage}-response.json`,result);save('calls.json',evidence);if(process.argv.includes('--inject-fault')&&stage==='F2'&&!prompt.includes('allowedPaths')){const injected=structuredClone(result);const data=injected.data as any;if(!Array.isArray(data.assets)||!data.assets.length)throw Error('无法进行可定位故障注入');data.assets[0].type='INVALID_TEST_KIND';injected.rawOutput=JSON.stringify(data);save('injected-fault.json',{purpose:'controller同岗局部修复验收，provider原响应另存',data});return injected;}return result;}
   catch(error){item.status='FAILED';save(`${count}-${stage}-error.json`,{message:error instanceof Error?error.message:String(error),...(error&&typeof error==='object'?error:{})});save('calls.json',evidence);throw error;}
  };
  const task=await api.queueFoundationDelivery(project.id,{},db);await api.executeFoundationDelivery(project.id,task.id,{db,stageRunner});
  const state=await api.getFoundationDeliveryState(project.id,db);save('final-state.json',state);save('summary.json',{projectId:project.id,count,calls:evidence,status:state.task?.status,complete:state.complete,documentReady:state.documentReady,blocker:state.continuationBlocker,issues:state.issues});
  const finalReceipt=await (await import('@/lib/fidelity-store')).readFidelityReceipt(project.id,db);
  save('final-receipt.json',finalReceipt?.receipt); if(!reviewOnly&&(!state.complete||finalReceipt?.receipt.result.source.text!==source))throw Error('岗位流水线未完成或保真不成立');
  if(reviewOnly && (count!==1 || evidence[0]?.stage!=='F1' || finalReceipt?.receipt.p1Review?.status!=='COMPLETE' || finalReceipt.receipt.result.source.text!==source))throw Error('真实P1检查未完成或原文发生变化');
  console.log(JSON.stringify({directory,count,calls:evidence,status:state.task?.status,complete:state.complete,documentReady:state.documentReady}));
 }catch(error){save('blocked.json',{count,calls:evidence,error:error instanceof Error?error.message:String(error)});console.log(JSON.stringify({directory,count,blocked:error instanceof Error?error.message:String(error)}));process.exitCode=1;}finally{await db.$disconnect();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1});





