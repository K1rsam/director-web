/** Real workbench/header styles in an isolated page. Synthetic GET responses only; no production server, DB or model. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { Run } from '../app/projects/[projectId]/episodes/[episodeId]/storyboard/types';

async function main() {
  const origin='http://stage3-progress.invalid';
  const run:Run={id:'fixture',status:'running',createdAt:new Date(Date.now()-65000).toISOString(),active:true,sourceStale:false,
    settings:{maxUnitSeconds:30,fantasyMode:'recommended',model:'gpt-6.1-sol',reasoning:'medium'},sourceRows:[],choice:{mode:'recommended'},adopted:[],candidates:[],
    operations:[{attemptId:'live-plan',stage:'plan',packageIds:[],status:'running',localPhase:'executing',createdAt:new Date(Date.now()-65000).toISOString(),execution:{phase:'waiting',startedAt:new Date(Date.now()-65000).toISOString(),lastProgressAt:null}}],
    usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0,complete:false,unknownAttempts:1},budget:{maxCalls:40,maxTokens:2000000,maxRepairs:2}};
  const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import'./app/globals.css';import'./app/vision-studio.css';import'./app/page-surfaces.css';import{StoryboardWorkbench}from'./app/projects/[projectId]/episodes/[episodeId]/storyboard/workbench';import{StoryboardStatusProvider,StoryboardHeaderStatus}from'./app/projects/[projectId]/episodes/[episodeId]/storyboard/page-status';
    createRoot(document.getElementById('root')).render(<StoryboardStatusProvider><div className="appChrome" data-section="storyboard"><div className="appWorkspace"><header className="appTopbar"><div className="topbarIdentity"><small>第三阶段 / 分镜创作</small><h1 className="pageTitle">第1集</h1></div><div className="topbarTools"><div className="projectTopbarMeta"><span>3D国漫</span><span>16:9</span></div><StoryboardHeaderStatus/><a className="quietButton" href="/projects/fixture">返回全剧资料</a></div></header><main className="appMain"><StoryboardWorkbench episodeId="fixture" projectId="fixture" episodeTitle="隔离排版验证"/></main></div></div></StoryboardStatusProvider>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'}),args:['--disable-background-networking']});
  const folder=mkdtempSync(path.join(tmpdir(),'stage3-progress-ui-'));
  try { for(const [width,fontSize] of [[1440,16],[390,16],[960,24]]) {
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),page=await context.newPage(),errors:string[]=[];
    page.setDefaultTimeout(3000);page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==origin||request.method()!=='GET'){errors.push('unexpected network or mutation');return route.abort();}
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="UTF-8"><style>html{font-size:${fontSize}px}</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>`});
      if(url.pathname==='/fixture.js')return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text});
      if(url.pathname==='/fixture.css')return route.fulfill({contentType:'text/css',body:bundle.outputFiles.find(file=>file.path.endsWith('.css'))!.text});
      if(url.pathname!=='/api/episodes/fixture/storyboard'){errors.push('unexpected endpoint');return route.abort();}
      return route.fulfill({json:url.searchParams.has('runId')?{run}:{runs:[{id:run.id,status:run.status,active:true,createdAt:run.createdAt}],runner:{ready:true,message:'isolated'},preparation:{ready:true},sourceWarnings:[]}});
    });
    await page.goto(origin);
    await page.getByLabel('第三阶段当前步骤',{exact:true}).getByText('情绪统筹 · 等待首个输出',{exact:true}).waitFor();
    const current=page.locator('[aria-label="制作流程"] article[aria-current="step"]');
    assert.equal(await current.count(),1);assert.equal(await current.getAttribute('data-workflow-state'),'waiting');
    assert.match(await current.innerText(),/当前步骤/);assert.equal(await page.locator('[data-workflow-state="running"]').count(),0);
    const status=await page.getByRole('region',{name:'制作状态',exact:true}).innerText();assert.match(status,/CLI.*等待首个有效输出/);assert.match(status,/当前作业历时/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'header and step rail must fit narrow/enlarged text');
    assert.ok(await current.getByText('当前步骤',{exact:true}).evaluate(element=>{const box=element.getBoundingClientRect();return box.width>=40&&box.height<25;}),'current-step marker must not wrap into a narrow grid column');
    await page.screenshot({path:path.join(folder,`waiting-${width}-${fontSize}.png`),fullPage:true});
    assert.deepEqual(errors,[]);await context.close();console.log(`PASS progress UI ${width}px / ${fontSize}px: shared header, truthful wait, visible current step, no overflow or paid request`);
  }} finally {await browser.close();}
  console.log(`Screenshots: ${folder}`);
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
