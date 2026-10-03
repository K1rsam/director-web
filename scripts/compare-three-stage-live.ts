/** Backend comparison harness. Default is prepare-only. Never load .env or the production Prisma singleton. */
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire,registerHooks} from 'node:module';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import type {PrismaClient} from '@prisma/client';
import {PRODUCTION_CLI_MODEL,PRODUCTION_CLI_REASONING} from '../lib/production-model';
import {parseComparisonArgs,assertEpisodeGate,assertNoUnknownUsage,assertSharedSettings,inspectPayload,inspectWireRequest,sourceDifference,chooseComparisonAction,assertCampaignBinding,suppressGeneratedPrismaEnv,canCloseRecoveredStep,assertReview,hash,fail,isComparisonRunComplete,upstreamRequestFingerprint,captureUpstreamNativeUsage,planUpstreamUsageRecovery,storyboardUsageRecoveryEntry} from './compare-three-stage-support.mjs';

type Row=Record<string,any>;
const root=realpathSync(process.cwd());
const sourceRoot=path.resolve(root,'../director-web-stage1-20260909');
const sourceDb=path.join(sourceRoot,'prisma/dev.db');
const baselineHead='daad694d2027ad1aa4821ae4ab309d53fb1dbd0d';
const projectId='cmtxn9xo200a1s60am85hdl1v',snapshotId='cmtxn9xou00brs60ad8cafbnw';
const episodeIds={1:'cmtxn9xoc00a5s60as567alb2',2:'cmtxn9xoc00a7s60ac8nq9quv'};
const args=parseComparisonArgs(process.argv.slice(2));
const nativeRequire=createRequire(path.join(root,'package.json'));
let prismaEnvironmentGuardApplied=false;
const now=()=>new Date().toISOString();
const json=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
const serialize=(value:unknown)=>JSON.stringify(value,null,2);
const save=(file:string,value:unknown)=>{mkdirSync(path.dirname(file),{recursive:true,mode:0o700});writeFileSync(file,serialize(value),{flag:'wx',mode:0o600});};
const atomic=(file:string,value:unknown)=>{const temporary=`${file}.${randomUUID()}.tmp`;writeFileSync(temporary,serialize(value),{flag:'wx',mode:0o600});renameSync(temporary,file);};
const git=(cwd:string,...argv:string[])=>execFileSync('git',['-C',cwd,...argv],{encoding:'utf8',maxBuffer:4*1024*1024}).trim();

function verifyBaseline(){
 if(git(sourceRoot,'rev-parse','HEAD')!==baselineHead)fail('COMPARE_BASELINE_HEAD','3007 HEAD不是批准的固定版本。');
 if(git(sourceRoot,'status','--porcelain','--','runtime/storyboard-v4'))fail('COMPARE_BASELINE_DIRTY','3007 runtime存在未提交差异；不把它冒充固定HEAD。');
 const files=git(sourceRoot,'ls-files','runtime/storyboard-v4').split('\n').filter(Boolean).map(file=>({path:file,sha256:hash(readFileSync(path.join(sourceRoot,file)))}));
 return {root:sourceRoot,head:baselineHead,files,filesHash:hash(files)};
}

/** Deliberate query whitelist: no User, credentials, provider configuration or role-session reads. */
function readSource(){
 const db=new DatabaseSync(sourceDb,{readOnly:true});
 try{
  db.exec('BEGIN');
  const project=db.prepare('SELECT id,title,style,aspectRatio,executionMode FROM Project WHERE id=?').get(projectId) as Row;
  const episodes=db.prepare('SELECT id,projectId,number,title,content FROM Episode WHERE projectId=? ORDER BY number').all(projectId) as Row[];
  const row=db.prepare('SELECT id,projectId,sceneKey,content,metadata FROM SceneSnapshot WHERE id=? AND projectId=?').get(snapshotId,projectId) as Row;
  if(!project||project.title!=='神君'||episodes.length!==30||episodes.some((e,i)=>e.number!==i+1)||episodes[0]?.id!==episodeIds[1]||episodes[1]?.id!==episodeIds[2]||row?.sceneKey!=='SOURCE_IMPORT')fail('COMPARE_SOURCE_IDENTITY','源项目、30集或EP1/EP2身份不符。');
  const snapshot=JSON.parse(row.content);
  if(typeof snapshot.sourceText!=='string'||snapshot.originalFile?.encoding!=='base64'||typeof snapshot.originalFile.base64!=='string')fail('COMPARE_SOURCE_ARCHIVE','导入快照缺少可核验的原文或原上传字节。');
  const originalBytes=Buffer.from(snapshot.originalFile.base64,'base64');
  const evidence={database:sourceDb,projectId,snapshotId,readOnly:true,queriedTables:['Project','Episode','SceneSnapshot'],sourceName:snapshot.sourceName,sourceTextHash:hash(snapshot.sourceText),sourceChars:snapshot.sourceText.length,originalBytesHash:hash(originalBytes),originalBytes:originalBytes.length,
   snapshotContentHash:hash(row.content),episodes:episodes.map(({content,...episode})=>({...episode,chars:content.length,hash:hash(content)}))};
  db.exec('COMMIT');return {project,episodes,snapshot,originalBytes,evidence};
 }finally{db.close();}
}

