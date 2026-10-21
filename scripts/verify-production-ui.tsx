/** Real browser + real components; every HTTP request is intercepted, no DB/server/model. */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const record={schema:'PRODUCTION_WORKFLOW_V1',id:'flow',projectId:'fixture',actorId:'actor',mode:'CHAIN',episodeNumbers:[1,2],criticalAssetKeys:[],requestedAssetKeys:[],budgetId:'shared',sourceVersion:'source',revision:3,selectionRevision:0,selectedRuns:{},qualityReviews:[],receipts:[],activeAction:null,status:'READY',paused:false,costAcknowledged:false,createdAt:'2026-10-01T01:00:00Z',updatedAt:'2026-10-01T01:00:00Z'};
const snapshot=()=>({workflow:structuredClone(record),keyDesignGate:'NOT_SPECIFIED',readiness:{sourceVersion:'source',standard:{ready:true,issues:[]},stage1:{ready:true,busy:false},direction:{status:'CANDIDATE',hasCandidate:true,pending:false},assets:{missingCandidateKeys:[],missingCriticalKeys:[],busy:false},sourceConflicts:[],technicalIssues:[],keyDesignGate:'NOT_SPECIFIED'},nextAction:{kind:'WAIT_DIRECTION_CONFIRM',owner:'USER',message:'全剧方向候选已备好，等待用户明确确认。'},budget:{id:'shared',projectIds:['fixture'],maxCalls:40,maxTokens:2000000,paused:false,summary:{calls:6,knownTokens:12000,unknownAttempts:1,inFlight:0,complete:false}}});
async function main(){
 const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{ProductionWorkspace}from'./app/projects/[projectId]/production/workspace';createRoot(document.getElementById('root')).render(<ProductionWorkspace projectId="fixture" episodes={(window as any).__productionEpisodes??[{id:'e0',number:0,title:'正篇零集'},{id:'e1',number:1,title:'开场'},{id:'e2',number:2,title:'接续'},{id:'e3',number:3,title:'未来'}]} assets={[{key:'door',name:'仓库门',episodes:[1],mode:'REFERENCE'},{key:'palace',name:'未来宫殿',episodes:[3],mode:'REFERENCE'}]}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'})});
 async function fixture(existing=false,episodeCount=0){
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1200,height:900}}),page=await context.newPage();page.setDefaultTimeout(3000);
  const state={value:snapshot() as any,list:existing?[record]:[],posts:[] as any[],errors:[] as string[],failNext:false};
  page.on('pageerror',e=>state.errors.push(e.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!=='http://production.test'){state.errors.push(`Unexpected ${url.origin}`);return route.abort();}
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta charset="UTF-8"><div id="root"></div>'});
   if(url.pathname==='/api/projects/fixture/production-workflow'){
    if(route.request().method()==='POST'){
     const command=route.request().postDataJSON();state.posts.push(command);
     if(state.failNext){state.failNext=false;return route.fulfill({status:409,json:{code:'WORKFLOW_CONFLICT',error:'流程已更新，请刷新后再操作。'}});}
     if(command.action==='create'){state.value.workflow={...state.value.workflow,...command,id:'flow',revision:4};state.list=[state.value.workflow];}
     else if(command.action==='advance'){state.value.workflow={...state.value.workflow,revision:state.value.workflow.revision+1,status:'RUNNING',activeAction:{kind:'STORYBOARD_CREATE'}};state.value.nextAction={kind:'WAIT_RUNNING',owner:'EXECUTOR',message:'已有动作已登记，请查看实际状态。'};}
     else if(command.action==='quality-review'){state.value.workflow.revision++;state.value.nextAction={kind:'COMPLETE',owner:'EXECUTOR',message:'选集文字交付完成；不是成片或用户验收。'};}
     else if(command.action==='configure-delivery'){state.value.workflow.revision++;state.value.workflow.delivery={version:'production-delivery-v1',enabled:command.enabled};}
     else if(command.action==='boundary-evidence'){state.value.boundaryEvidence={runId:command.runId,evidenceHash:'e'.repeat(64),sources:{previous:'完整前源',current:'完整后源'}};}
     else if(command.action==='boundary-review'){state.value.workflow.revision++;delete state.value.boundaryEvidence;}
     else if(command.action==='export-delivery'){state.value.workflow.revision++;state.value.workflow.delivery={...state.value.workflow.delivery,result:{identity:'d'.repeat(64),directory:'/server-owned/private-deliveries/'+ 'x'.repeat(150)}};}
     else if(command.action==='configure-parallel'){state.value.workflow.revision++;state.value.workflow.parallel={version:'production-parallel-v1',enabled:false,executionTier:command.executionTier??'standard',modelSelection:command.modelSelection??{version:'production-model-selection-v1',model:'gpt-6.1-sol',reasoning:'medium'},lanes:[[1,2],[3,4],[5,6],[7,8]]};state.value.parallel={...state.value.workflow.parallel,maxConcurrent:4,activeEpisodes:0,completedEpisodes:1,provisionalEpisodes:0,qualityReviewPending:true,status:'CONFIGURED',lanes:[[1,2],[3,4],[5,6],[7,8]].map(([from,to],index)=>({index,from,to,episodeNumber:from,completedEpisodes:0,provisionalEpisodes:0,nextAction:{kind:'STORYBOARD_CREATE',episodeNumber:from}}))};}
     else if(command.action==='start-parallel'){state.value.workflow.revision++;Object.assign(state.value.workflow.parallel,{enabled:true,authorizedAt:'synthetic-authorization',executionTier:command.executionTier,modelSelection:command.modelSelection});state.value.workflow.paused=false;state.value.workflow.costAcknowledged=true;Object.assign(state.value.parallel,{enabled:true,executionTier:command.executionTier,modelSelection:command.modelSelection,activeEpisodes:4,status:'RUNNING'});for(const lane of state.value.parallel.lanes){lane.nextAction={kind:'WAIT_STORYBOARD',episodeNumber:lane.from,runId:`r${lane.from}`};lane.run={busy:true,inFlight:1,queued:0,stage:'author',executionPhase:'generating'};}}
     else if(command.action==='pause'){state.value.workflow.revision++;state.value.workflow.paused=true;if(state.value.parallel){state.value.workflow.parallel.enabled=false;state.value.parallel.enabled=false;state.value.parallel.status='PAUSING';}state.value.nextAction={kind:'WAIT_PAUSED'};}
     return route.fulfill({json:state.value});
    }
    return route.fulfill({json:url.searchParams.get('workflowId')?state.value:{workflows:state.list}});
   }
   state.errors.push(`Unexpected ${url.pathname}`);return route.abort();
  });
  const open=async()=>{await page.goto('http://production.test/');if(episodeCount)await page.evaluate(n=>{(window as any).__productionEpisodes=Array.from({length:n},(_,i)=>({id:`e${i+1}`,number:i+1,title:'合成测试'}));},episodeCount);await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text});await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text});await page.getByRole('button',{name:'刷新闭环状态',exact:true}).waitFor();};
  return {page,state,open,close:()=>context.close()};
 }
 try{
  const large=await fixture(false,501);try{
   await large.open();await large.page.getByLabel('制作方式',{exact:true}).selectOption('CHAIN');await large.page.getByLabel('开始集',{exact:true}).selectOption('1');await large.page.getByLabel('结束集',{exact:true}).selectOption('501');
   await large.page.getByRole('alert').filter({hasText:'一轮最多选择500集'}).waitFor();assert.equal(await large.page.getByRole('button',{name:'创建选集流程',exact:true}).isDisabled(),true);assert.deepEqual(large.state.posts,[]);assert.deepEqual(large.state.errors,[]);
   await large.page.getByLabel('结束集',{exact:true}).selectOption('80');assert.match(await large.page.getByLabel('使用共享预算',{exact:true}).innerText(),/480条记录 \/ 36,000,000 Token/);
   await large.page.getByRole('button',{name:'创建选集流程',exact:true}).click();await large.page.getByRole('region',{name:'当前下一步',exact:true}).waitFor();
   assert.equal(large.state.posts[0].episodeNumbers.length,80);assert.equal(large.state.posts[0].maxCalls,480);assert.equal(large.state.posts[0].maxTokens,36000000);assert.equal(large.state.posts[0].costAcknowledged,false);assert.deepEqual(large.state.errors,[]);
   console.log('PASS 501-episode selection stays usable, eighty-episode budget is explicit and matches the request; no paid start');
  }finally{await large.close();}
  const lanes=await fixture(true);try{
   lanes.state.value.budget.summary.unknownAttempts=0;
   await lanes.open();await lanes.page.getByRole('button',{name:'保存四路安排 · 不调用AI',exact:true}).waitFor();assert.equal(await lanes.page.getByRole('button',{name:'保存四路安排 · 不调用AI',exact:true}).count(),1,'缺少免费四路配置入口');
   assert.deepEqual(lanes.state.posts,[]);await lanes.page.getByRole('button',{name:'保存四路安排 · 不调用AI',exact:true}).click();
   await lanes.page.getByRole('region',{name:'四路连续制作',exact:true}).waitFor();
   assert.equal(lanes.state.posts[0].action,'configure-parallel');
   assert.equal(await lanes.page.getByLabel('四路新任务模型',{exact:true}).inputValue(),'gpt-6.1-sol');
   assert.equal(await lanes.page.getByLabel('四路推理档位',{exact:true}).inputValue(),'medium');
   assert.equal(await lanes.page.getByLabel('Fast 加速',{exact:true}).isChecked(),false);
   const start=lanes.page.getByRole('button',{name:'一键四路连续制作',exact:true});assert.equal(await start.isDisabled(),true);
   assert.equal(await lanes.page.locator('[data-production-lane]').count(),4);
   await lanes.page.getByLabel('四路新任务模型',{exact:true}).selectOption('gpt-6-astra');
   await lanes.page.getByLabel('四路推理档位',{exact:true}).selectOption('high');
   await lanes.page.getByLabel('允许本轮四路制作的模型调用',{exact:true}).check();await start.click();
   await lanes.page.getByText('正在制作 4 集 / 最多4集',{exact:true}).waitFor();
   assert.deepEqual(lanes.state.posts[1],{action:'start-parallel',workflowId:'flow',expectedRevision:4,costAcknowledged:true,executionTier:'standard',modelSelection:{version:'production-model-selection-v1',model:'gpt-6-astra',reasoning:'high'}});
   assert.equal(await lanes.page.locator('[data-production-lane][data-workflow-state="running"]').count(),4);
   assert.equal(await lanes.page.getByRole('button',{name:/推进一次/}).count(),0,'启用四路后不再给重复手工派单入口');
   assert.match(await lanes.page.getByRole('region',{name:'四路连续制作',exact:true}).innerText(),/首集质量复核尚未记录/);
   assert.equal(await lanes.page.getByLabel('四路新任务模型',{exact:true}).isDisabled(),true);
   await lanes.page.evaluate(()=>window.dispatchEvent(new Event('online')));
   await lanes.page.getByText('已重新连接原四路；只接续已授权的未完成步骤。',{exact:true}).waitFor();
   assert.deepEqual(lanes.state.posts.at(-1),{action:'reconnect-parallel',workflowId:'flow',expectedAuthorization:'synthetic-authorization'});
   await lanes.page.getByRole('button',{name:'统一暂停 · 保留在途回包',exact:true}).click();
   await lanes.page.getByText(/后续派单已暂停；仍有4集在途/).waitFor();
   const pausedPosts=lanes.state.posts.length;
   await lanes.page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('pageshow'));});
   await lanes.page.waitForTimeout(60);assert.equal(lanes.state.posts.length,pausedPosts,'wake cannot restart an intentional pause');
   assert.equal(await lanes.page.getByRole('button',{name:'继续原四路制作',exact:true}).isDisabled(),false,'explicit resume reuses the saved consent, no repeated checkbox');
   await lanes.page.getByRole('button',{name:'继续原四路制作',exact:true}).click();
   await lanes.page.getByText('正在制作 4 集 / 最多4集',{exact:true}).waitFor();
   await lanes.page.setViewportSize({width:390,height:844});assert.ok(await lanes.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
   assert.deepEqual(lanes.state.errors,[]);console.log('PASS model/effort choice, standard default, original-authorization wake reconnect, graceful pause/resume, genuine activity cards and narrow layout');
  }finally{await lanes.close();}
  const fast=await fixture(true);try{
   fast.state.value.budget.summary.unknownAttempts=0;await fast.open();await fast.page.getByRole('button',{name:'保存四路安排 · 不调用AI',exact:true}).click();
   await fast.page.getByLabel('允许本轮四路制作的模型调用',{exact:true}).check();
   await fast.page.getByLabel('Fast 加速',{exact:true}).check();
   assert.equal(await fast.page.getByLabel('允许四路制作及Fast额度消耗',{exact:true}).isChecked(),false,'changing the cost profile invalidates the earlier checkbox');
   assert.equal(await fast.page.getByRole('button',{name:'一键四路连续制作',exact:true}).isDisabled(),true);
   await fast.page.getByLabel('允许四路制作及Fast额度消耗',{exact:true}).check();await fast.page.getByRole('button',{name:'一键四路连续制作',exact:true}).click();
   await fast.page.getByText('正在制作 4 集 / 最多4集',{exact:true}).waitFor();
   assert.equal(fast.state.posts.at(-1).fastAcknowledged,true);assert.equal(fast.state.posts.at(-1).executionTier,'fast');assert.deepEqual(fast.state.errors,[]);
   console.log('PASS Fast remains explicit and resets stale cost consent; mocked dispatch only');
  }finally{await fast.close();}
  const delivery=await fixture(true);try{
   delivery.state.value.workflow.selectedRuns={'1':'run1','2':'run2'};delivery.state.value.nextAction={kind:'WAIT_CONTINUITY',runId:'run2',episodeNumber:2};
   await delivery.open();const panel=delivery.page.getByRole('region',{name:'承接复核与文字导出',exact:true});await panel.waitFor();
   assert.equal(await panel.getByRole('button',{name:'导出并核对 · 不重创作',exact:true}).isDisabled(),true);assert.deepEqual(delivery.state.posts,[]);
   await panel.getByLabel('必要承接及首集核对完成后，自动导出采用稿并对账',{exact:true}).check();await delivery.page.getByText('操作已保存，没有自动派发新模型。',{exact:true}).waitFor();
   assert.equal(delivery.state.posts[0].action,'configure-delivery');assert.equal(delivery.state.posts[0].enabled,true);
   await panel.locator('summary').click();const downloading=delivery.page.waitForEvent('download');await panel.getByRole('button',{name:'下载完整双源及当前实际尾首稿证据包',exact:true}).click();await downloading;
   await panel.getByText(/已绑定当前证据 eeeeeeeeeeee/).waitFor();const submit=panel.getByRole('button',{name:'登记这一次免费复核',exact:true});assert.equal(await submit.isDisabled(),true);
   await panel.getByLabel('已完整阅读双源和实际尾首镜，不以摘要或关键词代审',{exact:true}).check();await panel.getByLabel('坐标化核对结论',{exact:true}).fill('合成：前末镜与后首镜保持握拳；双源无放手。');await panel.getByLabel(/结构化复核 JSON/).fill('{"review":{"version":"boundary-review-v2"}}');await submit.click();
   await delivery.page.getByText('操作已保存，没有自动派发新模型。',{exact:true}).waitFor();assert.equal(delivery.state.posts.at(-1).evidenceHash,'e'.repeat(64));assert.equal(delivery.state.posts.at(-1).reviewedActualShots,true);assert.equal(delivery.state.posts.at(-1).runId,'run2');
   delivery.state.value.nextAction={kind:'COMPLETE'};await delivery.page.getByRole('button',{name:'刷新闭环状态',exact:true}).click();await panel.getByRole('button',{name:'导出并核对 · 不重创作',exact:true}).click();await panel.getByRole('link',{name:'下载合订文字稿',exact:true}).waitFor();
   assert.match(await panel.getByRole('link',{name:'下载逐请求用量对账',exact:true}).getAttribute('href')??'',/deliveryFile=usage.json/);
   await delivery.page.setViewportSize({width:390,height:844});assert.ok(await delivery.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(delivery.state.errors,[]);
   assert.ok(delivery.state.posts.every(c=>!['advance','start-parallel'].includes(c.action)));console.log('PASS generic full-evidence review, explicit attestation, server-owned audited export and narrow layout; zero paid commands');
  }finally{await delivery.close();}
  const test=await fixture();try{
   await test.open();const create=test.page.getByRole('button',{name:'创建选集流程',exact:true});await create.waitFor();assert.equal(await create.isDisabled(),true);assert.deepEqual(test.state.posts,[]);
   await test.page.getByLabel('制作方式',{exact:true}).selectOption('CHAIN');await test.page.getByLabel('开始集',{exact:true}).selectOption('1');await test.page.getByLabel('结束集',{exact:true}).selectOption('2');
   await create.click();await test.page.getByRole('region',{name:'当前下一步',exact:true}).waitFor();
   assert.deepEqual(test.state.posts[0].episodeNumbers,[1,2]);assert.deepEqual(test.state.posts[0].criticalAssetKeys,[]);assert.deepEqual(test.state.posts[0].requestedAssetKeys,[]);assert.equal(test.state.posts[0].costAcknowledged,false);
   assert.equal(test.state.posts[0].maxCalls,40);assert.equal(test.state.posts[0].maxTokens,2000000);
   assert.match(await test.page.getByRole('region',{name:'制作门检查',exact:true}).innerText(),/关键设计尚未指定/);
   assert.match(await test.page.getByRole('region',{name:'共享预算',exact:true}).innerText(),/未知用量.*1|1.*待核/s);
   assert.match(await test.page.getByRole('link',{name:'确认全剧方向',exact:true}).getAttribute('href')??'',/preparation#series-direction/);
   assert.equal(await test.page.locator('[data-workflow-state="running"]').count(),0);
   await test.page.setViewportSize({width:390,height:844});assert.ok(await test.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
   assert.deepEqual(test.state.errors,[]);console.log('PASS explicit single/continuous scope, zero default asset work, honest gates/budget, narrow layout, no read-triggered dispatch');
  }finally{await test.close();}
  const cost=await fixture(true);try{
   cost.state.value.readiness.direction.status='CONFIRMED';cost.state.value.budget.summary.unknownAttempts=0;cost.state.value.nextAction={kind:'WAIT_COST_CONFIRM',message:'继续将使用共享预算。',owner:'USER',proposedAction:{kind:'STORYBOARD_CREATE',episodeNumber:1}};
   await cost.open();const advance=cost.page.getByRole('button',{name:'确认预算并推进下一步',exact:true});await advance.waitFor();assert.equal(await advance.isDisabled(),true);
   await cost.page.getByLabel('允许本轮所选范围的必要模型调用',{exact:true}).check();await advance.click();await cost.page.getByText('已有动作已登记，请查看实际状态。',{exact:true}).waitFor();
   assert.deepEqual(cost.state.posts,[{action:'advance',workflowId:'flow',expectedRevision:3,costAcknowledged:true}]);assert.equal(await cost.page.locator('[data-workflow-state="running"]').count(),0,'coarse orchestration is not proof of generating');assert.deepEqual(cost.state.errors,[]);
   console.log('PASS one explicit advance with current revision and cost consent; coordination never invents generation');
  }finally{await cost.close();}
  const review=await fixture(true);try{
   review.state.value.workflow.selectedRuns={'1':'run1'};review.state.value.nextAction={kind:'QUALITY_CHECK',episodeNumber:1,runId:'run1',fingerprint:'draft-hash',owner:'EXECUTOR',message:'执行者复核首集，不要求逐集审批。'};
   await review.open();const summary=review.page.locator('summary').filter({hasText:'执行者质量核对记录'});await summary.waitFor();assert.equal(await summary.locator('..').getAttribute('open'),null);assert.deepEqual(review.state.posts,[]);await summary.click();const save=review.page.getByRole('button',{name:'记录实际质量核对',exact:true});await save.waitFor();assert.equal(await save.isDisabled(),true);
   for(const name of ['已检查首集主创内容','已检查首集整编与承接','主要问题已解决'])await review.page.getByLabel(name,{exact:true}).check();
   await review.page.getByLabel('质量核对说明',{exact:true}).fill('逐段检查了动作、台词与首尾承接。');await save.click();await review.page.getByText('选集文字交付完成；不是成片或用户验收。',{exact:true}).waitFor();
   assert.equal(review.state.posts[0].fingerprint,'draft-hash');assert.equal(review.state.posts[0].authorReviewed,true);assert.deepEqual(review.state.errors,[]);console.log('PASS quality review requires actual checks and note, records source fingerprint, no implicit approval');
  }finally{await review.close();}
  const need=await fixture(true);try{
   need.state.value.workflow.selectedRuns={'1':'run1'};need.state.value.nextAction={kind:'NEED_UPSTREAM',episodeNumber:1,runId:'run1',owner:'EXECUTOR',message:'门与通路需要局部材料。',needs:[{stage:2,target:'door',purpose:'补门和通路',sourceRefs:['S1'],packageIds:['P1'],blocking:true},{stage:1,target:'原文',purpose:'核对缺失句',sourceRefs:['S2'],packageIds:['P2'],blocking:true}]};
   await need.open();await need.page.getByRole('button',{name:'登记局部补料 · 不调用模型',exact:true}).click();
   await need.page.getByText('操作已保存，没有自动派发新模型。',{exact:true}).waitFor();
   assert.deepEqual(need.state.posts,[{action:'request-materials',workflowId:'flow',expectedRevision:3,needs:[{runId:'run1',target:'door',sourceRefs:['S1'],packageIds:['P1']}]}]);
   assert.equal(await need.page.getByRole('button',{name:'登记局部补料 · 不调用模型',exact:true}).count(),1);assert.deepEqual(need.state.errors,[]);console.log('PASS material request keeps exact current run/source/package coordinates, stage1 needs are not misrouted, registration does not dispatch');
  }finally{await need.close();}
  const critical=await fixture(true);try{
   await critical.open();await critical.page.getByRole('button',{name:'新建选集流程',exact:true}).click();
   assert.equal(await critical.page.getByLabel('使用共享预算',{exact:true}).inputValue(),'shared');
   await critical.page.getByLabel('制作集',{exact:true}).selectOption('1');await critical.page.locator('summary').filter({hasText:'指定关键设计'}).click();await critical.page.getByLabel('仓库门',{exact:true}).check();
   assert.equal(await critical.page.getByLabel('未来宫殿',{exact:true}).count(),0);await critical.page.getByRole('button',{name:'创建选集流程',exact:true}).click();await critical.page.getByRole('region',{name:'当前下一步',exact:true}).waitFor();
   assert.deepEqual(critical.state.posts[0].criticalAssetKeys,['door']);assert.deepEqual(critical.state.posts[0].requestedAssetKeys,['door']);assert.equal(critical.state.posts[0].budgetId,'shared');assert.deepEqual(critical.state.errors,[]);console.log('PASS explicitly selected critical design and existing shared budget are retained; future asset stays out');
  }finally{await critical.close();}
  const zero=await fixture(true);try{
   zero.state.value.workflow.episodeNumbers=[0];zero.state.value.workflow.selectedRuns={'0':'run0'};zero.state.value.nextAction={kind:'WAIT_STORYBOARD',episodeNumber:0,runId:'run0',owner:'EXECUTOR',message:'核对零集实际任务。'};
   await zero.open();const link=zero.page.getByRole('link',{name:'查看第0集当前分镜',exact:true});await link.waitFor();assert.equal(await link.getAttribute('href'),'/projects/fixture/episodes/e0/storyboard?runId=run0');assert.deepEqual(zero.state.posts,[]);assert.deepEqual(zero.state.errors,[]);console.log('PASS real production episode zero retains its exact saved run link');
  }finally{await zero.close();}
  const conflict=await fixture(true);try{
   conflict.state.value.nextAction={kind:'STORYBOARD_CREATE',episodeNumber:1,owner:'EXECUTOR',message:'按当前版本创建。'};conflict.state.value.budget.summary.unknownAttempts=0;
   await conflict.open();const advance=conflict.page.getByRole('button',{name:'开始第1集分镜 · 推进一次',exact:true});await advance.waitFor();
   conflict.state.failNext=true;conflict.state.value.workflow.revision=4;
   await advance.click();await conflict.page.getByRole('alert').filter({hasText:'流程已更新'}).waitFor();
   assert.equal(conflict.state.posts.length,1,'CAS conflicts never retry automatically');assert.equal(conflict.state.posts[0].expectedRevision,3);
   await conflict.page.getByRole('button',{name:'开始第1集分镜 · 推进一次',exact:true}).click();await conflict.page.getByText('已有动作已登记，请查看实际状态。',{exact:true}).waitFor();assert.equal(conflict.state.posts[1].expectedRevision,4);assert.deepEqual(conflict.state.errors,[]);console.log('PASS revision conflicts refresh saved state without retrying; next explicit action uses the fresh revision');
  }finally{await conflict.close();}
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
