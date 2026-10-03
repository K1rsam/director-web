import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import type {PromptWorkspace} from '../lib/asset-prompt-contract';

async function main(){
 const assets=[{key:'first',name:'第一个仓库',episodes:[1]},{key:'future',name:'未来宫殿',episodes:[2]}].map(a=>({...a,baseKey:a.key,baseName:a.name,type:'LOC' as const,variant:false,mode:'REFERENCE',description:'',note:'',evidence:[],reasons:[],eligible:true,fingerprint:'source'}));
 const workspace:PromptWorkspace={projectId:'scope',title:'选集测试',style:'',stylePrefix:'',styleRevision:0,assets,records:{},busy:false,visualFactsStatus:'MISSING'};
 const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{AssetPromptWorkspace}from'./app/projects/[projectId]/asset-prompts/workspace';createRoot(document.getElementById('root')).render(<AssetPromptWorkspace initial={${JSON.stringify(workspace)}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'})}),page=await browser.newPage({viewport:{width:1280,height:900}}),requests:any[]=[],errors:string[]=[],reviews:string[]=[];
 let reviewFailure=false;
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.route('http://scope.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith('/adoption'))return route.fulfill({json:{projectId:'scope',canAdopt:false,assets:{}}});
   if(path.endsWith('/api')){
    if(route.request().method()==='GET'){
     const search=new URL(route.request().url()).searchParams;
     if(search.get('view')==='production-cards'){
      const selected=search.get('episodes')!;reviews.push(selected);
      if(reviewFailure)return route.fulfill({status:409,json:{error:'来源读取期间已变化，请刷新。'}});
      const n=Number(selected),asset=assets.find(a=>a.episodes.includes(n))!;
      return route.fulfill({json:{schema:'ASSET_PREPARATION_REVIEW_V1',projectId:'scope',episodes:[{episodeNumber:n,sourceVersion:'source',materialVersion:'material',readiness:'READY',reasons:[],directionStatus:'UNCONFIRMED',cards:[{schema:'ASSET_PRODUCTION_CARD_V1',assetKey:asset.key,name:asset.name,type:'LOC',use:'ACTUAL_APPEARANCE',applicable:{episode:n,sceneKeys:[`${n}-1`]},sourceFacts:[{id:'action',claim:'SOURCE',quote:n===1?'甲反锁铁门，躲到固定货架后。':'乙进入未来宫殿。',association:'SCENE_ACTION',evidence:{domain:'EPISODE',episode:n,start:0,end:10}}],adoptedDesign:null,freeDesignScope:'不增加秘密出口或道具能力。',materialAvailability:'TEXT_ONLY',imageEvidence:'NO_PIXELS_READ',references:[],materialNeeds:[]}]}]}});
     }
     return route.fulfill({json:{...workspace,visualFactsStatus:'READY'}});
    }
    const input=route.request().postDataJSON();requests.push(input);if(input.action==='generate')return route.fulfill({json:{schema:'ASSET_PROMPT_V1',key:input.key,revision:1,status:'READY',body:'铁门朝南，固定货架留出通路。',facts:'',suggestions:'',error:'',fingerprint:'source',updatedAt:'',origin:'AI'}});return route.fulfill({json:{...workspace,visualFactsStatus:'READY'}});
   }
   return route.fulfill({contentType:'text/html',body:'<main id="root"></main>'});
  });
  await page.goto('http://scope.test/');await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text});await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text});
  await page.getByText('外观依据与提示词准备 · 可选',{exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'整理剧本事实',exact:true}).isDisabled(),true,'blank selection cannot launch a whole-series task');
  assert.equal(await page.getByRole('button',{name:'查看本集文字生产卡',exact:true}).isDisabled(),true,'No implicit all-series material review');
  assert.equal(await page.getByRole('button',{name:'生成初版提示词',exact:true}).isDisabled(),true,'a paid prompt request requires an explicit episode scope');
  assert.deepEqual(reviews,[]);assert.deepEqual(requests,[],'Opening the workspace dispatches no model');
  await page.getByLabel('资产制作集数',{exact:true}).fill('1');
  const library=page.getByRole('region',{name:'资产设定库'}),editor=page.getByRole('complementary',{name:'资产提示词编辑器'});
  assert.equal(await library.getByRole('button',{name:/^全部/}).innerText(),'全部 1','category count follows the episode scope, not the whole project');
  assert.equal(await library.getByRole('button',{name:/^场景/}).innerText(),'场景 1');
  assert.equal(await library.getByRole('button').filter({has:page.locator('strong',{hasText:'未来宫殿'})}).count(),0);
  const draft='保留人工编辑的门与通路。';await editor.getByLabel('资产外观提示词',{exact:true}).fill(draft);
  assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false,'unsaved draft prevents an unconfirmed navigation');
  await page.getByLabel('资产制作集数',{exact:true}).fill('2');
  await editor.getByRole('alert').filter({hasText:'不在所选集范围'}).waitFor();
  assert.equal(await editor.getByRole('button',{name:'保存此资产',exact:true}).isDisabled(),true,'out-of-scope selection cannot mutate another episode asset');
  assert.equal(await editor.getByRole('button',{name:'生成初版提示词',exact:true}).isDisabled(),true);
  assert.equal(await editor.getByLabel('资产外观提示词',{exact:true}).inputValue(),draft,'scope changes preserve unsaved edits');
  await page.getByLabel('资产制作集数',{exact:true}).fill('1');
  assert.equal(await editor.getByRole('button',{name:'保存此资产',exact:true}).isDisabled(),false);
  await editor.getByLabel('资产外观提示词',{exact:true}).fill('');
  assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true,'reverted empty draft does not invent an unsaved-change warning');
  assert.equal(await library.getByText('有未保存编辑',{exact:true}).count(),0,'asset card uses the same clean-empty draft rule as the generation queue');
  assert.equal(await editor.getByRole('button',{name:/生成资产图片/}).count(),0,'unavailable image generation is not a pretend primary action');
  await page.getByRole('button',{name:'查看本集文字生产卡',exact:true}).click();
  await page.getByText('第1集 · 1张文字卡 · 0项已采用设计',{exact:true}).waitFor();
  await page.getByText('第一个仓库 · 随本集原文使用 · 1条原文依据',{exact:true}).click();
  await page.getByText('甲反锁铁门，躲到固定货架后。',{exact:true}).waitFor();
  assert.deepEqual(reviews,['1']);assert.equal(requests.length,0,'Reading actual text cards is not a paid facts/generation request');
  assert.equal(await page.getByText('未来宫殿 · 随本集原文使用 · 1条原文依据',{exact:true}).count(),0);
  await page.setViewportSize({width:390,height:850});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Read-only cards fit a narrow viewport');
  await page.setViewportSize({width:1280,height:900});
  await page.getByLabel('资产制作集数',{exact:true}).fill('2');
  assert.equal(await page.getByText('甲反锁铁门，躲到固定货架后。',{exact:true}).count(),0,'Scope changes hide previous episode cards');
  reviewFailure=true;await page.getByRole('button',{name:'查看本集文字生产卡',exact:true}).click();
  await page.getByRole('alert').getByText('来源读取期间已变化，请刷新。',{exact:true}).waitFor();
  assert.equal(requests.length,0,'409 never retries as paid generation');
  reviewFailure=false;await page.getByLabel('资产制作集数',{exact:true}).fill('1');
  await page.getByRole('button',{name:'整理剧本事实',exact:true}).click();
  await page.getByText('已开始整理第1集所需事实与材料依赖；不扫描生产全剧资产，不自动生成美术提示词。',{exact:true}).waitFor();
  assert.deepEqual(requests[0].episodeNumbers,[1]);
  await page.getByText('可选批量补充',{exact:true}).click();
  await page.getByRole('button',{name:'批量生图提示词（可选）· 1',exact:true}).click();
  await page.getByText('本轮完成 1 项。',{exact:true}).waitFor();
  assert.deepEqual(requests.filter(r=>r.action==='generate').map(r=>({key:r.key,episodes:r.episodeNumbers})),[{key:'first',episodes:[1]}]);
   const before=requests.length;await page.goto('http://scope.test/?episodes=1');await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text});await page.getByLabel('资产制作集数',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('[aria-label="资产制作集数"]')?.value==='1');assert.equal(requests.length,before,'linked scope is a read-only selection, not a generation request');
  assert.deepEqual(errors,[]);console.log('PASS selected-episode asset UI: existing text cards readable without generation, scope changes clear stale cards, read failure never dispatches, narrow layout, explicit scoped facts/prompts, future excluded; intercepted browser, DB/model calls 0');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