function chooseDirectory(){
 if(path.basename(root)!=='director-web-3008'||process.versions.node.split('.')[0]!=='24')fail('COMPARE_ENVIRONMENT','请在director-web-3008目录使用专用Node24运行。');
 const parent=path.join(root,'runtime-3008/three-stage-comparison');
 for(const segment of [path.join(root,'runtime-3008'),parent])if(existsSync(segment)&&lstatSync(segment).isSymbolicLink())fail('COMPARE_PATH','隔离根不能是符号链接。');
 mkdirSync(parent,{recursive:true,mode:0o700});
 const registryFile=path.join(parent,'shenjun-campaign.json');
 if(existsSync(registryFile)&&lstatSync(registryFile).isSymbolicLink())fail('COMPARE_PATH','campaign登记不能是符号链接。');
 const registry=existsSync(registryFile)?json(registryFile):null;
 if(registry&&(registry.sourceProjectId!==projectId||registry.sourceSnapshotId!==snapshotId||registry.baselineHead!==baselineHead))fail('COMPARE_CAMPAIGN_EXISTS','已有campaign身份不同，不能自动替换或重置预算。');
 const requested=args.directory?path.resolve(root,args.directory):null;
 const selected=assertCampaignBinding(registry?.directory??null,requested);
 if(!selected&&readdirSync(parent).some(name=>existsSync(path.join(parent,name,'comparison.json'))))fail('COMPARE_CAMPAIGN_EXISTS','已有未登记对照；请用--directory明确绑定原目录，不能新建预算。');
 const directory=selected??mkdtempSync(path.join(parent,`shenj-${now().replace(/[:.]/g,'-')}-`));
 if(path.dirname(directory)!==parent||directory===parent)fail('COMPARE_PATH','directory必须是runtime-3008/three-stage-comparison下的独立一级目录。');
 if(!existsSync(directory)){if(args.mode!=='prepare')fail('COMPARE_PATH','续接目录不存在。');mkdirSync(directory,{mode:0o700});}
 if(realpathSync(directory)!==directory)fail('COMPARE_PATH','隔离目录不能经过符号链接。');
 if(!registry)save(registryFile,{schema:'THREE_STAGE_COMPARISON_CAMPAIGN_V1',directory,sourceProjectId:projectId,sourceSnapshotId:snapshotId,baselineHead,createdAt:now(),rule:'该来源对照只有此目录的一份40次/2M共享ledger；不得另开目录重置。'});
 return directory;
}

