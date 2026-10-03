/** Actual client components, production styles and intercepted in-memory responses only. */
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium,type Page} from 'playwright';
import type {ScriptReceptionView} from '../lib/script-resolution-service';
import type {SeriesDirectionWorkspace} from '../lib/series-direction-service';
import type {PromptWorkspace,PromptAsset} from '../lib/asset-prompt-contract';
import type {AssetDesignAdoptionWorkspace} from '../lib/asset-design-adoption';
import {emptyImageOptions,imageTemplatesFor} from '../lib/asset-image-options';

const projectId='upstream-offline';
const script=(number:number):ScriptReceptionView=>({projectId,title:'上游组合离线样例',canConfirm:true,assistProviders:{project:'CLI',jevConfigured:true},episodes:[{number:1,title:'门口'},{number:2,title:'院内'}],selected:{number,title:number===1?'门口':'院内',sourceVersion:`script-${number}`,revision:0,status:'NONE',sourceText:number===1?'第一集\n人物：甲\n甲：这句有明确说者。\n下一行待核对。':'第二集\n人物：乙\n乙：我看见了。',readingText:number===2?'【标准阅读 · 语义未验收】\n乙：我看见了。':null,ready:number===2,lines:number===1?[
 {line:1,unitId:'a1',entryId:'line-1',target:'STRUCTURE',kind:'EPISODE_HEADING',text:'第一集\n'},
 {line:2,unitId:'a2',entryId:'line-2',target:'STRUCTURE',kind:'SCENE_METADATA',text:'人物：甲\n'},
 {line:3,unitId:'a3',entryId:'line-3',target:'BODY',kind:'DIALOGUE',speaker:'甲',channel:'SPEECH',text:'甲：这句有明确说者。\n'},
 {line:4,unitId:'a4',entryId:null,target:'UNRESOLVED',kind:'UNRESOLVED',text:'下一行待核对。'}
 ]:[{line:1,unitId:'b1',entryId:'line-1',target:'STRUCTURE',kind:'EPISODE_HEADING',text:'第二集\n'},{line:2,unitId:'b2',entryId:'line-2',target:'STRUCTURE',kind:'SCENE_METADATA',text:'人物：乙\n'},{line:3,unitId:'b3',entryId:'line-3',target:'BODY',kind:'DIALOGUE',speaker:'乙',channel:'SPEECH',text:'乙：我看见了。'}],diagnostics:number===1?[{line:4,code:'AMBIGUOUS_CONTINUATION',message:'请核对这一行是动作还是前一句的延续。'}]:[],decisions:[],history:[],assistance:[]}});
const direction:SeriesDirectionWorkspace={source:{sourceVersion:'whole-source',episodes:[{id:'e1',number:1,title:'门口'},{id:'e2',number:2,title:'院内'}],evidence:[{id:'e1',kind:'EPISODE',title:'第1集原文'},{id:'e2',kind:'EPISODE',title:'第2集原文'}],warnings:[],blocker:null},stateToken:'direction-0',status:'UNCONFIRMED',draft:null,current:null,draftOrigin:null,draftReviewed:false,draftBrief:null,draftIssue:null,brief:null,permissions:{canEdit:true,canConfirm:true},generationPlan:{batches:1,calls:2,characters:160,allowed:true,reason:null},generation:null,history:[]};
const asset=(key:string,name:string,type:PromptAsset['type'],extra:Partial<PromptAsset>={}):PromptAsset=>({key,baseKey:key,name,baseName:name,type,variant:false,episodes:[1,2],mode:'REFERENCE',description:'',note:'',evidence:[{label:'离线原文依据',text:`原文明示${name}的必要特征，未声称图片已生成。`}],reasons:[],eligible:true,fingerprint:`source-${key}`,...extra});
const assets=[asset('hero','甲','CH'),asset('rain','雨衣版','CH',{baseKey:'hero',baseName:'甲',variant:true,fromKey:'hero',mode:'DERIVE',episodes:[2]}),asset('yard','院落','LOC'),asset('key','钥匙','PROP',{mode:'INLINE',eligible:false})];
const workspace:PromptWorkspace={projectId,title:'上游组合离线样例',style:'3D国漫',stylePrefix:'3D国漫风格，细腻材质与统一人物比例',styleRevision:0,visualFactsStatus:'READY',visualFactIssues:[],seriesDirection:{status:'UNCONFIRMED',brief:null},busy:false,assets,
 records:Object.fromEntries(assets.map(a=>[a.key,{schema:'ASSET_PROMPT_V1',key:a.key,revision:1,status:'READY',body:a.key==='hero'?'白衣黑发，衣领与袖口细节完整保留。':a.key==='rain'?'沿用甲的五官与体态，外加深蓝雨衣。':a.key==='yard'?'院门与台阶位置明确，石墙保留潮湿材质。':'一把黄铜钥匙，随场出现，无需独立出图。',facts:'原文明示信息仍以出处为准。',suggestions:'待人工核对设计补足。',error:'',fingerprint:a.fingerprint,updatedAt:'2026-09-28T00:00:00.000Z',origin:'MANUAL',...(a.variant?{referenceKey:'hero',referenceRevision:1}:{})}])),imageOptions:Object.fromEntries(assets.map(a=>[a.key,emptyImageOptions()]))};
