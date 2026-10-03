/** Real summary components and styles, synthetic data, blocked network; no server/DB/model. */
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';

async function main(){
 const production={boundary:{status:'MATCHED',actualVersion:'previous-accepted-v2',reason:'已核对本次选定的前集结尾。'},sharedBudget:{maxCalls:40,maxTokens:2000000,calls:4,knownTokens:12000,unknownAttempts:0,inFlight:0,complete:true},materialNeeds:[],pendingRepair:null,blocking:false,chainComplete:false,chainMode:'CHAIN'};
 const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import'./app/globals.css';import'./app/vision-studio.css';import{ProductionPanel}from'./app/projects/[projectId]/episodes/[episodeId]/storyboard/panels';import styles from'./app/projects/[projectId]/episodes/[episodeId]/storyboard/workbench.module.css';const root=createRoot(document.getElementById('root'));window.render=run=>root.render(<main className={styles.workbench}><ProductionPanel run={run} projectId="fixture" episodeNumber={2}/></main>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'}),args:['--disable-background-networking']});
 const folder=mkdtempSync(path.join(tmpdir(),'stage3-summary-ui-'));
 try{for(const width of [1440,390]){
  const context=await browser.newContext({offline:true,viewport:{width,height:900}}),page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(3000);
  page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',route=>{errors.push(`unexpected request: ${route.request().url()}`);return route.abort();});
  await page.setContent('<meta charset="UTF-8"><div id="root"></div>');await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text});await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text});
  const mount=async(value:unknown)=>{await page.evaluate(run=>(window as any).render(run),value);};
  await mount({id:'normal',production});const continuity=page.locator('details[aria-label="承接与按需材料"]'),budget=page.locator('details[aria-label="本轮共享预算"]');
  await page.getByText(/实际核对已匹配/).waitFor();assert.equal(await continuity.count(),1,'continuity is a compact disclosure, not a mandatory full-height panel');
  assert.equal(await continuity.getAttribute('open'),null);assert.equal(await budget.getAttribute('open'),null);
  await continuity.locator('summary').click();await page.getByText('已核对本次选定的前集结尾。',{exact:true}).waitFor();assert.equal(await page.getByText('previous-accepted-v2',{exact:false}).count(),1,'selected predecessor version remains inspectable');
  assert.equal(await page.getByRole('link',{name:'本集资料与来源',exact:true}).getAttribute('href'),'/projects/fixture/foundation/handoff?episode=2','material inspection keeps the current episode instead of defaulting to the first');
  await continuity.locator('summary').click();await page.screenshot({path:path.join(folder,`normal-${width}.png`)});
  const risk={...production,boundary:{status:'CONSTRAINT_CONFLICT',reason:'原文规定钥匙尚未接住。'},materialNeeds:[{stage:2,target:'门位',purpose:'保留入口与遮挡',packageIds:['P2'],sourceRefs:['S2'],blocking:true}],sharedBudget:{...production.sharedBudget,unknownAttempts:1,complete:false}};
  await mount({id:'risk',production:risk});await page.getByText('原文规定钥匙尚未接住。',{exact:true}).waitFor();
  assert.notEqual(await continuity.getAttribute('open'),null,'constraint/material risks expand automatically');assert.notEqual(await budget.getAttribute('open'),null,'unknown usage cannot be hidden by the compact default');
  await page.getByText(/存在未知用量/).waitFor();await page.getByText('第二阶段 · 门位',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'summaries fit a narrow viewport');await page.screenshot({path:path.join(folder,`risk-${width}.png`)});
  await mount({id:'unavailable',production:{...production,sharedBudget:{unavailable:true}}});await page.getByText('共享预算暂不可读取，先核对记录。',{exact:true}).waitFor();assert.notEqual(await budget.getAttribute('open'),null);
  await mount({id:'old',legacyReadOnly:true,production});await page.waitForFunction(()=>!document.querySelector('details[aria-label="承接与按需材料"]'));
  assert.deepEqual(errors,[]);await context.close();console.log(`PASS stage3 summaries ${width}px: compact normal state, selected-version details, visible risk/missing-budget, legacy isolation, no overflow/network/model`);
 }}finally{await browser.close();}
 console.log(`Screenshots: ${folder}`);
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
