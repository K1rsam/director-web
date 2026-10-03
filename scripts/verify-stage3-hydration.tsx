import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

async function main(){
  const root=process.cwd(),folder=await mkdtemp(path.join(tmpdir(),'stage3-hydration-'));
  const run={id:'saved',status:'running',createdAt:'2026-10-03T06:00:00Z',active:true,sourceStale:false,sourceCheckPending:true,blocked:true,preparation:{ready:false,checking:true},settings:{maxUnitSeconds:30,fantasyMode:'off',model:'gpt-6.1-sol',reasoning:'medium'},sourceRows:[],choice:{mode:'off'},adopted:[],candidates:[],operations:[{attemptId:'plan',stage:'plan',packageIds:[],status:'running',localPhase:'executing',createdAt:'2026-10-03T06:00:00Z',execution:{phase:'waiting',startedAt:'2026-10-03T06:00:00Z'}}],usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0,complete:false},budget:{maxCalls:40,maxTokens:2000000,maxRepairs:2}};
  const snapshot={episodeId:'fixture',run,savedAt:new Date('2026-10-03T06:00:02Z').getTime(),index:{runs:[{id:run.id,status:run.status,createdAt:run.createdAt}],model:'gpt-6.1-sol',reasoning:'medium',maxConcurrent:4,runner:{ready:false,message:'待核对'},preparation:{ready:false,checking:true},sourceWarnings:[]}};
  const imports=`import React from 'react';import{StoryboardWorkbench}from'./app/projects/[projectId]/episodes/[episodeId]/storyboard/workbench';import{StoryboardStatusProvider,StoryboardHeaderStatus}from'./app/projects/[projectId]/episodes/[episodeId]/storyboard/page-status';`;
  const tree=`<StoryboardStatusProvider initialRun={snapshot.run}><header><StoryboardHeaderStatus/></header><StoryboardWorkbench episodeId="fixture" projectId="fixture" episodeTitle="隔离水合验收" initialSnapshot={snapshot}/></StoryboardStatusProvider>`;
  const common={bundle:true,write:false,jsx:'automatic' as const,loader:{'.css':'empty' as const,'.module.css':'empty' as const},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent' as const};
  const server=await build({...common,stdin:{contents:`${imports}import{renderToString}from'react-dom/server';export const render=snapshot=>renderToString(${tree});`,resolveDir:root,loader:'tsx'},platform:'node',format:'cjs'});
  const serverFile=path.join(folder,'render.cjs');await writeFile(serverFile,server.outputFiles![0].text);
  const {render}=await import(pathToFileURL(serverFile).href);
  const originalTZ=process.env.TZ;process.env.TZ='Asia/Shanghai';
  let html:string;
  try{html=render(snapshot);}finally{if(originalTZ===undefined)delete process.env.TZ;else process.env.TZ=originalTZ;}
  const client=await build({...common,stdin:{contents:`${imports}import{hydrateRoot}from'react-dom/client';const snapshot=${JSON.stringify(snapshot)};hydrateRoot(document.getElementById('root'),${tree},{onRecoverableError:error=>console.error('HYDRATION: '+error.message)});`,resolveDir:root,loader:'tsx'},platform:'browser',format:'iife'});
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'})});
  try{for(const timezoneId of ['UTC','America/New_York']){
    const context=await browser.newContext({timezoneId,serviceWorkers:'block'}),page=await context.newPage(),errors:string[]=[],requests:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',entry=>{if(entry.type()==='error')errors.push(entry.text());});
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());assert.equal(request.method(),'GET','水合不能派单');
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="UTF-8"><div id="root">${html!}</div><script src="/client.js"></script>`});
      if(url.pathname==='/client.js')return route.fulfill({contentType:'application/javascript',body:client.outputFiles![0].text});
      requests.push(url.pathname+url.search);
      await route.fulfill({json:{run: snapshot.run,index:snapshot.index}});
    });
    await page.goto('http://stage3.invalid/');await page.getByLabel('当前任务已保存配置',{exact:true}).waitFor();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.deepEqual(errors,[],'服务端/浏览器时区不同仍须水合一致');
    assert.match(await page.getByLabel('任务版本',{exact:true}).innerText(),/14:00/);
    assert.equal(requests.some(url=>url.includes('view=saved')),false,'已带首屏不能水合后重读保存稿');
    await context.close();console.log(`PASS SSR snapshot hydration ${timezoneId}: stable dates, no blank/reset or model call`);
  }}finally{await browser.close();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
