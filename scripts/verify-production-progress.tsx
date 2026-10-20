/** Pure projection + real component, fully intercepted browser; no model/production DB. */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {productionProgress} from '../lib/production-progress';

const workflow={id:'flow',sourceVersion:'v1',episodeNumbers:[0,39,150],selectedRuns:{0:'r0',39:'r39',150:'r150'},qualityReviews:[{runId:'r0',episodeNumber:0,fingerprint:'f0',authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true},{runId:'r39',episodeNumber:39,fingerprint:'stale',authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true}]};
const foundation={document:{f2:{coverage:[0,150,999]},editorialCoverage:[0,999]},needsContextEdit:false};
const runs={r0:{id:'r0',episodeNumber:0,textAdopted:true,complete:true,fingerprint:'f0'},r39:{id:'r39',episodeNumber:39,textAdopted:true,complete:false,fingerprint:'f39',continuityPending:true},r150:{id:'r150',episodeNumber:150,status:'complete',complete:true,textAdopted:false,busy:true,stage:'author',inFlight:1,queued:0}};
const before=JSON.stringify({workflow,foundation,runs});
const progress=productionProgress(workflow,foundation,runs,{total:2,ready:2,adopted:1});
assert.equal(progress.scopeTotal,3);assert.equal(progress.sourceRead,2);assert.equal(progress.foundationReviewed,1);
assert.equal(progress.textAdopted,2);assert.equal(progress.strictComplete,1,'PRELIMINARY and status-only completion are not strict completion');
assert.equal(progress.currentQualityRecords,1,'stale review cannot follow a revised adopted draft');
assert.equal(progress.independentReviewed,null);assert.equal(progress.navigationReviewed,null);assert.equal(progress.eta,null);
assert.deepEqual(progress.blockedEpisodes,[39]);assert.deepEqual(progress.inProduction.map(r=>r.episodeNumber),[150]);
assert.equal(productionProgress(workflow,{...foundation,needsContextEdit:true},runs,null).foundationReviewed,null);
assert.equal(productionProgress({...workflow,selectedRuns:{...workflow.selectedRuns,0:'missing'}},foundation,runs,null).textAdopted,1,'only explicitly selected saved versions count');
assert.equal(JSON.stringify({workflow,foundation,runs}),before,'reading progress cannot mutate evidence or adoption');
const snapshot={workflow,readiness:{progress,stage1:{ready:true},direction:{status:'CONFIRMED'},assets:{busy:false}},nextAction:{kind:'WAIT_CONTINUITY',message:'第39集仍待实际尾稿核对。'}};

async function main(){
 const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{ProductionProgressPanel}from'./app/projects/[projectId]/production/progress-panel';const root=createRoot(document.getElementById('root'));(window as any).showProgress=(snapshot:any)=>root.render(<ProductionProgressPanel snapshot={snapshot}/>);(window as any).showProgress(${JSON.stringify(snapshot)});`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'})});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}});page.setDefaultTimeout(3000);const errors:string[]=[],posts:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{if(route.request().method()!=='GET')posts.push(route.request().method());return route.fulfill({contentType:'text/html',body:'<meta charset="UTF-8"><div id="root"></div>'});});
  await page.goto('http://progress.invalid/');await page.addScriptTag({content:bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text});const css=bundle.outputFiles.find(file=>file.path.endsWith('.css'));if(css)await page.addStyleTag({content:css.text});
  const panel=page.getByRole('region',{name:'分阶段真实进度',exact:true});await panel.waitFor();
  assert.match(await panel.innerText(),/文字采用（含整集整编）\s*2 \/ 3/);assert.match(await panel.innerText(),/当前稿独审闭环\s*未记录/);
  assert.match(await panel.innerText(),/完整叙事导航复核\s*未记录/);
  assert.match(await panel.innerText(),/齐稿 2 \/ 2 项；复核采用 1 \/ 2/);assert.match(await panel.innerText(),/ETA待估/);assert.match(await panel.innerText(),/第150集.*完整主创/);
  await page.evaluate(value=>(window as any).showProgress(value),{...snapshot,nextAction:{kind:'WAIT_COST_CONFIRM',proposedAction:{kind:'ASSETS'}}});
  await panel.getByText('当前阶段：第二阶段 · 所选资产',{exact:true}).waitFor();
  await page.evaluate(value=>(window as any).showProgress(value),{...snapshot,readiness:{...snapshot.readiness,progress:{...progress,textAdopted:3,strictComplete:2}}});
  await panel.getByText(/本页自首次读取的变化：文字采用 \+1，承接就绪 \+1/).waitFor();
  await page.evaluate(value=>(window as any).showProgress(value),{...snapshot,readiness:{...snapshot.readiness,progress:{...progress,textAdopted:1,strictComplete:0}}});
  await panel.getByText(/文字采用 -1，承接就绪 -1/).waitFor();
  await page.evaluate(value=>(window as any).showProgress(value),{...snapshot,readiness:{...snapshot.readiness,progress:{...progress,scopeKey:'new-source'}}});
  await panel.getByText(/文字采用 \+0，承接就绪 \+0/).waitFor();
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);
  console.log('PASS evidence-based scoped source/assets/text/strict counts, unknown independent review and ETA, stale review exclusion, delta/revocation/source reset, mobile UI; zero mutations/model calls');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
