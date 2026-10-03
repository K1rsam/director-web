import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium,type Browser} from 'playwright';
import {emptyPrompt,type PromptWorkspace,type PromptAsset} from '../lib/asset-prompt-contract';

const origin='http://asset-scope.invalid';
const assets:PromptAsset[]=[{key:'first',name:'测试仓库',episodes:[1,2,99]},{key:'second',name:'测试宫殿',episodes:[2,4]},{key:'future',name:'未来城堡',episodes:[9]},{key:'zero',name:'序章旧资产',episodes:[0]}].map(a=>({...a,baseKey:a.key,baseName:a.name,type:'LOC',variant:false,mode:'REFERENCE',description:'不应作为原文的旧描述',note:'',evidence:[{label:a.key+'原文',text:a.key+' 的独有原文依据。'}],reasons:[],eligible:true,fingerprint:'source'}));
const base:PromptWorkspace={projectId:'scope',title:'资产范围测试',style:'',stylePrefix:'',styleRevision:0,assets,records:{},busy:false,visualFactsStatus:'READY'};
const automation=(status:'RUNNING'|'COMPLETE')=>({id:'facts',sourceVersion:'source',mode:'FACTS' as const,status,done:status==='COMPLETE'?2:0,total:2,failed:0,error:'',updatedAt:new Date(0).toISOString()});
const record=(key:string,body:string,revision=1)=>({...emptyPrompt(key),status:'READY' as const,body,revision,fingerprint:'source',facts:key+' 已保存原文依据',suggestions:key+' 设计补足'});
interface Read {path:string;episodes:string|null;view:string|null}
interface Post {path:string;action:string;key?:string;episodeNumbers?:number[];revision?:number;body?:string}
async function fixture(browser:Browser,js:string,css:string,initial:PromptWorkspace=base,productionEpisodes:number[]=[1,2,4]){
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
 await page.clock.install();await page.clock.pauseAt(new Date());
 const posts:Post[]=[],reads:Read[]=[],errors:string[]=[],external:string[]=[];
 let current=structuredClone(initial),reviewFailure=false;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(url.origin!==origin){external.push(url.origin);return route.abort();}
  if(request.method()!=='GET'){
   const input={...request.postDataJSON(),path} as Post;posts.push(input);
   assert.equal(path,'/projects/scope/asset-prompts/api','No image/browser/adoption POST is allowed in prompt fixtures');
   assert.ok(Number.isSafeInteger(input.revision)&&input.revision!>=0,'explicit mutation carries a revision');
   if(input.action==='prepare-facts'){current={...current,automation:automation('RUNNING')};return route.fulfill({json:current});}
   if(input.action==='generate'||input.action==='save'){
    const key=input.key!,next=record(key,input.action==='save'?input.body!:'生成的 '+key,(current.records[key]?.revision??0)+1);
    current={...current,records:{...current.records,[key]:next}};return route.fulfill({json:next});
   }
   throw new Error('Unexpected mutation '+input.action);
  }
  reads.push({path,episodes:url.searchParams.get('episodes'),view:url.searchParams.get('view')});
  if(path.endsWith('/adoption'))return route.fulfill({json:{projectId:'scope',canAdopt:false,assets:{}}});
  if(path.endsWith('/images'))return route.fulfill({json:{jobs:[]}});
  if(path.endsWith('/image-browser'))return route.fulfill({json:{configured:true,status:'READY',enabled:false,available:true,message:'测试连接就绪'}});
  if(path.endsWith('/api')){
   if(url.searchParams.get('view')==='production-cards'){
    if(reviewFailure)return route.fulfill({status:409,json:{error:'来源读取期间已变化，请刷新。'}});
    const numbers=(url.searchParams.get('episodes')??'').split(',').map(Number);
    return route.fulfill({json:{schema:'ASSET_PREPARATION_REVIEW_V1',projectId:'scope',episodes:numbers.map(n=>({episodeNumber:n,sourceVersion:'source',materialVersion:'material',readiness:'READY',reasons:[],directionStatus:'UNCONFIRMED',cards:assets.filter(a=>a.episodes.includes(n)).map(a=>({schema:'ASSET_PRODUCTION_CARD_V1',assetKey:a.key,name:a.name,type:'LOC',use:'ACTUAL_APPEARANCE',applicable:{episode:n,sceneKeys:[n+'-1']},sourceFacts:[{id:a.key+'-'+n,claim:'SOURCE',quote:`第${n}集 ${a.name}文字卡原文。`,association:'SCENE_ACTION',evidence:{domain:'EPISODE',episode:n,start:0,end:10}}],adoptedDesign:null,freeDesignScope:'不增加秘密出口或能力。',materialAvailability:'TEXT_ONLY',imageEvidence:'NO_PIXELS_READ',references:[],materialNeeds:[]}))}))}});
   }
   return route.fulfill({json:current});
  }
  if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:js});
  if(path==='/fixture.css')return route.fulfill({contentType:'text/css',body:css});
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/fixture.css"></head><body><main id="root"></main><script src="/fixture.js"></script></body></html>'});
  throw new Error('Unexpected fixture GET '+path);
 });
 await page.addInitScript({content:`window.fixtureProps=${JSON.stringify({initial,productionEpisodes})};`});
 await page.goto(origin+'/');
 const editor=page.getByRole('complementary',{name:'资产提示词编辑器'}),library=page.getByRole('region',{name:'资产设定库'});
 const label=(a:PromptAsset)=>a.variant?`${a.baseName} · ${a.name}`:a.name;
 await editor.getByRole('heading',{name:label(initial.assets[0]),exact:true}).waitFor();
 await page.getByText('Chrome 已就绪',{exact:true}).waitFor();
 async function select(key:string){const summary=page.getByText('项目画风与资料',{exact:true});if(await summary.evaluate(node=>(node.parentElement as HTMLDetailsElement).open))await summary.click();const a=initial.assets.find(a=>a.key===key)!;await library.getByRole('button',{name:new RegExp('^资产 · '+label(a)+' ·')}).click();await editor.getByRole('heading',{name:label(a),exact:true}).waitFor();}
 async function projectTools(){const summary=page.getByText('项目画风与资料',{exact:true});if(!await summary.evaluate(node=>(node.parentElement as HTMLDetailsElement).open))await summary.click();}
 async function batch(){const summary=page.getByText('批量补提示词',{exact:true});if(!await summary.evaluate(node=>(node.parentElement as HTMLDetailsElement).open))await summary.click();return library.getByRole('button',{name:/^补充当前筛选中/});}
 return {page,editor,library,posts,reads,select,projectTools,batch,setCurrent:(next:PromptWorkspace)=>{current=next;},current:()=>current,failReview:(value:boolean)=>{reviewFailure=value;},close:async()=>{assert.deepEqual(external,[],'All network stays in the isolated synthetic origin');assert.deepEqual(errors,[],'No browser errors');await context.close();}};
}
async function main(){
 const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{AssetPromptWorkspace}from'./app/projects/[projectId]/asset-prompts/workspace';createRoot(document.getElementById('root')).render(<AssetPromptWorkspace {...window.fixtureProps}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text;
 const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'})});
 try{
  for(const mode of ['single','batch','explicit'] as const){
   const f=await fixture(browser,js,css,{...base,visualFactsStatus:'MISSING'});
   try{
    assert.equal(await f.page.getByLabel('资产制作集数',{exact:true}).count(),0,'No manual episode scope field');
    assert.equal(await f.page.getByText('制作集数',{exact:true}).count(),0);
    assert.deepEqual(f.posts,[],'Opening the image workbench is read only');
    if(mode==='single')await f.editor.getByRole('button',{name:'生成初版',exact:true}).click();
    else if(mode==='batch')await (await f.batch()).click();
    else {await f.projectTools();await f.page.getByRole('button',{name:'核对所选资产的原文依据',exact:true}).click();}
    await f.page.getByRole('status').filter({hasText:mode==='explicit'?'已开始整理第1、2集':'正在核对所选资产的原文依据'}).waitFor();
    assert.deepEqual(f.posts.map(p=>({action:p.action,episodes:p.episodeNumbers})),[{action:'prepare-facts',episodes:mode==='batch'?[1,2,4]:[1,2]}]);
    f.setCurrent({...f.current(),visualFactsStatus:'READY',automation:automation('COMPLETE')});
    await f.page.clock.runFor(12000);await f.editor.getByRole('button',{name:'生成初版',exact:true}).waitFor({state:'visible'});
    await f.page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='生成初版'&&!b.disabled));
    assert.equal(f.posts.length,1,'Finishing fact preparation and polling never continue into prompts/images');
    console.log('PASS missing facts '+mode+': scoped prepare only, compact notice, completion/poll never auto-generates');
   }finally{await f.close();}
  }
  {
   const f=await fixture(browser,js,css,{...base,visualFactsStatus:'REVIEW',visualFactIssues:[{subjectKey:'second',message:'second 的事实待核对'}]});
   try{
    await f.editor.getByRole('button',{name:'生成初版',exact:true}).click();await f.page.getByRole('status').filter({hasText:'本轮完成 1 项。'}).waitFor();
    assert.deepEqual(f.posts.map(p=>({action:p.action,key:p.key,episodes:p.episodeNumbers})),[{action:'generate',key:'first',episodes:[1,2]}],'Unrelated REVIEW issue permits exact selected scope');
    await f.select('second');await f.editor.getByRole('button',{name:'生成初版',exact:true}).click();await f.page.waitForFunction(()=>document.querySelector('textarea[aria-label="资产外观提示词"]')?.textContent==='生成的 second');
    assert.deepEqual(f.posts[1].episodeNumbers,[2,4]);
    await f.select('future');assert.equal(await f.editor.getByRole('button',{name:'生成初版',exact:true}).isDisabled(),true);
    await f.projectTools();assert.equal(await f.page.getByRole('button',{name:'核对所选资产的原文依据',exact:true}).isDisabled(),true);assert.equal(await f.page.getByRole('button',{name:'查看本集文字生产卡',exact:true}).isDisabled(),true);
    assert.equal(await f.editor.getByRole('button',{name:'生成图片',exact:true}).isDisabled(),true);
    await f.select('zero');assert.equal(await f.editor.getByRole('button',{name:'生成初版',exact:true}).isDisabled(),true);
    console.log('PASS single prompt scope intersects actual appearances and authority; unrelated issues permit generation; future/zero cannot dispatch');
   }finally{await f.close();}
  }
  {
   const f=await fixture(browser,js,css,{...base,visualFactIssues:[{subjectKey:'first',message:'first 专属事实问题'},{subjectKey:'second',message:'second 专属事实问题'},{subjectKey:'first',message:'first 非阻断建议',blocking:false},{subjectKey:'second',message:'second 非阻断建议',blocking:false}]});
   try{
    await f.editor.getByText('此资产有待核对资料',{exact:true}).click();await f.editor.getByText('first 专属事实问题',{exact:true}).waitFor();
    assert.equal(await f.editor.getByText('second 专属事实问题',{exact:true}).count(),0);
    await f.editor.getByText('原文依据与设计补足',{exact:true}).click();await f.editor.getByText('first 的独有原文依据。',{exact:true}).waitFor();
    assert.equal(await f.editor.getByText('second 的独有原文依据。',{exact:true}).count(),0);
    await f.editor.getByText('first 非阻断建议',{exact:true}).waitFor();assert.equal(await f.editor.getByText('second 非阻断建议',{exact:true}).count(),0);
    const draft='保留人工编辑的门与通路。';await f.editor.getByLabel('资产外观提示词',{exact:true}).fill(draft);
    assert.equal(await f.page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false,'Unsaved draft protects leaving');
    await f.select('second');await f.editor.getByRole('button',{name:'生成初版',exact:true}).click();await f.page.getByRole('status').filter({hasText:'本轮完成 1 项。'}).waitFor();
    await f.select('first');assert.equal(await f.editor.getByLabel('资产外观提示词',{exact:true}).inputValue(),draft,'Other asset generation/refresh preserve dirty draft');
    assert.equal(await f.editor.getByRole('button',{name:'生成初版',exact:true}).isDisabled(),true);
    await f.library.getByLabel('搜索资产',{exact:true}).fill('测试仓库');assert.equal(await (await f.batch()).isDisabled(),true,'Dirty draft cannot be overwritten by batch');
    await f.editor.getByLabel('资产外观提示词',{exact:true}).fill('');assert.equal(await f.page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true,'Reverting empty draft is clean');assert.equal(await f.library.getByText('有未保存编辑',{exact:true}).count(),0);
    await f.editor.getByLabel('资产外观提示词',{exact:true}).fill(draft);await f.editor.getByRole('button',{name:'保存提示词',exact:true}).click();await f.page.getByRole('status').filter({hasText:'此资产的提示词已保存。'}).waitFor();
    assert.equal(await f.page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true,'Saved draft clears leave protection');
    assert.deepEqual(f.posts.map(p=>p.action),['generate','save']);
    console.log('PASS selected evidence/issues/advice only; dirty drafts survive asset switching and other generation, block rewrite/batch, protect leaving and clean after revert/save');
   }finally{await f.close();}
  }
  {
   const f=await fixture(browser,js,css);
   try{
    await f.projectTools();await f.page.getByRole('button',{name:'查看本集文字生产卡',exact:true}).click();await f.page.getByText('第1集 · 1张文字卡 · 0项已采用设计',{exact:true}).waitFor();
    assert.deepEqual(f.reads.filter(r=>r.view==='production-cards').map(r=>r.episodes),['1,2']);
    await f.page.getByText('第1集 · 1张文字卡 · 0项已采用设计',{exact:true}).click();await f.page.getByText('测试仓库 · 随本集原文使用 · 1条原文依据',{exact:true}).first().click();await f.page.getByText('第1集 测试仓库文字卡原文。',{exact:true}).waitFor();
    await f.page.setViewportSize({width:390,height:850});assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Workbench and read-only cards fit narrow viewport');await f.page.setViewportSize({width:1280,height:900});
    await f.select('second');assert.equal(await f.page.getByText('第1集 测试仓库文字卡原文。',{exact:true}).count(),0,'Selection scope change hides old cards');
    f.failReview(true);await f.projectTools();await f.page.getByRole('button',{name:'查看本集文字生产卡',exact:true}).click();await f.page.getByRole('alert').getByText('来源读取期间已变化，请刷新。',{exact:true}).waitFor();
    await f.page.clock.runFor(30000);assert.deepEqual(f.posts,[],'Browsing, text-card failure and all polling never dispatch');
    console.log('PASS authority-scoped production-card reads, stale cards hidden on selection, 409 no dispatch, narrow viewport and 30s read-only polling');
   }finally{await f.close();}
  }
  {
   const f=await fixture(browser,js,css,base,[]);
   try{assert.equal(await f.editor.getByRole('button',{name:'生成初版',exact:true}).isDisabled(),true);await f.projectTools();assert.equal(await f.page.getByRole('button',{name:'查看本集文字生产卡',exact:true}).isDisabled(),true);await f.page.clock.runFor(10000);assert.deepEqual(f.posts,[],'Empty authority does not fall back to whole series');console.log('PASS empty authoritative production range stays read only');}finally{await f.close();}
  }
  {
   const parent:PromptAsset={...assets[0],key:'parent',baseKey:'parent',name:'母仓库',baseName:'母仓库',episodes:[9]},child:PromptAsset={...assets[0],key:'child',baseKey:'parent',name:'蓝色版',baseName:'母仓库',variant:true,fromKey:'parent',episodes:[2]};
   const f=await fixture(browser,js,css,{...base,assets:[child,parent,assets[2]]});
   try{
    await (await f.batch()).click();await f.page.getByRole('status').filter({hasText:'本轮完成 2 项。'}).waitFor();
    assert.deepEqual(f.posts.filter(p=>p.action==='generate').map(p=>({key:p.key,episodes:p.episodeNumbers})),[{key:'parent',episodes:[2]},{key:'child',episodes:[2]}],'A necessary parent with no production appearances remains in dependency order; unrelated future roots are excluded');
    console.log('PASS batch root scope preserves an out-of-appearance necessary parent/fromKey dependency, parent before child');
   }finally{await f.close();}
  }
  {
   const f=await fixture(browser,js,css);
   try{
    f.setCurrent({...base,assets:assets.map(a=>a.key==='first'?{...a,episodes:[9]}:a)});
    await f.editor.getByRole('button',{name:'生成初版',exact:true}).click();await f.page.getByRole('status').waitFor();
    assert.equal(f.posts.length,0,'Latest material revalidation rejects a root that lost its production intersection before prepare/generate');
    assert.deepEqual(f.reads.filter(r=>r.path.endsWith('/api')&&!r.view).map(r=>r.episodes),['1,2']);
    console.log('PASS freshly changed asset appearance scope cannot launch a stale selected-root request');
   }finally{await f.close();}
  }
  {
   const f=await fixture(browser,js,css);
   try{
    await (await f.batch()).click();await f.page.getByRole('status').filter({hasText:/本轮完成 \d+ 项。/}).waitFor();
    const generates=f.posts.filter(p=>p.action==='generate');
    assert.deepEqual(generates.map(p=>p.key),['first','second'],'Batch must exclude assets with no actual production intersection');
    assert.ok(generates.every(p=>JSON.stringify(p.episodeNumbers)==='[1,2,4]'),'Batch uses only actual asset union intersect authority');
    assert.deepEqual(f.reads.filter(r=>r.path.endsWith('/api')&&!r.view).map(r=>r.episodes),['1,2,4']);
    console.log('PASS batch only dispatches needed asset keys and episode union; future/zero excluded');
   }finally{await f.close();}
  }
  console.log('PASS image workbench browser regression: authoritative asset scopes, missing-facts stop, single/batch routing, draft/leave protection, selected evidence, read-only browsing/polling. All HTTP intercepted; real model/ChatGPT/production DB calls 0.');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
