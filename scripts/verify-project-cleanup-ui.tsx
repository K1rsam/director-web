/** Real project reading/status components + CSS, synthetic data, inert server actions; no DB/model. */
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import type {FoundationDeliveryState,FoundationDeliveryTask} from '../lib/foundation-delivery-types';

const state:FoundationDeliveryState={document:{schema:'FOUNDATION_DOCUMENT_V1',revision:'doc',sourceVersion:'source',sourceContextVersion:'context',sourceHashes:{1:'hash'},settingsFingerprint:'settings',f1:null,f2:null,overviewParts:[],editorialCoverage:[1],editorialTodos:[],notes:[],appliedDecisions:{},reviewedSuggestions:{},requiredDecisionIds:[],origins:[]},previousDocument:null,task:null,totalEpisodes:1,availableEpisodes:1,editedEpisodes:1,busy:false,complete:true,needsContextEdit:false,action:'NONE',requiredChoices:[],confirmedChoices:[],suggestionsCount:0,codes:{},issues:[],expectedState:'expected',sourceContext:{version:'context',background:[],unresolved:[],issues:[],complete:true,notices:[],coverage:'COMPLETE'}};
const task:FoundationDeliveryTask={schema:'FOUNDATION_DELIVERY_TASK_V1',id:'fixture-task',revision:1,projectId:'fixture',sourceVersion:'source',documentRevision:'doc',provider:'CLI',contextFingerprint:'context',status:'PARTIAL',phase:'EDIT',scope:[1],completedEpisodes:[],totalEpisodes:1,message:'保存稿保留',createdAt:'2026-10-03T01:00:00Z',updatedAt:'2026-10-03T01:01:00Z',workerPid:null,workerToken:null,addedCalls:1,repairCalls:0,repairRounds:0,maxRepairCalls:2,maxRepairRounds:2,unknownOutcome:false,error:'保存的技术诊断',decisionIds:[],unresolved:[]};

// The source index is a server component. Render it on the server, rather than
// moving its server-only parsing imports into a browser fixture.
const require=createRequire(import.meta.url);require.extensions['.css']=module=>{module.exports=new Proxy({}, {get:(_,key)=>key==='__esModule'?false:`ssr-${String(key)}`});};
const {LightFoundationDocumentViewer}=require('../app/projects/[projectId]/foundation-document-viewer') as typeof import('../app/projects/[projectId]/foundation-document-viewer');
const sources=[{id:'background',number:0,title:'背景资料',content:'保留的背景原文，不进入正篇阅读接口。',sceneCount:0,productionEligible:false},{id:'one',number:1,title:'门口',content:'不重复铺放的正篇原文。',sceneCount:2,productionEligible:true}];
const sourceHtml=renderToStaticMarkup(createElement(LightFoundationDocumentViewer,{projectId:'fixture',state,sourceEpisodes:sources}));

async function main(){
 const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import'./app/globals.css';import'./app/vision-studio.css';import'./app/page-surfaces.css';import'./app/workbench-refinement.css';import{FoundationWorkflowStatus}from'./app/projects/[projectId]/foundation-delivery-panel';import styles from'./app/projects/[projectId]/foundation-delivery.module.css';const root=createRoot(document.getElementById('root'));const readonlyMarkup=${JSON.stringify(sourceHtml)}.replace(/ssr-([a-zA-Z0-9_]+)/g,(_,key)=>styles[key]||'');window.mount=state=>root.render(<div className="appChrome"><aside className="appSidebar"><div className="chromeBrand"><strong>离线展示检查</strong></div></aside><div className="appWorkspace"><header className="appTopbar"><div className="topbarIdentity"><small>第一阶段 · 全剧资料</small><h1 className="pageTitle">合成案例</h1></div></header><main className="appMain"><div className="projectDashboard"><FoundationWorkflowStatus projectId="fixture" state={state} sourceReady sceneCount={2} remaining={[]}/><section className="studioSection" id="phase-one" dangerouslySetInnerHTML={{__html:readonlyMarkup}}/></div></main></div></div>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'inert-actions-and-navigation',setup(b){b.onResolve({filter:/^(?:@\/app\/actions|next\/navigation)$/},args=>({path:args.path,namespace:'inert'}));b.onLoad({filter:/.*/,namespace:'inert'},args=>({loader:'js',contents:args.path==='next/navigation'?'export const useRouter=()=>({refresh(){throw Error("Unexpected refresh")}});':'const forbidden=()=>{throw Error("Unexpected server action")};export const startFoundationDeliveryAction=forbidden,stopFoundationDeliveryAction=forbidden,preprocessProjectAction=forbidden;'}));}}]});
 const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'}),args:['--disable-background-networking']});const folder=mkdtempSync(path.join(tmpdir(),'project-cleanup-ui-'));
 try{for(const width of [1440,390]){
  const context=await browser.newContext({offline:true,viewport:{width,height:900}}),page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(5000);
  page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',route=>{errors.push(`unexpected request: ${route.request().url()}`);return route.abort();});
  await page.setContent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div></html>');await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text});await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text});
  const mount=async(s:FoundationDeliveryState)=>{await page.evaluate(s=>(window as any).mount(s),s);};await mount(state);
  const status=page.locator('#foundation-status');await status.waitFor();assert.equal(await status.getAttribute('open'),null,'healthy completed preparation defaults folded');
  const sourceLink=page.getByRole('link',{name:/第1集.*标准稿／原文/});assert.equal(await sourceLink.getAttribute('href'),'/projects/fixture/preparation?episode=1#script-review');assert.equal(await page.getByText('不重复铺放的正篇原文。',{exact:true}).count(),0);
  assert.ok(await sourceLink.evaluate(node=>node.parentElement!.getBoundingClientRect().height<90),'a sparse source index must not stretch each episode into a giant row');
  await page.getByText('背景资料',{exact:false}).click();await page.getByText('保留的背景原文，不进入正篇阅读接口。',{exact:true}).waitFor();
  await status.locator('summary').first().focus();await page.keyboard.press('Enter');await page.getByRole('link',{name:'剧本标准阅读',exact:true}).waitFor();assert.notEqual(await status.getAttribute('open'),null);await status.locator('summary').first().click();await page.screenshot({path:path.join(folder,`complete-${width}.png`)});
  await mount({...state,complete:false,action:'BLOCKED',task});await page.getByText(/系统处理问题/).waitFor();assert.notEqual(await status.getAttribute('open'),null);await page.getByText('保存的技术诊断',{exact:true}).waitFor();await page.screenshot({path:path.join(folder,`risk-${width}.png`)});
  await page.evaluate(()=>document.documentElement.style.fontSize='24px');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'actual project status/index fits 150% text and mobile');
  assert.deepEqual(errors,[]);await context.close();console.log(`PASS project ${width}px: completed fold/keyboard, canonical reader, retained background, visible diagnostics, 150% font, zero network/actions/model`);
 }}finally{await browser.close();}console.log(`Screenshots: ${folder}`);
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