function claimDriver(directory:string){
 const file=path.join(directory,'driver.lock'),token=randomUUID();
 if(existsSync(file)){
  const prior=json(file);
  if(args.mode!=='recover'||prior.host!==hostname()||!Number.isSafeInteger(prior.pid))fail('COMPARE_DRIVER_BUSY','驱动有未核对的锁；不可重复派单，可显式--recover核对。');
  try{process.kill(prior.pid,0);fail('COMPARE_DRIVER_BUSY','原驱动仍存活，不能接管。');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  renameSync(file,path.join(directory,`driver.stale-${randomUUID()}.lock`));
 }
 save(file,{pid:process.pid,host:hostname(),token,at:now()});
 return ()=>{if(existsSync(file)&&json(file).token===token)unlinkSync(file);};
}

function roots(directory:string){return {database:path.join(directory,'isolated.db'),workflows:path.join(directory,'workflows'),budgets:path.join(directory,'budgets'),modern:path.join(directory,'3008-storyboards'),baseline:path.join(directory,'3007-storyboards'),archive:path.join(directory,'empty-legacy-archive')};}
function isolate(directory:string){
 const dirs=roots(directory);
 for(const candidate of Object.values(dirs))if(existsSync(candidate)&&realpathSync(candidate)!==candidate)fail('COMPARE_PATH','隔离数据子目录不能是符号链接。');
 process.env.DATABASE_URL=`file:${dirs.database}`;
 process.env.DIRECTOR_PRODUCTION_WORKFLOW_DIR=dirs.workflows;
 process.env.DIRECTOR_PRODUCTION_BUDGET_DIR=dirs.budgets;
 process.env.DIRECTOR_STORYBOARD_DATA_DIR=dirs.modern;
 process.env.DIRECTOR_STORYBOARD_ARCHIVE_DIR=dirs.archive;
 // An inherited production budget must never leak into the disposable comparison.
 delete process.env.DIRECTOR_PRODUCTION_BUDGET_ID;
 // server-only is an app bundling marker; this executable is itself the isolated server process.
 registerHooks({
  resolve(specifier,context,nextResolve){return nextResolve(specifier==='server-only'?'next/dist/compiled/server-only/empty.js':specifier,context);},
  load(url,context,nextLoad){
   const loaded=nextLoad(url,context);
   // Prisma's generated client otherwise discovers .env even with an explicit datasourceUrl.
   // Scope this in-memory loader to this executable; never edit node_modules or open the .env.
   if(url.startsWith('file:')&&fileURLToPath(url)===path.join(root,'node_modules/.prisma/client/index.js')){const source=suppressGeneratedPrismaEnv(loaded.source?Buffer.from(loaded.source as Uint8Array).toString('utf8'):readFileSync(fileURLToPath(url),'utf8'));prismaEnvironmentGuardApplied=true;return {...loaded,source};}
   return loaded;
  }
 });
 globalThis.fetch=async()=>{throw new Error('COMPARE_HTTP_FORBIDDEN: this harness only authorizes scoped CLI calls; no Jev/API/HTTP.');};
 return dirs;
}

async function openDatabase(directory:string,initialize:boolean){
 const dirs=isolate(directory);
 if(initialize){
  if(existsSync(dirs.database))fail('COMPARE_DB_EXISTS','不覆盖已有隔离数据库。');
  const sqlite=new DatabaseSync(dirs.database);
  try{for(const name of readdirSync(path.join(root,'prisma/migrations')).sort())if(/^\d/.test(name))sqlite.exec(readFileSync(path.join(root,'prisma/migrations',name,'migration.sql'),'utf8'));}finally{sqlite.close();}
 }
 if(!existsSync(dirs.database)||lstatSync(dirs.database).isSymbolicLink()||realpathSync(dirs.database)!==dirs.database)fail('COMPARE_DB_SCOPE','隔离DB不存在或路径异常。');
 const {PrismaClient:Client}=await import('@prisma/client');
 if(!prismaEnvironmentGuardApplied)fail('COMPARE_PRISMA_ENV','隔离Prisma环境文件禁读保护未生效，未打开数据库。');
 const db=new Client({datasourceUrl:`file:${dirs.database}`});
 (globalThis as unknown as {prisma:PrismaClient}).prisma=db;
 await assertDatabase(db,directory);
 if((await import('../lib/prisma')).prisma!==db)fail('COMPARE_GLOBAL_DB','模块未使用指定隔离Prisma，停止。');
 return db;
}
async function assertDatabase(db:PrismaClient,directory:string){
 const entries=await db.$queryRawUnsafe<Array<{name:string;file:string}>>('PRAGMA database_list');
 if(path.resolve(entries.find(e=>e.name==='main')?.file??'')!==roots(directory).database)fail('COMPARE_DB_SCOPE','数据库连接不在本次隔离目录。');
}

function commonSettings(visualStyle:string){return {model:PRODUCTION_CLI_MODEL,reasoning:PRODUCTION_CLI_REASONING,maxUnitSeconds:30,maxUnits:null,fantasyMode:'recommended',visualStyle};}
function targetCode(){
 const entries=['lib/production-workflow.ts','lib/role-runner.ts','lib/storyboard-service.ts','runtime/production-workflow.mjs','runtime/production-budget.mjs','runtime/storyboard-v4/input.mjs','runtime/storyboard-v4/coordinator.mjs','runtime/storyboard-v4/core/core.mjs','runtime/storyboard-v4/core/pipeline.mjs'];
 return {head:git(root,'rev-parse','HEAD'),files:entries.map(file=>({path:file,sha256:hash(readFileSync(path.join(root,file)))}))};
}

async function initialize(directory:string,db:PrismaClient,source:ReturnType<typeof readSource>,baseline:Row){
 const user=await db.user.create({data:{username:'isolated-three-stage-comparison',email:'three-stage-comparison@example.invalid',name:'隔离对照执行者',passwordHash:'unused-no-login-isolated-account'}});
 const {prepareFidelityImport}=await import('../lib/fidelity-import');
 const {importParsedProject}=await import('../lib/workflow');
 const prepared=await prepareFidelityImport(source.snapshot.sourceName,source.originalBytes,'fidelity');
 if(prepared.imported.sourceText!==source.snapshot.sourceText)fail('COMPARE_ORIGINAL_READING_CHANGED','重读原DOCX与源快照不一致，未继续导入或猜测正文。');
 prepared.receipt.p1Review={status:'PENDING'};
 const imported=await importParsedProject({ownerUserId:user.id,title:'神君 · 隔离三阶段同稿对照',style:source.project.style,aspectRatio:source.project.aspectRatio,executionMode:'CLI',sourceName:source.snapshot.sourceName,fidelityReceipt:prepared.receipt},prepared.imported,db);
 const id=randomUUID(),budgetId=`compare-${id}`,baselineProjectId=`baseline-${id}`;
 const baselineInput=nativeRequire(path.join(sourceRoot,'runtime/storyboard-v4/input.mjs'));
 const preview=baselineInput.makeEpisodeInput({episode:source.episodes[0],project:source.project});
 const state:Row={schema:'THREE_STAGE_COMPARISON_V1',id,createdAt:now(),directory,sourceEvidence:source.evidence,baseline,targetCodeAtPreparation:targetCode(),actorId:user.id,targetProjectId:imported.project.id,baselineProjectId,budgetId,
  sharedSettings:commonSettings(preview.visualStyle),workflowId:null,baselineRuns:{},rawBindings:{},qualityReview:null,activeStep:null,journal:[]};
 save(path.join(directory,'source/source-evidence.json'),source.evidence);
 save(path.join(directory,'source/source-snapshot.json'),source.snapshot);
 save(path.join(directory,'source/original-episodes.json'),source.episodes);
 writeFileSync(path.join(directory,'source/original.docx'),source.originalBytes,{flag:'wx',mode:0o600});
 writeFileSync(path.join(directory,'source/reading.txt'),source.snapshot.sourceText,{flag:'wx',mode:0o600});
 save(path.join(directory,'source/import-receipt.json'),prepared.receipt);
 const {createProductionBudgetStore}=nativeRequire(path.join(root,'runtime/production-budget.mjs'));
 await createProductionBudgetStore(roots(directory).budgets).create(budgetId,{projectIds:[imported.project.id,baselineProjectId],maxCalls:40,maxTokens:2_000_000});
 atomic(path.join(directory,'comparison.json'),state);
 return state;
}

async function buildServices(directory:string,db:PrismaClient,state:Row){
 const [foundation,inputs,direction,assets,adoptions,episodes,storyboard,role,budget,workflow,cli]=await Promise.all([
  import('../lib/foundation-delivery'),import('../lib/foundation-state'),import('../lib/series-direction-service'),import('../lib/asset-prompt-service'),import('../lib/asset-design-adoption'),import('../lib/production-episodes'),import('../lib/storyboard-service'),import('../lib/role-runner'),import('../lib/production-budget'),import('../lib/production-workflow'),import('../lib/codex-cli')]);
 const saveState=()=>atomic(path.join(directory,'comparison.json'),state);
 const roleRunner:typeof role.runRoleByProvider=async request=>{
  if(args.mode==='replay')fail('COMPARE_REPLAY_NO_PROVIDER','仅免费重验已有来源响应；未发送任何新的模型请求。');
  if(args.mode!=='live'||!state.activeStep)fail('COMPARE_PREPARE_ONLY','准备或只读模式禁止模型调用。');
  await assertDatabase(db,directory);
  if(request.provider!=='CLI'||request.projectId!==state.targetProjectId)fail('COMPARE_PROVIDER_SCOPE','仅允许隔离项目既有CLI岗位，不允许API/Jev。');
  const key=`upstream-${randomUUID()}`,started=Date.now(),systemPrompt=request.role.systemPrompt;
  const sentPrompt=systemPrompt===undefined?request.prompt:`### 岗位规则（内嵌指令）\n\n${systemPrompt}\n\n### 当前任务\n\n${request.prompt}`;
  const payload={projectId:request.projectId,stage:request.role.code,provider:'CLI',model:role.resolveCliModel(request.role.code,request.role.model),reasoning:role.resolveCliReasoning(request.role.code,request.role.reasoningEffort),sessionMode:request.sessionMode??'fresh',schema:null,systemPrompt:systemPrompt??null,taskPrompt:request.prompt,sentPrompt,
   instructionProfile:request.sessionMode==='ephemeral'&&systemPrompt?.trim()?['F1','F2','Q1'].includes(request.role.code)?'foundation-source':['A15','A15_A','B15_B','A15_D'].includes(request.role.code)?'foundation':null:null};
  const ledgerBefore=await budget.productionBudgetStore(roots(directory).budgets).read(state.budgetId);
  const requestRecord={at:now(),actionId:state.activeStep.id,payload},requestFingerprint=upstreamRequestFingerprint(key,requestRecord);
  save(path.join(directory,'requests',`${key}.json`),{...requestRecord,requestFingerprint,metrics:inspectWireRequest({prompt:sentPrompt}),promptSegments:{systemChars:systemPrompt?.length??0,taskChars:request.prompt.length,framingChars:sentPrompt.length-request.prompt.length-(systemPrompt?.length??0)},note:'sentPrompt复现runCliRoleJson输入；instructionProfile对应既有CLI附加规则，未复制凭据或宿主配置。角色字段副本不计入发送体积。'});
  let outcome:Row;
  try{
   const result=await role.runRoleByProvider(request); // Existing role service reserves the SAME ledger. Do not wrap twice.
   outcome={status:'RESPONDED',...captureUpstreamNativeUsage(result),data:result.data,rawOutput:result.rawOutput??null};
   return result;
  }catch(error){const e=error as Row;outcome={status:e.requestOutcome??'UNKNOWN',...captureUpstreamNativeUsage(e),error:{code:e.code??null,message:String(e.message??error).slice(0,1200)},rawOutput:e.rawOutput??null};throw error;}
  finally{const after=await budget.productionBudgetStore(roots(directory).budgets).read(state.budgetId);const beforeIds=new Set(ledgerBefore.attempts.map((a:Row)=>a.id));save(path.join(directory,'responses',`${key}.json`),{...outcome!,schema:'THREE_STAGE_UPSTREAM_RESPONSE_V1',budgetId:state.budgetId,requestFingerprint,usageProvenance:'ROLE_RUNNER_NATIVE_SUMMARY_V1',ledgerAttemptIds:after.attempts.filter((a:Row)=>!beforeIds.has(a.id)).map((a:Row)=>a.id),durationMs:Date.now()-started,finishedAt:now(),note:'仅最终岗位正文、原生turn.completed用量字段及其事件hash；不保存stdout reasoning事件。'});}
 };
 const services:any={
  readInputs:workflow.readProductionWorkflowInputs,readStage1:foundation.getFoundationDeliveryState,readDirection:direction.getSeriesDirectionWorkspace,readScope:episodes.readProductionScope,readAssets:assets.loadAssetPromptWorkspace,planAssets:assets.planEpisodeAssetProduction,readAdoptions:adoptions.readAssetDesignAdoptions,
  queueStage1:foundation.queueFoundationDelivery,executeStage1:foundation.executeFoundationDelivery,
  generateDirection:(p:string,a:string,c:any,o:any)=>direction.generateSeriesDirectionCandidate(p,a,c,o),generateAssets:assets.generateAssetPromptsForEpisodes,
  episode:(p:string,n:number)=>db.episode.findFirst({where:{projectId:p,number:n},include:{project:true}}),
  createStoryboard:async(episode:Row,command:Row)=>{
   await freezeRaw(episode.number);
   const run=await storyboard.createStoryboardRun(episode,{...command,settings:state.sharedSettings,maxCalls:40,maxTokens:2_000_000});
   assertSharedSettings(run.settings,state.sharedSettings);return run;
  },
  readStoryboard:(id:string)=>storyboard.storyboardService().read(id),storyboardView:(run:Row,episode:Row)=>storyboard.storyboardRunView(run,episode,undefined,false),
  // Stop after each actual request, so the first author response is inspected
  // before buying further author packages or episode finishing on either side.
  startStoryboard:async(id:string)=>{const run=await storyboard.storyboardService().read(id);assertSharedSettings(run.settings,state.sharedSettings);await freezeRaw(run.web.binding.episodeNumber);return storyboard.storyboardService().start(id,{mode:'next'});},
  pauseStoryboard:(id:string)=>storyboard.storyboardService().pause(id),refreshChain:async(p:string)=>storyboard.refreshProductionChain(p),runRole:roleRunner,
 };
 const runtime=nativeRequire(path.join(root,'runtime/production-workflow.mjs'));
 const adapter=workflow.createProductionWorkflowAdapters(state.actorId,services);
 const api=runtime.createProductionWorkflowService({directory:roots(directory).workflows,budgetDirectory:roots(directory).budgets,adapters:adapter});
 async function episodePair(number:number){
  const episode=await services.episode(state.targetProjectId,number),previous=number>1?await services.episode(state.targetProjectId,number-1):null;
  if(!episode||number>1&&!previous)fail('COMPARE_EPISODE','隔离标准稿尚未形成所需本集/上集原文。');
  return {episode,previous};
 }
 async function freezeRaw(number:number){
  const pair=await episodePair(number),binding={rawHash:hash(pair.episode.content),previousRawHash:pair.previous?hash(pair.previous.content):null};
  if(state.rawBindings[number]&&hash(state.rawBindings[number])!==hash(binding))fail('COMPARE_RAW_CHANGED','一侧已开始后共同原文发生改变；保留旧稿，不偷换对照基线。');
  if(!state.rawBindings[number]){state.rawBindings[number]=binding;save(path.join(directory,'shared-raw',`ep${number}.json`),{episode:pair.episode,previous:pair.previous,binding});saveState();}
  return pair;
 }
 async function baselineInput(number:number){
  const pair=await episodePair(number);
  // Same post-stage1 raw, but only the fixed baseline's original parser and previous-source protocol.
  const project={...pair.episode.project,id:state.baselineProjectId};
  const episode={...pair.episode,projectId:state.baselineProjectId};
  const handoff={readiness:'SOURCE_ONLY',reasons:['同稿对照：只提供本集和必要上一集原文；不使用3008方向/标准包/资产卡。'],packet:{sourceText:episode.content,assets:[],scenes:[],boundaryContext:{previousSource:pair.previous?{episode:pair.previous.number,text:pair.previous.content,sourceRefs:[`same-raw-ep${pair.previous.number}`]}:null,priorStates:[],gaps:[]}}};
  return {episode,prepared:nativeRequire(path.join(sourceRoot,'runtime/storyboard-v4/input.mjs')).makeEpisodeInput({episode,project,handoff})};
 }
 const baseline=nativeRequire(path.join(sourceRoot,'runtime/storyboard-v4/coordinator.mjs')).createCoordinator({dataRoot:roots(directory).baseline,maxConcurrent:4,executable:cli.resolveCodexExecutable(),
  beforeExecute:async(binding:Row)=>{verifyBaseline();await freezeRaw(binding.episodeNumber);return (await baselineInput(binding.episodeNumber)).prepared.sourceVersion===binding.sourceVersion;},
  modelRunner:async(request:Row,options:Row)=>{
   if(args.mode!=='live'||!state.activeStep)fail('COMPARE_PREPARE_ONLY','准备或只读模式禁止模型调用。');
   assertSharedSettings(state.sharedSettings,{...state.sharedSettings,model:PRODUCTION_CLI_MODEL,reasoning:PRODUCTION_CLI_REASONING});
   assertSharedSettings(request.settings,state.sharedSettings);
   const runtimeBudget=nativeRequire(path.join(root,'runtime/production-budget.mjs'));
   const started=Date.now();
   save(path.join(directory,'requests',`3007-${options.attemptId}.json`),{at:now(),actionId:state.activeStep.id,request,metrics:inspectWireRequest(request)});
   try{return await runtimeBudget.withProductionBudget({directory:roots(directory).budgets,id:state.budgetId,projectId:state.baselineProjectId,stage:`3007:${request.stage}`,provider:'CLI',model:state.sharedSettings.model,runId:options.runId,attemptId:options.attemptId},()=>nativeRequire(path.join(sourceRoot,'runtime/storyboard-v4/core/runner.mjs')).runModel(request,options));}
   finally{save(path.join(directory,'responses',`3007-${options.attemptId}-timing.json`),{durationMs:Date.now()-started,finishedAt:now(),nativeReceipt:path.join(roots(directory).baseline,'attempts',options.attemptId,'receipt.json')});}
  }});
 return {api,services,adapter,storyboard,baseline,baselineInput,episodePair,freezeRaw,saveState,budget:budget.productionBudgetStore(roots(directory).budgets),direction,foundation};
}

function completeRun(run:Row|null,chainComplete=true){
 const complete=isComparisonRunComplete(run,{chainComplete});
 return {runId:run?.id??null,complete,fingerprint:run?hash({assembly:run.assembly??null,adopted:run.adopted??[],sourceBasisVersion:run.web?.binding?.sourceBasisVersion??run.web?.binding?.sourceVersion,production:run.production??null}):null,status:run?.status??'NOT_STARTED'};
}

function attemptMetrics(directory:string){
 const records:Row[]=[];
 for(const side of ['3007','3008']){
  const base=side==='3007'?roots(directory).baseline:roots(directory).modern,attemptRoot=path.join(base,'attempts');
  if(!existsSync(attemptRoot))continue;
  for(const id of readdirSync(attemptRoot).sort()){
   const requestFile=path.join(attemptRoot,id,'request.json'),receiptFile=path.join(attemptRoot,id,'receipt.json');
   if(!existsSync(requestFile))continue;const request=json(requestFile),receipt=existsSync(receiptFile)?json(receiptFile):null;
   records.push({side,attemptId:id,stage:request.stage,packageIds:request.packageIds,model:request.settings?.model,reasoning:request.settings?.reasoning,requestFile,receiptFile:receipt?receiptFile:null,
    requestHash:hash(readFileSync(requestFile)),inputHash:request.inputHash,promptHash:request.promptHash,metrics:inspectWireRequest(request),
    receipt:receipt?{state:receipt.state,requestOutcome:receipt.requestOutcome,responseDisposition:receipt.responseDisposition,usage:receipt.usage??null,durationMs:receipt.durationMs??null,errorCode:receipt.errorCode??null}:null});
  }
 }
 return records;
}

async function snapshot(directory:string,state:Row,kit:Awaited<ReturnType<typeof buildServices>>,label:string){
 const view=await kit.api.inspect(state.workflowId),at=now(),folder=path.join(directory,'snapshots',`${at.replace(/[:.]/g,'-')}-${label}-${randomUUID().slice(0,8)}`);
 const first:Row={};const sides:Row={};
 for(const number of [1,2]){
  const modernId=view.workflow.selectedRuns[number],oldId=state.baselineRuns[number];
  const modern=modernId?await kit.storyboard.storyboardService().read(modernId):null;
  const old=oldId?await kit.baseline.read(oldId):null;
  sides[number]={'3007':completeRun(old),'3008':completeRun(modern,modern?kit.storyboard.storyboardChainComplete(modern):false)};
  if(number===1)Object.assign(first,sides[number]);
  for(const [side,run] of [['3007',old],['3008',modern]] as const)if(run){save(path.join(folder,`ep${number}-${side}-run.json`),run);if(run.assembly?.text)writeFileSync(path.join(folder,`ep${number}-${side}-final.md`),run.assembly.text,{flag:'wx',mode:0o600});}
  try{
   const {episode,previous}=await kit.episodePair(number),baseline=await kit.baselineInput(number),prepared=await kit.storyboard.loadStoryboardInput(episode);
   if(episode.content!==baseline.episode.content)fail('COMPARE_RAW_MISMATCH','双侧本集raw不一致。');
   const original=json(path.join(directory,'source/original-episodes.json')).find((e:Row)=>e.number===number);
   save(path.join(folder,`ep${number}-input-comparison.json`),{rawHash:hash(episode.content),previousRawHash:previous?hash(previous.content):null,originalToCurrent:sourceDifference(original.content,episode.content),sharedSettings:state.sharedSettings,
    baseline:{source:baseline.prepared.source,sourceVersion:baseline.prepared.sourceVersion,diagnostics:baseline.prepared.source.diagnostics??[],metrics:inspectPayload(baseline.prepared.source)},
    modern:{...prepared,metrics:inspectPayload(prepared.source)},
    materialDifferences:{baselineProtocol:'daad694d makeEpisodeInput / parseScript with current raw + previousSource only',baselineExcluded:['SCRIPT_STANDARD_V1','seriesDirection','seriesKnowledge','assetProductionCards','adoptedDesign','candidateDesign','selectedActualPreviousStoryboard'],modernProtocol:'canonical loadStoryboardInput / production upstream handoff',note:'输入差异是待比较变量，不作净Token节省或质量提升结论。'}});
  }catch(error){const e=error as Row;save(path.join(folder,`ep${number}-input-unavailable.json`),{code:e.code??null,message:String(e.message??error).slice(0,1500)});}
 }
 const ledger=await kit.budget.read(state.budgetId);
 const attempts=attemptMetrics(directory);save(path.join(folder,'actual-request-metrics.json'),attempts);
 const roleResponses=existsSync(path.join(directory,'responses'))?readdirSync(path.join(directory,'responses')).filter(name=>/^upstream-.+\.json$/.test(name)).map(name=>({file:path.join(directory,'responses',name),...json(path.join(directory,'responses',name))})):[];
 const callStatistics={budgetCalls:ledger.summary.calls,knownTokens:ledger.summary.knownTokens,unknownAttempts:ledger.summary.unknownAttempts,inFlight:ledger.summary.inFlight,
  observedProviderDurationMs:attempts.reduce((n,a)=>n+(a.receipt?.durationMs??0),0)+roleResponses.reduce((n,r)=>n+(r.durationMs??0),0),
  elapsedWallMs:Date.now()-Date.parse(state.createdAt),nativeAttemptCount:attempts.length,roleResponseCount:roleResponses.length,
  byStage:Object.fromEntries([...new Set(ledger.attempts.map((a:Row)=>`${a.projectId===state.baselineProjectId?'3007':'3008'}:${a.stage}`))].map(key=>{const rows=ledger.attempts.filter((a:Row)=>`${a.projectId===state.baselineProjectId?'3007':'3008'}:${a.stage}`===key);return [key,{calls:rows.length,statuses:rows.map((a:Row)=>({attemptId:a.id,status:a.status,totalTokens:a.totalTokens}))}];})),
  note:'duration来自已有原生receipt/角色调用计时；未知项不填0，observed总和不是完整计费时长。账本summary包含reconciliation，stage明细保留原始UNKNOWN历史。'};
 const summary={at,folder,mode:args.mode,sourceEvidence:state.sourceEvidence,baselineHead,environmentGuard:{prismaEnvFileDiscoveryDisabled:prismaEnvironmentGuardApplied,httpForbidden:true,explicitDatabase:roots(directory).database},state:state.activeStep?{activeStep:state.activeStep}:null,workflow:view,ledger,sides,
  callStatistics,
  providerCalls:ledger.summary.calls,knownTokens:ledger.summary.knownTokens,unknownAttempts:ledger.summary.unknownAttempts,targetCode:targetCode(),qualityReview:state.qualityReview,
  note:'结构/状态证据，不代表真实模型质量、成片或用户认可。'};
 save(path.join(folder,'summary.json'),summary);atomic(path.join(directory,'latest-summary.json'),summary);
 console.log(JSON.stringify({event:label,directory,nextAction:view.nextAction,providerCalls:ledger.summary.calls,knownTokens:ledger.summary.knownTokens,unknownAttempts:ledger.summary.unknownAttempts,keyDesignGate:view.keyDesignGate,firstEpisodes:first}));
 return {view,ledger,first,folder};
}

async function liveStep(directory:string,state:Row,kit:Awaited<ReturnType<typeof buildServices>>){
 if(args.mode==='live')assertSharedSettings(state.sharedSettings,{...state.sharedSettings,model:PRODUCTION_CLI_MODEL,reasoning:PRODUCTION_CLI_REASONING});
 if(state.activeStep)fail('COMPARE_STEP_UNRESOLVED','已有动作未落定；先--recover读取原回执，不自动重发。');
 const before=await snapshot(directory,state,kit,'before-live-step');assertNoUnknownUsage(before.ledger);
 const step=args.step!,match=/^(3007|3008)-ep([12])$/.exec(step),episode=match?Number(match[2]):null;
 if(episode)assertEpisodeGate(episode,before.first,state.qualityReview);
 const planned=step.startsWith('3007')?{kind:'BASELINE',episodeNumber:episode}:chooseComparisonAction(step,before.view.nextAction,{costAcknowledged:true});
 if(planned.kind.startsWith('WAIT_')||['QUALITY_CHECK','NEED_UPSTREAM','COMPLETE'].includes(planned.kind))return;
 if(args.mode==='replay'&&planned.kind!=='STAGE1')fail('COMPARE_REPLAY_STAGE1','免费来源重验只允许当前第一阶段动作，不推进方向、资产或分镜。');
 if(planned.kind==='BASELINE'&&!before.view.readiness.stage1?.ready)fail('COMPARE_STAGE1_REQUIRED','旧版同稿对照需先完成隔离第一阶段，不能抢用未定稿原文。');
 const record={id:randomUUID(),step,planned,...(args.mode==='replay'?{executionMode:'SAVED_SOURCE_REPLAY_ONLY'}:{}),...(episode?{dispatchMode:'next'}:{}),startedAt:now(),status:'RUNNING',baselineHead,targetCode:targetCode(),ledgerBefore:before.ledger.summary};
 state.activeStep=record;state.journal.push(record);kit.saveState();
 try{
  if(planned.kind==='BASELINE'){
   await kit.freezeRaw(episode!);const {episode:row,prepared}=await kit.baselineInput(episode!);
   if(prepared.source.diagnostics?.length)fail('SOURCE_DIAGNOSTICS','3007原生解析有未解决源文诊断；不为对照绕过旧版创建检查。');
   let runId=state.baselineRuns[episode!];
   if(!runId){
    const voice=nativeRequire(path.join(sourceRoot,'runtime/storyboard-v4/voice.mjs'));
    const voiceReference=await voice.measureVoiceReference(prepared.source,{cacheRoot:path.join(roots(directory).baseline,'voice-cache')});
    prepared.source.context.sourceWarnings.push(...voiceReference.warnings);
    const run=await kit.baseline.create({source:prepared.source,voiceReference,title:`同稿3007 · EP${episode}`,settings:state.sharedSettings,binding:{projectId:state.baselineProjectId,episodeId:row.id,episodeNumber:episode,sourceVersion:prepared.sourceVersion},budget:{maxCalls:40,maxTokens:2_000_000}});
    runId=run.id;state.baselineRuns[episode!]=runId;(record as Row).runId=runId;kit.saveState();
   }
   assertSharedSettings((await kit.baseline.read(runId)).settings,state.sharedSettings);
   await kit.baseline.start(runId,{mode:'next'});await kit.baseline.wait(runId);
  }else{
   const view=await kit.api.advance(state.workflowId,{expectedRevision:before.view.workflow.revision,costAcknowledged:true,actorId:state.actorId});
   const runId=episode?view.workflow.selectedRuns[episode]:null;
   if(runId){(record as Row).runId=runId;kit.saveState();await kit.storyboard.storyboardService().wait(runId);}
   if(view.workflow.activeAction)fail('COMPARE_WORKFLOW_INTERRUPTED','工作流动作未落定；保留原记录，先恢复。');
  }
  const ledger=await kit.budget.read(state.budgetId);assertNoUnknownUsage(ledger);
  if(args.mode==='replay'&&hash(ledger.attempts)!==hash(before.ledger.attempts))fail('COMPARE_REPLAY_DISPATCHED','免费重验不应新增或修改预算派单，停止核查。');
  Object.assign(record,{status:'SETTLED',finishedAt:now(),ledgerAfter:ledger.summary});state.activeStep=null;kit.saveState();
 }catch(error){const e=error as Row;Object.assign(record,{status:'INTERRUPTED',finishedAt:now(),error:{code:e.code??null,message:String(e.message??error).slice(0,1500),requestOutcome:e.requestOutcome??'UNKNOWN'}});kit.saveState();throw error;}
 finally{await snapshot(directory,state,kit,'after-live-step');}
}

async function recover(directory:string,state:Row,kit:Awaited<ReturnType<typeof buildServices>>){
 // Free recovery only. Never acknowledge unknown usage or reset a run automatically.
 const responseRoot=path.join(directory,'responses');
 const upstreamRecords=existsSync(responseRoot)?readdirSync(responseRoot).filter(name=>/^upstream-[A-Za-z0-9_-]+\.json$/.test(name)).map(name=>{
  const requestFile=path.join(directory,'requests',name);
  return {id:name.slice(0,-5),request:existsSync(requestFile)?json(requestFile):null,response:json(path.join(responseRoot,name))};
 }):[];
 const upstreamPlan=planUpstreamUsageRecovery({records:upstreamRecords,ledger:await kit.budget.read(state.budgetId),projectId:state.targetProjectId,actionIds:state.journal.filter((row:Row)=>row.step==='upstream').map((row:Row)=>row.id)});
 for(const entry of upstreamPlan.entries)await kit.budget.reconcile(state.budgetId,entry.attemptId,entry);
 if(upstreamRecords.length)save(path.join(directory,'recovery',`upstream-usage-${randomUUID()}.json`),{at:now(),...upstreamPlan,note:'免费原生用量对账；歧义、缺证据或未知保留，不拆分同一usage。'});
 let view=await kit.api.inspect(state.workflowId);
 if(view.workflow.activeAction)view=await kit.api.recover(state.workflowId,{expectedRevision:view.workflow.revision,actorId:state.actorId});
 const recoveredRuns=new Map<string,Row>();
 for(const [side,ids] of [['3007',Object.values(state.baselineRuns)],['3008',Object.values(view.workflow.selectedRuns)]] as const)for(const id of ids as string[]){
  const service=side==='3007'?kit.baseline:kit.storyboard.storyboardService(),run=await service.read(id);
  for(const op of run.operations??[])if(['running','unknown'].includes(op.status))try{await service.recover(id,op.attemptId);}catch(error){const e=error as Row;save(path.join(directory,'recovery',`${randomUUID()}.json`),{side,runId:id,attemptId:op.attemptId,code:e.code??null,message:String(e.message??error).slice(0,1200)});}
  recoveredRuns.set(id,await service.read(id));
 }
 // Reconcile only verified native runtime receipts; the original UNKNOWN entry stays immutable.
 const ledger=await kit.budget.read(state.budgetId);
 for(const attempt of ledger.attempts){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(attempt.id)||!recoveredRuns.has(attempt.runId))continue;
  const base=attempt.projectId===state.baselineProjectId?roots(directory).baseline:roots(directory).modern;
  const file=path.join(base,'attempts',attempt.id,'receipt.json'),requestFile=path.join(base,'attempts',attempt.id,'request.json');if(!existsSync(file)||!existsSync(requestFile))continue;
  const entry=storyboardUsageRecoveryEntry({attempt,request:json(requestFile),receipt:json(file),run:recoveredRuns.get(attempt.runId)});
  if(entry)await kit.budget.reconcile(state.budgetId,attempt.id,entry);
 }
 const after=await snapshot(directory,state,kit,'recovery');
 const runs:Row[]=[];
 for(const id of Object.values(state.baselineRuns) as string[])runs.push(await kit.baseline.read(id));
 for(const id of Object.values(after.view.workflow.selectedRuns) as string[])runs.push(await kit.storyboard.storyboardService().read(id));
 if(state.activeStep&&canCloseRecoveredStep({ledger:after.ledger,workflow:after.view.workflow,runs})){
  state.journal.push({id:randomUUID(),kind:'FREE_RECOVERY',recoveredActionId:state.activeStep.id,status:'RECOVERED',recoveredAt:now(),ledger:after.ledger.summary});state.activeStep=null;kit.saveState();
 }
}

