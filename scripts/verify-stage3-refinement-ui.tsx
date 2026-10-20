/** Public projection and real optional-refinement UI; synthetic input, no DB/server/model. */
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const require=createRequire(import.meta.url);
const {publicRun}=require('../runtime/storyboard-v4/input.mjs');
const {refinementAssemblyHash,freezeDirectorRefinement,DIRECTOR_REFINEMENT_VERSION}=require('../runtime/storyboard-v4/core/director-refinement.mjs');
const {baseDraftHash,DELTA_VERSION}=require('../runtime/storyboard-v4/core/delta.mjs');
const version='director-refinement-v2'; // Frozen legacy UI must keep its original event/unit selection behavior.
function fixture(){
 return {id:'refine-fixture',epoch:0,status:'text_ready_for_review',source:{sourceRows:[1,2,3,4,5,6].map(n=>({id:`S${n}`,text:`事件${Math.ceil(n/2)}原文${n%2?'起点':'终点'}`,lineNo:n})),context:{}},settings:{maxUnitSeconds:30,fantasyMode:'off'},choice:{mode:'off'},
  plan:{emotionArc:'测试连续事件',events:[1,2,3].map(n=>({id:`E${n}`,title:`事件${n}`,sourceRefs:[`S${n*2-1}`,`S${n*2}`]})),workPackages:[],provisionalUnits:[],fantasyCandidates:[]},adopted:[],operations:[],candidates:[],
  assembly:{text:'已采用完整基稿',validation:{errors:[],warnings:[]},draft:{schemaVersion:'performance-core-v4',units:[1,2,3,4].map(n=>({id:`U${n}`,eventId:n<=2?'E1':`E${n-1}`,title:`完整单元${n}`,sourceRefs:n<=2?[`S${n}`]:[`S${(n-1)*2-1}`,`S${(n-1)*2}`],shots:[{id:`H${n}`,duration:10,sourceRefs:n<=2?[`S${n}`]:[`S${(n-1)*2-1}`,`S${(n-1)*2}`]}]})),fantasyRealization:[]}},
  rulesSnapshot:{directorRefinementVersion:version,files:{'skills/director-refinement/SKILL.md':'PRIVATE SKILL BODY'}},privateState:'PRIVATE STATE',
  web:{createdAt:'2026-10-04T00:00:00Z',progress:'text_ready_for_review',budget:{maxCalls:32,maxTokens:300000}}};
}
async function main(){
 const saved:any=fixture(),view=publicRun(saved),basis=refinementAssemblyHash(saved),scope=view.refinement.scope;
 assert.equal(view.refinementVersion,version,'a supported task exposes the refinement marker');
 assert.equal(view.refinement.basisHash,basis,'UI binds adoption to the exact assembled basis');
 assert.equal(view.refinement.available,true);
 assert.deepEqual(view.refinement.eventIds,['E1','E2','E3']);
 assert.equal(view.refinement.targeted,true);assert.equal(view.seriesDirectionStatus,'not_adopted');
 assert.equal(scope.unitCount,4);assert.equal(scope.shotCount,4);assert.equal(scope.wholeEpisode,true);
 assert.deepEqual(scope.events[0].sourceStart,{id:'S1',text:'事件1原文起点',lineNo:1});assert.deepEqual(scope.events[0].sourceEnd,{id:'S2',text:'事件1原文终点',lineNo:2});
 assert.deepEqual(scope.units.map((unit:any)=>unit.id),['U1','U2','U3','U4']);
 const refinement=freezeDirectorRefinement(saved,[],['E1'],{unitIds:['U1'],reviewNotes:'反应重音重复',preserveNotes:'保留人物慢说'});
 const refinedDraft=structuredClone(saved.assembly.draft);refinedDraft.units[0].shots[0].picture='听者接住话尾';
 saved.operations=[{attemptId:'RF1',stage:'finish',packageIds:[],status:'completed',purpose:'director_refinement',refinement,receipt:{requestOutcome:'RESPONDED',usage:{inputTokens:10,outputTokens:5,cachedInputTokens:0,totalTokens:15}}}];
 saved.candidates=[{id:'RC1',attemptId:'RF1',stage:'finish',packageIds:[],status:'refinement_ready',purpose:'director_refinement',refinement,draft:refinedDraft,previewText:'完整精修候选正文',validation:{errors:[],warnings:[]},adoptionBlocked:null,raw:'PRIVATE RAW',output:{private:'PRIVATE OUTPUT',reviewDecisions:[{unitIds:['U1'],disposition:'changed',reason:'保留气口承接，收紧重复反应',preservedFunction:'人物慢说'}]}}];
 const projected=publicRun(saved);
 assert.equal(projected.refinement.available,false,'one completed refinement removes another paid request');
 assert.equal(projected.candidates[0].refinement.version,version);assert.equal(projected.candidates[0].refinement.baseAssemblyHash,basis);assert.deepEqual(projected.candidates[0].refinement.eventIds,['E1']);
 assert.equal(projected.candidates[0].previewText,'完整精修候选正文');
 assert.equal(projected.operations[0].purpose,'director_refinement');
 assert.equal(projected.candidates[0].adoptionBlocked,null);
 assert.equal(projected.candidates[0].refinement.comparison.status,'changed');assert.deepEqual(projected.candidates[0].refinement.comparison.changedUnitIds,['U1']);assert.deepEqual(projected.candidates[0].refinement.comparison.changedShotIds,['H1']);
 assert.equal(projected.candidates[0].refinement.scope.unitCount,1);assert.equal(projected.candidates[0].refinement.scope.wholeEpisode,false);assert.deepEqual(projected.candidates[0].refinement.reviewDecisions[0].unitIds,['U1']);
 assert.ok(!/PRIVATE|\/private\/path/.test(JSON.stringify(projected)),'public projection excludes frozen skill, paths, raw responses and private state');
 assert.equal(projected.assembly.text,'已采用完整基稿');
 const selectable=structuredClone(saved);
 Object.assign(selectable.candidates[0].output,{schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(selectable.assembly.draft),retainedUnitIds:['U2','U3','U4'],replacements:[{replaces:['U1'],units:[refinedDraft.units[0]],fantasyRealization:[]}]});
 const selectableView=publicRun(selectable),group=selectableView.candidates[0].refinement.acceptanceGroups[0];
 assert.match(group.id,/^rg-/);assert.deepEqual(group.replacedUnitIds,['U1']);assert.deepEqual(group.proposedUnitIds,['U1']);
 const partialSaved=structuredClone(selectable),partialCandidate=partialSaved.candidates[0];
 partialSaved.refinementArchives=[{candidateId:'RC1',baseAssemblyHash:basis,assembly:structuredClone(saved.assembly),adopted:[]}];
 partialCandidate.status='adopted';partialCandidate.adoptedRefinement={version:'refinement-group-selection-v1',groupIds:[group.id],partial:true,retainedUnitIds:['U2','U3','U4'],at:'2026-10-05T00:00:00Z',draft:refinedDraft,text:'实际采用稿正文',validation:{errors:[],warnings:[]},privatePath:'/private/path',private:'PRIVATE ADOPTION'};
 partialSaved.assembly={...partialSaved.assembly,draft:refinedDraft,text:'实际采用稿正文'};
 const partialProjected=publicRun(partialSaved);
 assert.equal(partialProjected.candidates[0].previewText,'实际采用稿正文','public preview uses the actual adopted output, not the unselected full candidate');
 assert.deepEqual(partialProjected.candidates[0].adoptedRefinement,{version:'refinement-group-selection-v1',groupIds:[group.id],partial:true,retainedUnitIds:['U2','U3','U4'],at:'2026-10-05T00:00:00Z'});
 assert.ok(!/PRIVATE|\/private\/path/.test(JSON.stringify(partialProjected)),'adoption projection does not expose raw candidate metadata or duplicate the complete draft');
 const sameSaved=structuredClone(saved);sameSaved.candidates[0].draft=structuredClone(sameSaved.assembly.draft);sameSaved.candidates[0].previewText=sameSaved.assembly.text;sameSaved.candidates[0].output.reviewDecisions[0].disposition='retained';
 const unchangedProjected=publicRun(sameSaved);assert.equal(unchangedProjected.candidates[0].refinement.comparison.status,'unchanged');
 const unknownSaved=structuredClone(saved);unknownSaved.assembly.text='基稿已变化';const unavailableProjected=publicRun(unknownSaved);assert.equal(unavailableProjected.candidates[0].refinement.comparison.status,'unavailable');
 const v1Saved:any=fixture();v1Saved.rulesSnapshot.directorRefinementVersion='director-refinement-v1';v1Saved.source.context.seriesDirection={brief:'已采用全剧方向'};const v1Projected=publicRun(v1Saved);assert.equal(v1Projected.refinement.targeted,false);assert.equal(v1Projected.seriesDirectionStatus,'adopted');
 const legacy=fixture();delete (legacy as any).rulesSnapshot.directorRefinementVersion;assert.equal(publicRun(legacy).refinementVersion,undefined);
 for(const options of [{active:true},{sourceStale:true}])assert.equal(publicRun(fixture(),options).refinement.available,false);

 const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import'./app/globals.css';import'./app/vision-studio.css';import{RefinementPanel,productionViewRun}from'./app/projects/[projectId]/episodes/[episodeId]/storyboard/refinement-panel';import{derivePhaseSteps}from'./app/projects/[projectId]/episodes/[episodeId]/storyboard/view-state';window.calls=[];const root=createRoot(document.getElementById('root'));window.render=run=>{window.phases=derivePhaseSteps(productionViewRun(run),true);flushSync(()=>root.render(<RefinementPanel run={run} endpoint="/api/episodes/fixture/storyboard" disabled={false} pending="" act={async(action,payload)=>{window.calls.push({action,payload});return null}}/>))};`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outdir:'out',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:'chrome'}),args:['--disable-background-networking']}),folder=mkdtempSync(path.join(tmpdir(),'stage3-refinement-ui-'));
 try{for(const width of [1440,390]){
  const context=await browser.newContext({offline:true,viewport:{width,height:900}}),page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(4000);
  page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>{errors.push(`unexpected request: ${route.request().url()}`);return route.abort();});
  await page.setContent('<meta charset="UTF-8"><div id="root"></div>');await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text});await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text});
  const mount=async(run:unknown)=>{await page.evaluate(value=>(window as any).render(value),run);};
  const ready={...view,adopted:[{stage:'finish',packageIds:[],unitCount:4,shotCount:4,seconds:40}]};
  const v3Ready={...ready,id:'v3-whole',refinementVersion:DIRECTOR_REFINEMENT_VERSION};
  const loading={...v3Ready,id:'v3-late-scope',assembly:null,refinement:undefined};
  await mount(loading);assert.equal(await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).count(),0);
  await mount({...v3Ready,id:loading.id});
  await page.getByText('本次范围：3个事件 · 4个完整单元 · 4镜 · 全集',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).isDisabled(),false,'a scope arriving after generation defaults to the whole episode');
  await page.getByRole('checkbox',{name:'选择事件3',exact:true}).uncheck();
  await page.getByLabel('具体观看问题',{exact:true}).fill('保留正在编辑的问题');
  await mount({...v3Ready,id:loading.id});
  assert.equal(await page.getByRole('checkbox',{name:'选择事件3',exact:true}).isChecked(),false,'polling does not replace a manual scope with the default');
  assert.equal(await page.getByLabel('具体观看问题',{exact:true}).inputValue(),'保留正在编辑的问题');
  await mount(v3Ready);await page.getByText('本次范围：3个事件 · 4个完整单元 · 4镜 · 全集',{exact:true}).waitFor();
  assert.equal(await page.getByRole('checkbox',{name:'选择事件3',exact:true}).isChecked(),true);
  await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>(window as any).calls.at(-1)),{action:'refine',payload:{eventIds:['E1','E2','E3'],unitIds:['U1','U2','U3','U4'],reviewNotes:'',preserveNotes:'',expectedBaseHash:basis}},'v3 actively scans the whole episode with empty notes');
  await mount({...projected,id:'v3-no-change',refinementVersion:DIRECTOR_REFINEMENT_VERSION,candidates:[{...projected.candidates[0],status:'refinement_no_change',refinement:{...projected.candidates[0].refinement,version:DIRECTOR_REFINEMENT_VERSION,comparison:{status:'unchanged',changedUnitIds:[],changedShotIds:[]},reviewDecisions:[]},previewText:projected.assembly.text}]});
  await page.getByText('未产生改善，保留原稿',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'采用此精修候选 · 免费',exact:true}).count(),0);
  const changed={...projected,candidates:[{...projected.candidates[0],refinement:{...projected.candidates[0].refinement,acceptanceGroups:[
   {id:'RG1',replacedUnitIds:['U1'],proposedUnitIds:['RU1'],reasons:['保留原有作用，改变第一组声画安排']},
   {id:'RG2',replacedUnitIds:['U2'],proposedUnitIds:['RU2'],reasons:['第二组仅供审看，不默认采用']}
  ]}}]},unchanged=unchangedProjected;
  await mount(unchanged);await page.getByText('已采用完整基稿',{exact:true}).waitFor();
  assert.equal(await page.getByText('无改动，保留原稿',{exact:true}).count(),1,'an identical result is visibly unchanged');
  assert.equal(await page.getByRole('button',{name:'采用此精修候选 · 免费',exact:true}).count(),0,'an identical result has no adopt action');
  assert.equal(await page.getByRole('link',{name:'下载盲审材料',exact:true}).count(),0,'an identical result is not presented as an A/B comparison');
  assert.equal(await page.getByRole('link',{name:'下载单稿复核',exact:true}).getAttribute('href'),'/api/episodes/fixture/storyboard?runId=refine-fixture&format=review&candidateId=RC1');
  await mount(unavailableProjected);
  await page.getByText('改动尚无法核对，保留原稿',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'采用此精修候选 · 免费',exact:true}).count(),0);assert.equal(await page.getByRole('link',{name:'下载盲审材料',exact:true}).count(),0);
  await mount({...v1Projected,id:'legacy-fixture'});await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).waitFor();
  assert.equal(await page.getByLabel('具体观看问题',{exact:true}).count(),0,'a frozen v1 task is not upgraded to a work order');assert.equal(await page.getByRole('checkbox',{name:'选择完整单元 U1',exact:true}).count(),0);
  await page.getByRole('checkbox',{name:'选择事件2',exact:true}).check();await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).calls.at(-1)),{action:'refine',payload:{eventIds:['E1','E2'],expectedBaseHash:basis}},'v1 keeps its frozen event-only request');
  const wholeScope={...scope,wholeEpisode:true,events:[scope.events[0],{...scope.events[1],unitIds:['U3','U4'],shotIds:['H3','H4'],unitCount:2,shotCount:2,sourceEnd:scope.events[2].sourceEnd}],units:scope.units.map(unit=>({...unit,eventId:unit.id==='U4'?'E2':unit.eventId}))};
  await mount({...ready,id:'whole-fixture',refinement:{...ready.refinement,scope:wholeScope,eventIds:['E1','E2']}});await page.getByRole('checkbox',{name:'选择事件2',exact:true}).check();
  assert.equal(await page.getByText('本次范围：2个事件 · 4个完整单元 · 4镜 · 全集',{exact:true}).count(),1,'a complete selection is explicitly marked as a whole episode');
  await mount({...ready,id:'empty-work-order-fixture'});await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>(window as any).calls.at(-1)),{action:'refine',payload:{eventIds:['E1'],unitIds:['U1','U2'],reviewNotes:'',preserveNotes:'',expectedBaseHash:basis}},'optional notes may be left empty');
  await mount({...ready,id:'fantasy-link-fixture',assembly:{...ready.assembly,draft:{...ready.assembly.draft,fantasyRealization:[{unitIds:['U1','U2']}]}}});
  await page.getByRole('checkbox',{name:'选择完整单元 U2',exact:true}).uncheck();
  assert.equal(await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).isDisabled(),true,'a partial fantasy group cannot be submitted');
  assert.equal(await page.getByText('所选范围包含跨单元幻想，请选入全部关联单元。',{exact:true}).count(),1);
  await mount(ready);await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).waitFor();
  assert.equal(await page.getByText('未读取已采用全剧方向',{exact:true}).count(),1,'missing frozen series direction is visible');
  const firstEvent=page.getByRole('checkbox',{name:'选择事件1',exact:true}).locator('..');assert.equal(await firstEvent.getByText('事件1原文起点',{exact:false}).count(),1);assert.equal(await firstEvent.getByText('事件1原文终点',{exact:false}).count(),1);
  await page.getByRole('checkbox',{name:'选择事件2',exact:true}).check();assert.equal(await page.getByRole('checkbox',{name:'选择事件3',exact:true}).isDisabled(),true,'third event cannot extend a two-event scope');
  await page.getByRole('checkbox',{name:'选择完整单元 U2',exact:true}).uncheck();
  assert.equal(await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).isDisabled(),true,'nonadjacent units cannot be submitted to the contiguous backend scope');
  assert.equal(await page.getByText('单元范围须连续，请选择相邻完整单元。',{exact:true}).count(),1);
  await page.getByRole('checkbox',{name:'选择完整单元 U3',exact:true}).uncheck();
  await page.getByRole('checkbox',{name:'选择完整单元 U1',exact:true}).uncheck();assert.equal(await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).isDisabled(),true,'at least one whole unit is required');
  await page.getByRole('checkbox',{name:'选择完整单元 U1',exact:true}).check();
  await page.getByLabel('具体观看问题',{exact:true}).fill('反应重音重复，揭示太早');await page.getByLabel('必须保留的功能',{exact:true}).fill('保留人物慢说与现实回接');
  assert.equal(await page.getByLabel('具体观看问题',{exact:true}).getAttribute('maxlength'),'1200');assert.equal(await page.getByLabel('必须保留的功能',{exact:true}).getAttribute('maxlength'),'1200');
  await page.screenshot({path:path.join(folder,`refinement-scope-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).calls.at(-1)),{action:'refine',payload:{eventIds:['E1','E2'],unitIds:['U1'],reviewNotes:'反应重音重复，揭示太早',preserveNotes:'保留人物慢说与现实回接',expectedBaseHash:basis}});
  await mount(changed);await page.getByText('完整精修候选正文',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'生成一次导演精修候选',exact:true}).count(),0);
  await page.getByText('工作单处理说明',{exact:true}).click();assert.equal(await page.getByText('保留气口承接',{exact:false}).count(),1);
  assert.equal(await page.getByRole('button',{name:'采用选中修改组 · 免费',exact:true}).isDisabled(),true,'no group is selected or adopted by default');
  await page.getByRole('checkbox',{name:'采用修改组 1',exact:true}).check();
  assert.equal(await page.getByRole('checkbox',{name:'采用修改组 2',exact:true}).isChecked(),false,'choosing one group does not silently select another');
  await page.getByRole('button',{name:'采用选中修改组 · 免费',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).calls.at(-1)),{action:'accept_refinement',payload:{candidateId:'RC1',expectedBaseHash:basis,groupIds:['RG1']}});
  assert.equal(await page.getByRole('link',{name:'下载盲审材料',exact:true}).getAttribute('href'),'/api/episodes/fixture/storyboard?runId=refine-fixture&format=review&candidateId=RC1');
  await mount({...changed,production:{chainMode:'CHAIN'}});await page.getByText('跨集任务保留基稿，精修候选可审看和导出。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'采用选中修改组 · 免费',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('link',{name:'下载盲审材料',exact:true}).count(),1);
  await mount({...changed,refinement:{...changed.refinement,basisHash:'changed'}});await page.getByText('基稿已变化，保留此候选供对照。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'采用选中修改组 · 免费',exact:true}).isDisabled(),true);
  await mount({...changed,candidates:[{...changed.candidates[0],adoptionBlocked:{code:'PREVIEW_ONLY',message:'仅供审稿，保留基稿'}}]});await page.getByText('仅供审稿，保留基稿',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'采用选中修改组 · 免费',exact:true}).isDisabled(),true);
  await mount({...changed,id:'metadata-fixture',candidates:[{...changed.candidates[0],refinement:{...changed.candidates[0].refinement,partialAdoptionBlocked:{code:'REFINEMENT_PREVIEW_ONLY',message:'整包承接变化，只能完整审看后采用全部修改组'}}}]});
  await page.getByRole('checkbox',{name:'采用修改组 1',exact:true}).check();assert.equal(await page.getByRole('button',{name:'采用选中修改组 · 免费',exact:true}).isDisabled(),true,'package metadata cannot be silently partially adopted');
  await page.getByRole('checkbox',{name:'采用修改组 2',exact:true}).check();assert.equal(await page.getByRole('button',{name:'采用选中修改组 · 免费',exact:true}).isDisabled(),false,'manual whole-group adoption remains available');
  await mount(partialProjected);await page.getByText('已采用部分修改组',{exact:true}).waitFor();await page.getByText('实际采用稿正文',{exact:true}).waitFor();
  assert.equal(await page.getByText('查看实际采用稿',{exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:/采用.*免费/}).count(),0,'an adopted selection cannot be adopted twice');
  const active={...changed,active:true,operations:[{...changed.operations[0],status:'running',localPhase:'executing',execution:{phase:'generating'}}]};
  await mount(active);await page.getByText('导演精修正在生成',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).phases.some((phase:any)=>phase.id==='finish'&&phase.state==='running')),false,'optional refinement does not masquerade as ordinary finishing');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'refinement panel fits narrow viewports');await page.screenshot({path:path.join(folder,`refinement-${width}.png`)});
  assert.deepEqual(errors,[]);await context.close();console.log(`PASS refinement ${width}px: unchanged/unavailable safe review, source anchors, unit scope + work order, single dispatch, basis-bound free adoption, CHAIN isolation, independent activity, no overflow/network/model`);
 }}finally{await browser.close();}
 console.log(`Screenshots: ${folder}`);
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
