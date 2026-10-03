/** Real browser + real components; every HTTP request is intercepted, no DB/server/model. */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const record={schema:'PRODUCTION_WORKFLOW_V1',id:'flow',projectId:'fixture',actorId:'actor',mode:'CHAIN',episodeNumbers:[1,2],criticalAssetKeys:[],requestedAssetKeys:[],budgetId:'shared',sourceVersion:'source',revision:3,selectionRevision:0,selectedRuns:{},qualityReviews:[],receipts:[],activeAction:null,status:'READY',paused:false,costAcknowledged:false,createdAt:'2026-10-01T01:00:00Z',updatedAt:'2026-10-01T01:00:00Z'};
const snapshot=()=>({workflow:structuredClone(record),keyDesignGate:'NOT_SPECIFIED',readiness:{sourceVersion:'source',standard:{ready:true,issues:[]},stage1:{ready:true,busy:false},direction:{status:'CANDIDATE',hasCandidate:true,pending:false},assets:{missingCandidateKeys:[],missingCriticalKeys:[],busy:false},sourceConflicts:[],technicalIssues:[],keyDesignGate:'NOT_SPECIFIED'},nextAction:{kind:'WAIT_DIRECTION_CONFIRM',owner:'USER',message:'全剧方向候选已备好，等待用户明确确认。'},budget:{id:'shared',projectIds:['fixture'],maxCalls:40,maxTokens:2000000,paused:false,summary:{calls:6,knownTokens:12000,unknownAttempts:1,inFlight:0,complete:false}}});
async function main(){
 const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{ProductionWorkspace}from'./app/projects/[projectId]/production/workspace';createRoot(document.getElementById('root')).render(<ProductionWorkspace projectId="fixture" episodes={[{id:'e0',number:0,title:'正篇零集'},{id:'e1',number:1,title:'开场'},{id:'e2',number:2,title:'接续'},{id:'e3',number:3,title:'未来'}]} assets={[{key:'door',name:'仓库门',episodes:[1],mode:'REFERENCE'},{key:'palace',name:'未来宫殿',episodes:[3],mode:'REFERENCE'}]}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'})});
 async function fixture(existing=false){
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
     return route.fulfill({json:state.value});
    }
    return route.fulfill({json:url.searchParams.get('workflowId')?state.value:{workflows:state.list}});
   }
   state.errors.push(`Unexpected ${url.pathname}`);return route.abort();
  });
  const open=async()=>{await page.goto('http://production.test/');await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text});await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text});await page.getByRole('button',{name:'刷新闭环状态',exact:true}).waitFor();};
  return {page,state,open,close:()=>context.close()};
 }
 try{
  const test=await fixture();try{
   await test.open();const create=test.page.getByRole('button',{name:'创建选集流程',exact:true});await create.waitFor();assert.equal(await create.isDisabled(),true);assert.deepEqual(test.state.posts,[]);
   await test.page.getByLabel('制作方式',{exact:true}).selectOption('CHAIN');await test.page.getByLabel('开始集',{exact:true}).selectOption('1');await test.page.getByLabel('结束集',{exact:true}).selectOption('2');
   await create.click();await test.page.getByRole('region',{name:'当前下一步',exact:true}).waitFor();
   assert.deepEqual(test.state.posts[0].episodeNumbers,[1,2]);assert.deepEqual(test.state.posts[0].criticalAssetKeys,[]);assert.deepEqual(test.state.posts[0].requestedAssetKeys,[]);assert.equal(test.state.posts[0].costAcknowledged,false);
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
   await conflict.open();conflict.state.failNext=true;conflict.state.value.workflow.revision=4;
   await conflict.page.getByRole('button',{name:'开始第1集分镜 · 推进一次',exact:true}).click();await conflict.page.getByRole('alert').filter({hasText:'流程已更新'}).waitFor();
   assert.equal(conflict.state.posts.length,1,'CAS conflicts never retry automatically');assert.equal(conflict.state.posts[0].expectedRevision,3);
   await conflict.page.getByRole('button',{name:'开始第1集分镜 · 推进一次',exact:true}).click();await conflict.page.getByText('已有动作已登记，请查看实际状态。',{exact:true}).waitFor();assert.equal(conflict.state.posts[1].expectedRevision,4);assert.deepEqual(conflict.state.errors,[]);console.log('PASS revision conflicts refresh saved state without retrying; next explicit action uses the fresh revision');
  }finally{await conflict.close();}
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