async function main(){
 const baseline=verifyBaseline(),source=readSource(),directory=chooseDirectory(),release=claimDriver(directory);
 let db:PrismaClient|null=null,kit:Awaited<ReturnType<typeof buildServices>>|null=null;
 try{
  const file=path.join(directory,'comparison.json'),fresh=!existsSync(file);
  if(fresh&&args.mode!=='prepare')fail('COMPARE_NOT_PREPARED','目录未完成准备，不能执行真实动作。');
  db=await openDatabase(directory,fresh);
  const state:Row=fresh?await initialize(directory,db,source,baseline):json(file);
  if(state.schema!=='THREE_STAGE_COMPARISON_V1'||state.directory!==directory||hash(state.sourceEvidence)!==hash(source.evidence)||state.baseline.filesHash!==baseline.filesHash)fail('COMPARE_SOURCE_CHANGED','原件或固定基线与准备快照不一致；保留旧对照，不偷换来源。');
  kit=await buildServices(directory,db,state);
  if(!state.workflowId){
   const view=await kit.api.create({projectId:state.targetProjectId,actorId:state.actorId,episodeNumbers:[1,2],mode:'CHAIN',criticalAssetKeys:[],requestedAssetKeys:[],budgetId:state.budgetId,costAcknowledged:false});
   state.workflowId=view.workflow.id;kit.saveState();
  }
  if(args.mode==='live'||args.mode==='replay')await liveStep(directory,state,kit);
  else if(args.mode==='recover')await recover(directory,state,kit);
  else if(args.mode==='review'){
   const current=await snapshot(directory,state,kit,'before-review'),review=json(path.resolve(args.reviewFile!));assertReview(review,current.first);
   if(state.activeStep)fail('COMPARE_STEP_UNRESOLVED','先恢复未落定动作，再记录复核。');
   await kit.api.recordQualityReview(state.workflowId,{expectedRevision:current.view.workflow.revision,actorId:state.actorId,runId:current.first['3008'].runId,authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true,note:review.note});
   save(path.join(directory,'reviews',`${randomUUID()}.json`),review);state.qualityReview=review;kit.saveState();await snapshot(directory,state,kit,'review-recorded');
  }else{
   const result=await snapshot(directory,state,kit,args.mode==='prepare'?'prepared-only':'status');
   if(fresh&&result.ledger.summary.calls!==0)fail('COMPARE_PREPARE_DISPATCHED','准备模式出现派单，必须停止核查。');
  }
  if(hash(readSource().evidence)!==hash(source.evidence))fail('COMPARE_SOURCE_CHANGED_DURING_RUN','原件在本次操作期间发生变化；结果保留，停止续接。');
 }catch(error){const e=error as Row;save(path.join(directory,`blocked-${randomUUID()}.json`),{at:now(),code:e.code??null,message:String(e.message??error).slice(0,2000),requestOutcome:e.requestOutcome??'NOT_SENT'});console.error(JSON.stringify({event:'comparison_blocked',directory,code:e.code??null,message:String(e.message??error).slice(0,2000)}));process.exitCode=1;}
 finally{if(kit){await kit.baseline.shutdown();await kit.storyboard.storyboardService().shutdown();}await db?.$disconnect();release();}
}
void main().catch(error=>{console.error(JSON.stringify({event:'comparison_setup_blocked',code:(error as Row).code??null,message:String((error as Error).message??error).slice(0,1200)}));process.exitCode=1;});
