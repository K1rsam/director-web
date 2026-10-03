import assert from 'node:assert/strict';
import {existsSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import type {ScriptReceptionView} from '../lib/script-resolution-service';

async function main(){
 const standard='【辅助资料·语义未验收】\n提示：原句不改写。';
 const fixture:ScriptReceptionView={projectId:'offline',title:'离线核对',canConfirm:true,assistProviders:{project:'CLI',jevConfigured:true},episodes:[{number:1,title:'离线片段'}],selected:{number:1,title:'离线片段',sourceVersion:'source-v1',revision:0,status:'NONE',sourceText:'提示：原句不改写。',readingText:null,ready:false,lines:[{line:1,unitId:'unit-1',entryId:null,target:'UNRESOLVED',kind:'UNRESOLVED',text:'提示：原句不改写。'}],diagnostics:[{line:1,code:'UNKNOWN_COLON_LINE',message:'请确认这行是正文还是辅助资料。'}],decisions:[],history:[]}};
 const built=await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import{ScriptReceptionPanel}from'./app/projects/[projectId]/script-reception-panel';const root=createRoot(document.getElementById('root'));window.mount=(props)=>root.render(React.createElement(ScriptReceptionPanel,props));",resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'iife',write:false,outfile:'script-reception-test.js',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',executablePath=existsSync(chromium.executablePath())?chromium.executablePath():existsSync(chrome)?chrome:undefined;
 if(!executablePath)throw new Error('离线浏览器不可用；未下载或安装。');
 const browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--no-first-run']});
 try{
  const context=await browser.newContext({offline:true,viewport:{width:1100,height:1000}}),page=await context.newPage();
  await context.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="zh-CN"><head><style>body{background:#eceaf9;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:12px}button{font:inherit}.studioButton{padding:9px 14px;border:1px solid #ccc5de;border-radius:10px;background:#faf8ff;color:#66578c}</style></head><body><div id="root"></div></body></html>');
  const css=built.outputFiles?.find(file=>file.path.endsWith('.css'))?.text;if(css)await page.addStyleTag({content:css});
  await page.evaluate(({fixture,standard})=>{
   const state=window as any;state.current=fixture;state.calls=[];state.failSave=false;
   window.fetch=async(_url,init)=>{
    const input=init?.body?JSON.parse(String(init.body)):null;state.calls.push(input??{action:'GET'});
    if(!input)return new Response(JSON.stringify(state.current),{status:200,headers:{'Content-Type':'application/json'}});
    if(input.action==='assist'){
     const status=input.judgmentProvider==='JEV'?'NO_SUGGESTION':state.assistMode==='unknown'?(input.retryAttemptId?'NO_SUGGESTION':'UNKNOWN'):'CANDIDATE';
     const record={id:status==='UNKNOWN'?'failed-attempt':input.retryAttemptId?'retry-attempt':'candidate',scopeKey:'offline-scope',status,episode:1,sourceVersion:'source-v1',expectedRevision:state.current.selected.revision,startLine:1,endLine:1,provider:input.judgmentProvider==='JEV'?'JEV':'CLI',choice:status==='CANDIDATE'?{startLine:1,endLine:1,type:'CREATIVE_GUIDANCE'}:null,note:status==='CANDIDATE'?'保留原句，作为辅助资料。':status==='UNKNOWN'?'上次请求结果未知，未自动重试。':'仍需人工核对。',usage:status==='NO_SUGGESTION'?{inputTokens:20,outputTokens:null}:null,retryAllowed:status==='UNKNOWN'};
     state.current={...state.current,selected:{...state.current.selected,assistance:[record]}};return new Response(JSON.stringify(record));
    }
    if(state.failSave)return new Response(JSON.stringify({error:'本集原文已更新，请刷新核对。'}),{status:409});
    if(input.action==='confirm')state.current={...fixture,selected:{...fixture.selected,revision:state.current.selected.revision+1,status:'CURRENT',ready:true,readingText:standard,diagnostics:[],decisions:[{...input.choice,id:'decision',actorId:'server-reviewer',confirmedAt:'2026-09-28T00:00:00Z'}]}};
    if(input.action==='revoke')state.current={...fixture,selected:{...fixture.selected,revision:state.current.selected.revision+1}};
    return new Response(JSON.stringify(state.current));
   };
  },{fixture,standard});
  await page.addScriptTag({content:built.outputFiles!.find(file=>file.path.endsWith('.js'))!.text});
  await page.evaluate(()=>(window as any).mount({projectId:'offline'}));
  await page.getByRole('heading',{name:'剧本标准阅读'}).waitFor();await page.getByText('请确认这行是正文还是辅助资料。',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>(window as any).calls),[{action:'GET'}],'mount reads only, never requests a model');
  await page.getByRole('region',{name:'清洗正文'}).getByText('提示：原句不改写。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'标准阅读',exact:true}).count(),0,'one reading surface, no duplicated machine rendering');
  await page.getByRole('button',{name:/^辅助判断此处/}).click();await page.getByText('待你采用的候选',{exact:true}).waitFor();
  const assisted=await page.evaluate(()=>(window as any).calls);assert.equal(assisted.length,2);assert.equal(assisted[1].action,'assist');assert.equal(assisted[1].sourceVersion,'source-v1');assert.ok(!JSON.stringify(assisted[1]).includes('原句不改写'));assert.equal(assisted.filter((call:any)=>call.action==='confirm').length,0);
  await page.getByRole('button',{name:'刷新记录',exact:true}).click();await page.getByText('待你采用的候选',{exact:true}).first().waitFor();
  assert.equal(await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.action==='assist').length),1,'refresh recovers the paid candidate without dispatch');
  assert.equal(await page.getByRole('button',{name:'已有判断，不重复调用',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'采用并保存核对',exact:true}).click();await page.getByText(/解析核对已保存/).waitFor();
  const adopted=await page.evaluate(()=>(window as any).calls.at(-1));assert.equal(adopted.action,'confirm');assert.deepEqual(adopted.choice,{startLine:1,endLine:1,type:'CREATIVE_GUIDANCE'});assert.equal(adopted.actorId,undefined);
  await page.getByRole('button',{name:'撤销',exact:true}).click();await page.getByText(/已撤销当前解释/).waitFor();
  await page.evaluate(()=>{(window as any).failSave=true;});await page.getByLabel('解析为').selectOption('ACTION');await page.getByRole('button',{name:'确认此项',exact:true}).click();await page.getByRole('alert').filter({hasText:'本集原文已更新'}).waitFor();
  const attempts=await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.action==='confirm').length);assert.equal(attempts,2);assert.equal(await page.getByLabel('解析为').inputValue(),'ACTION','failed save retains the user choice');
  await page.evaluate(fixture=>{const state=window as any;state.failSave=false;state.assistMode='unknown';state.current=fixture;state.mount({projectId:'offline',initial:fixture});},fixture);
  await page.getByRole('button',{name:/^辅助判断此处/}).click();await page.getByText('调用结果未知',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:/确认风险后重新判断/}).isDisabled(),true);
  await page.getByLabel(/我已核对上次记录/).check();await page.getByRole('button',{name:/确认风险后重新判断/}).click();await page.getByText('没有明确建议，仍待人工核对',{exact:true}).waitFor();
  const retry=await page.evaluate(()=>(window as any).calls.at(-1));assert.equal(retry.retryAttemptId,'failed-attempt');assert.equal(retry.acknowledgeRisk,true);
  await page.getByLabel('辅助判断服务',{exact:true}).selectOption('JEV');assert.equal(await page.getByRole('button',{name:/^辅助判断此处/}).isDisabled(),true,'Jev requires separate external consent');
  await page.getByLabel(/同意把所选及相邻/).check();await page.getByRole('button',{name:/^辅助判断此处/}).click();await page.getByText('没有明确建议，仍待人工核对',{exact:true}).waitFor();
  const jev=await page.evaluate(()=>(window as any).calls.at(-1));assert.equal(jev.judgmentProvider,'JEV');assert.equal(jev.explicitExternalConsent,true);assert.equal(jev.actorId,undefined);
  await page.evaluate(fixture=>(window as any).mount({projectId:'offline',initial:{...fixture,assistProviders:{project:'CLI',jevConfigured:false}}}),fixture);
  await page.getByLabel('辅助判断服务',{exact:true}).selectOption('JEV');await page.getByText(/服务端未配置Jev/).waitFor();await page.getByLabel(/同意把所选及相邻/).check();assert.equal(await page.getByRole('button',{name:/^辅助判断此处/}).isDisabled(),true,'missing config never falls back to the project model');
  await page.evaluate(fixture=>(window as any).mount({projectId:'offline',initial:{...fixture,canConfirm:false,selected:{...fixture.selected,status:'STALE'}}}),fixture);
  await page.getByText(/旧核对不再生效/).waitFor();assert.equal(await page.getByRole('button',{name:/^辅助判断此处/}).count(),0);assert.equal(await page.getByRole('button',{name:'确认此项',exact:true}).count(),0);
  const folder=mkdtempSync(path.join(tmpdir(),'script-reception-ui-'));await page.screenshot({path:path.join(folder,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(folder,'mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'mobile panel must not overflow the viewport');
  assert.equal(await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.action==='confirm').length),2,'failed mutation is never automatically retried');
  console.log(`PASS offline browser: initial GET only, single clean reading view, candidate refresh/cache, explicit risk-bound retry, Jev external consent/no-config guard, server-bound payload, revoke, no automatic retry, retained input, stale/readonly controls, mobile width; screenshots ${folder}`);
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