const adoption:AssetDesignAdoptionWorkspace={projectId,canAdopt:true,assets:Object.fromEntries(assets.map(a=>[a.key,{assetKey:a.key,revision:0,materialToken:`material-${a.key}`,status:'UNADOPTED',canAdopt:true,reason:'',current:null,references:[],history:[]}]))};

async function noHorizontalOverflow(page:Page,label:string){
 const overflow=await page.evaluate(()=>({width:window.innerWidth,document:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('button,input,select,textarea')].map(node=>({node,rect:node.getBoundingClientRect()})).filter(({node,rect})=>rect.width>0&&rect.height>0&&(rect.right>window.innerWidth+1||rect.left< -1)&&!node.closest('[hidden]')).map(({node,rect})=>({label:node.getAttribute('aria-label')||node.textContent?.trim().slice(0,45)||node.tagName,left:Math.round(rect.left),right:Math.round(rect.right)})).slice(0,12)}));
 assert.ok(overflow.document<=overflow.width,`${label}: document overflow ${JSON.stringify(overflow)}`);assert.deepEqual(overflow.controls,[],`${label}: clipped or overflowing controls`);
}
async function main(){
 const built=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import'./app/globals.css';import'./app/vision-studio.css';import'./app/page-surfaces.css';import'./app/workbench-refinement.css';import{ScriptReceptionPanel}from'./app/projects/[projectId]/script-reception-panel';import{SeriesDirectionPanel}from'./app/projects/[projectId]/series-direction-panel';import{AssetPromptWorkspace}from'./app/projects/[projectId]/asset-prompts/workspace';import styles from'./app/projects/[projectId]/asset-prompts/workspace.module.css';const root=createRoot(document.getElementById('root'));function Frame({children,asset}){return <div className={asset?styles.shell:undefined}><div className="appChrome" data-section={asset?'assets':'project'}><aside className="appSidebar" aria-label="离线框架占位"><div className="chromeBrand"><strong>组合离线检查</strong></div><p>无账号、数据库或模型连接</p></aside><div className="appWorkspace"><header className="appTopbar"><div className="topbarIdentity"><small>{asset?'第二阶段 · 资产形象设计':'第一阶段 · 整理与定稿'}</small><h1 className="pageTitle">上游组合样例</h1></div></header><main className="appMain">{children}</main></div></div></div>}window.mount=mode=>root.render(<Frame key={mode} asset={mode==='assets'}>{mode==='assets'?<AssetPromptWorkspace initial={window.fixtures.workspace}/>:<div className="projectDashboard"><ScriptReceptionPanel projectId="${projectId}" initial={window.fixtures.script1}/><SeriesDirectionPanel projectId="${projectId}" initialWorkspace={window.fixtures.direction}/></div>}</Frame>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',executablePath=existsSync(chromium.executablePath())?chromium.executablePath():existsSync(chrome)?chrome:undefined;if(!executablePath)throw new Error('离线浏览器不可用；未安装或下载。');
 const browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--no-first-run']}),folder=mkdtempSync(path.join(tmpdir(),'upstream-ui-'));
 try{
  for(const width of [1440,390])for(const mode of ['preparation','assets']){
   const context=await browser.newContext({offline:true,viewport:{width,height:900}}),page=await context.newPage(),errors:string[]=[],unexpectedNetwork:string[]=[];
   page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
   await context.route('**/*',route=>{unexpectedNetwork.push(route.request().url());return route.abort();});
   await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
   await page.addStyleTag({content:built.outputFiles.find(file=>file.path.endsWith('.css'))!.text});
   await page.evaluate(fixtures=>{
    const state=window as any;state.fixtures=fixtures;state.requests=[];
    window.fetch=async(url,init)=>{
     const parsed=new URL(String(url),'http://offline.invalid'),body=init?.body?JSON.parse(String(init.body)):null;state.requests.push({path:parsed.pathname,method:init?.method??'GET',body});
     if(!body&&parsed.pathname.endsWith('/script-reception'))return Response.json(parsed.searchParams.get('episode')==='2'?state.fixtures.script2:state.fixtures.script1);
     if(!body&&parsed.pathname.endsWith('/series-direction'))return Response.json(state.fixtures.direction);
     if(parsed.pathname.endsWith('/adoption')){
      if(!body)return Response.json(state.fixtures.adoption);
      if(body.action!=='adopt')throw new Error('本组合检查没有授权此采用变更');
      const view=state.fixtures.adoption.assets[body.assetKey];if(body.expectedRevision!==view.revision)throw new Error('fixture CAS mismatch');
      const record={schema:'ASSET_DESIGN_ADOPTION_V1',action:'ADOPT',assetKey:body.assetKey,version:view.revision+1,actor:{id:'server-reviewer',name:'离线审阅者'},createdAt:'2026-09-28T00:00:00.000Z',brief:body.brief,referenceIds:body.referenceIds,references:[],previousVersion:null,sourceFingerprint:`source-${body.assetKey}`,factsFingerprint:'facts',promptRevision:1,promptFingerprint:'prompt',styleRevision:0,styleFingerprint:'style',referenceDependencies:[]};
      view.revision++;view.status='TEXT_ADOPTED';view.current=record;view.history.push(record);return Response.json(state.fixtures.adoption);
     }
     if(parsed.pathname.endsWith('/asset-prompts/api')){
      if(!body)return Response.json(state.fixtures.workspace);
      if(body.action==='image-template'){const next={...state.fixtures.workspace.imageOptions[body.key],...body,revision:body.revision+1};delete next.action;delete next.key;state.fixtures.workspace.imageOptions[body.key]=next;return Response.json(next);}
     }
     throw new Error(`未拦截的fixture请求：${parsed.pathname}/${body?.action??'GET'}`);
    };
   },{script1:script(1),script2:script(2),direction,workspace,adoption});
   await page.addScriptTag({content:built.outputFiles.find(file=>file.path.endsWith('.js'))!.text});await page.evaluate(mode=>(window as any).mount(mode),mode);
   if(mode==='preparation'){
    const scriptPanel=page.locator('#script-reception'),directionPanel=page.locator('#series-direction');await scriptPanel.getByRole('heading',{name:'剧本标准阅读'}).waitFor();await directionPanel.getByRole('heading',{name:'全剧创作方向'}).waitFor();
    assert.equal(await page.evaluate(()=>(window as any).requests.length),0,'prepared initial panels must not call APIs or models on mount');
    const tone=directionPanel.getByLabel('主调',{exact:true});await tone.fill('克制而温暖的轻喜剧');await directionPanel.getByRole('checkbox').check();
    await scriptPanel.getByLabel('选择待核对剧集').selectOption('2');await scriptPanel.getByText(/已自动识别，可供后续使用/).waitFor();
    await scriptPanel.getByRole('region',{name:'清洗正文'}).getByText('乙：我看见了。',{exact:true}).waitFor();
    assert.equal(await scriptPanel.getByRole('button',{name:/^核对第\d+行$/}).count(),0,'clear dialogue must not ask for per-line confirmation');
    const requestsBeforeView=await page.evaluate(()=>(window as any).requests.length);
    const originalView=scriptPanel.getByRole('button',{name:'接收原文',exact:true});await originalView.waitFor({timeout:1500});await originalView.click();
    await scriptPanel.getByRole('region',{name:'接收原文',exact:true}).getByText(/第二集/).waitFor();
    await scriptPanel.getByRole('button',{name:'标准稿',exact:true}).click();
    assert.equal(await page.evaluate(()=>(window as any).requests.length),requestsBeforeView,'switching original/standard text is local and never dispatches a request');
    await page.locator('.appMain').evaluate(element=>{element.scrollTop=0;});
    await page.screenshot({path:path.join(folder,`${mode}-${width}-clean.png`)});
    await scriptPanel.getByLabel('手动修正解析',{exact:true}).check();
    assert.equal(await scriptPanel.getByRole('button',{name:/^核对第\d+行$/}).count(),3,'optional manual correction remains available');
    assert.equal(await tone.inputValue(),'克制而温暖的轻喜剧');assert.equal(await directionPanel.getByRole('checkbox').isChecked(),true,'episode switching must not rewrite unrelated manual direction state');
    await scriptPanel.getByLabel('选择待核对剧集').selectOption('1');await scriptPanel.getByText('请核对这一行是动作还是前一句的延续。',{exact:true}).waitFor();
    assert.equal(await scriptPanel.getByLabel('手动修正解析',{exact:true}).isChecked(),false,'episode switching resets optional correction mode');
    await scriptPanel.getByLabel('辅助判断服务',{exact:true}).selectOption('JEV');assert.equal(await scriptPanel.getByLabel(/同意把所选及相邻/).isChecked(),false);await scriptPanel.getByLabel(/同意把所选及相邻/).check();
    assert.equal(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.method==='POST').length),0,'consent or selection changes never dispatch a model');
    assert.equal(await directionPanel.getByRole('button',{name:'确认采用',exact:true}).isDisabled(),true,'unsaved direction is not confirmed by neighboring panel activity');
    await noHorizontalOverflow(page,`${mode} ${width}`);await scriptPanel.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(folder,`${mode}-${width}-script.png`)});await directionPanel.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(folder,`${mode}-${width}-direction.png`)});
   }else{
    const library=page.getByRole('region',{name:'资产设定库'}),editor=page.getByRole('complementary',{name:'资产提示词编辑器'}),adoptionPanel=page.getByRole('region',{name:'设计采用与分镜交接'});
    await library.getByRole('heading',{name:'资产设定库'}).waitFor();await adoptionPanel.getByLabel('分镜简述',{exact:true}).fill('甲保持白衣、黑发；只传给分镜的简述。');
    const original=await editor.getByLabel('资产外观提示词',{exact:true}).inputValue();await editor.getByLabel('资产外观提示词',{exact:true}).fill(original+' 未保存的人工补充。');
    await library.getByRole('button',{name:/^道具/}).click();await library.getByRole('button').filter({hasText:'钥匙'}).click();await editor.getByRole('heading',{name:'钥匙',exact:true}).waitFor();await adoptionPanel.getByText('无需独立图 · 仅文字',{exact:true}).waitFor();
    assert.equal(await adoptionPanel.getByLabel('分镜简述',{exact:true}).inputValue(),'');await adoptionPanel.getByLabel('分镜简述',{exact:true}).fill('钥匙随场表现，无需独立图。');
    await library.getByRole('button',{name:/^人物/}).click();await library.getByRole('button').filter({has:page.locator('strong',{hasText:/^甲$/})}).click();
    assert.equal(await editor.getByLabel('资产外观提示词',{exact:true}).inputValue(),original+' 未保存的人工补充。');assert.equal(await adoptionPanel.getByLabel('分镜简述',{exact:true}).inputValue(),'甲保持白衣、黑发；只传给分镜的简述。','asset switching preserves independent draft briefs');
    await editor.getByLabel('资产外观提示词',{exact:true}).fill(original);await adoptionPanel.getByLabel('我已核对简述与当前已保存提示词').check();await adoptionPanel.getByRole('button',{name:'采用当前设计',exact:true}).click();await adoptionPanel.getByText('已采用 · 仅文字',{exact:true}).waitFor();
    await library.getByRole('button').filter({hasText:'雨衣版'}).click();await editor.getByRole('heading',{name:'甲 · 雨衣版',exact:true}).waitFor();assert.equal(await adoptionPanel.getByLabel('分镜简述',{exact:true}).inputValue(),'','base adoption never auto-adopts a variant');
    const template=imageTemplatesFor('CH').find(item=>item.id!=='none')!;await editor.getByText('外部生图准备 · 模板与参考图',{exact:true}).click();await editor.getByLabel('视图模板',{exact:true}).selectOption(template.id);await page.getByText('生图设置已保存。',{exact:true}).waitFor();
    await library.getByRole('button',{name:/^场景/}).click();await library.getByRole('button').filter({hasText:'院落'}).click();await editor.getByRole('heading',{name:'院落',exact:true}).waitFor();assert.equal(await adoptionPanel.getByLabel('分镜简述',{exact:true}).inputValue(),'');
    assert.equal(await adoptionPanel.getByRole('status').filter({hasText:'已采用此简述'}).count(),0,'switching assets cannot carry another asset adoption-success notice');
    assert.equal(await editor.getByRole('button',{name:/生成资产图片/}).count(),0);
    const adoptedCard=library.getByRole('button').filter({has:page.locator('strong',{hasText:/^甲$/})});
    await library.getByRole('button',{name:/^人物/}).click();assert.match(await adoptedCard.innerText(),/已采用 · 文字/,'real adoption status is reflected in the asset library without an extra request');
    await library.getByRole('button',{name:/^场景/}).click();
    const confirmationSize=await adoptionPanel.getByLabel('我已核对简述与当前已保存提示词').evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,labelHeight:node.closest('label')!.getBoundingClientRect().height}));
    assert.ok(confirmationSize.width<=24&&confirmationSize.height<=24,`adoption checkbox must not inherit full-width text-input sizing: ${JSON.stringify(confirmationSize)}`);assert.ok(confirmationSize.labelHeight<100,`confirmation must remain readable prose, not one character per line: ${JSON.stringify(confirmationSize)}`);
    const mutations=await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.method==='POST').map((r:any)=>r.body));assert.deepEqual(mutations.map((body:any)=>body.action),['adopt','image-template']);assert.equal(mutations[0].actorId,undefined);assert.equal(mutations[0].brief,'甲保持白衣、黑发；只传给分镜的简述。');
    await noHorizontalOverflow(page,`${mode} ${width}`);await adoptionPanel.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(folder,`${mode}-${width}-adoption.png`)});
   }
   const beforeFontChange=await page.evaluate(()=>(window as any).requests.length);await page.evaluate(()=>document.documentElement.style.fontSize='24px');
   await noHorizontalOverflow(page,`${mode} ${width} 150% font`);await page.screenshot({path:path.join(folder,`${mode}-${width}-font150.png`)});
   assert.equal(await page.evaluate(()=>(window as any).requests.length),beforeFontChange,'text enlargement is presentation-only');
   assert.deepEqual(errors,[],`${mode}/${width}: console or runtime errors`);assert.deepEqual(unexpectedNetwork,[],`${mode}/${width}: requests outside the intercepted fetch boundary`);await context.close();console.log(`PASS combined ${mode} ${width}px + 150% font: real components/styles, isolated mocked fetch, no overflow/console errors/model calls`);
  }
  console.log(`Screenshots: ${folder}; production DB/model/network calls 0.`);
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
