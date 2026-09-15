import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {emptyPrompt,type PromptWorkspace} from '../lib/asset-prompt-contract';

const require=createRequire(import.meta.url);
require.extensions['.css']=module=>{module.exports={};};
const componentPath=require.resolve('../app/projects/[projectId]/asset-prompts/workspace');
const {AssetPromptWorkspace}=require(componentPath) as typeof import('../app/projects/[projectId]/asset-prompts/workspace');
const base:PromptWorkspace={projectId:'fixture',title:'fixture',style:'3D',stylePrefix:'3D',styleRevision:0,busy:false,records:{},visualFactsStatus:'MISSING',assets:[{key:'hero',baseKey:'hero',name:'人物甲',baseName:'人物甲',type:'CH',variant:false,episodes:[1],mode:'REFERENCE',description:'不应作为事实展示的旧目录描述',note:'不应混入事实的目录备注',evidence:[],reasons:[],eligible:true,fingerprint:'f'}]};
const render=(workspace:PromptWorkspace)=>renderToStaticMarkup(createElement(AssetPromptWorkspace,{initial:workspace}));
const missing=render(base);assert.match(missing,/整理剧本事实/);assert.match(missing,/剧本事实与出处/);assert.doesNotMatch(missing,/不应作为事实展示|不应混入事实/);
const automation=(mode:'FACTS'|'PROMPTS',status:'RUNNING'|'FAILED'|'COMPLETE')=>({id:'job',sourceVersion:'source',mode,status,done:1,failed:status==='FAILED'?1:0,total:2,error:status==='FAILED'?'核对未完成':'',updatedAt:new Date().toISOString()});
assert.match(render({...base,automation:automation('FACTS','RUNNING')}),/整理剧本事实：进行中/);
assert.match(render({...base,automation:automation('FACTS','FAILED')}),/整理剧本事实：未完成/);
assert.match(render({...base,visualFactsStatus:'READY',automation:automation('FACTS','COMPLETE')}),/整理剧本事实：已完成/);
assert.match(render({...base,automation:automation('PROMPTS','RUNNING')}),/生成资产提示词：进行中/);
assert.match(render({...base,visualFactsStatus:'REVIEW',visualFactIssues:[{subjectKey:'hero',message:'当前人物归属待核对'}]}),/当前人物归属待核对/);
assert.doesNotMatch(render({...base,visualFactsStatus:'REVIEW',visualFactIssues:[{subjectKey:'other',message:'仅其他人物的问题'}]}),/仅其他人物的问题/);
assert.match(render({...base,visualFactsStatus:'REVIEW',visualFactIssues:[{message:'场景目录建议',blocking:false}]}),/目录补充建议/);
assert.doesNotMatch(render({...base,visualFactsStatus:'REVIEW',visualFactIssues:[{message:'场景目录建议',blocking:false}]}),/此资产的剧本事实待核对/);

// Invoke the actual button callbacks with inert hook storage. This exercises
// request routing without a browser, DB, model or rendering side effects.
const reactPath=require.resolve('react'),reactModule=require.cache[reactPath]!,realReact=reactModule.exports;
const stateUpdates:unknown[]=[];
reactModule.exports={...realReact,useState:(initial:unknown)=>[initial,(value:unknown)=>stateUpdates.push(value)],useRef:(value:unknown)=>({current:value}),useEffect:()=>{}};
delete require.cache[componentPath];
const {AssetPromptWorkspace:Interactive}=require(componentPath) as typeof import('../app/projects/[projectId]/asset-prompts/workspace');
function nodes(value:any):any[]{return Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];}
function text(value:any):string{return Array.isArray(value)?value.map(text).join(''):typeof value==='string'||typeof value==='number'?String(value):value?.props?text(value.props.children):'';}
async function click(label:string,workspace:PromptWorkspace){
 const tree=Interactive({initial:workspace});const button=nodes(tree).find(node=>node.type==='button'&&text(node.props.children).startsWith(label));assert.ok(button,`${label} exists`);assert.ok(!button.props.disabled,`${label} enabled`);await button.props.onClick();
}
async function main(){
 const originalFetch=globalThis.fetch;const actions:string[]=[];let current=base;
 globalThis.fetch=(async(_url,init)=>{if(!init?.method)return new Response(JSON.stringify(current));const payload=JSON.parse(String(init.body));assert.ok(Number.isSafeInteger(payload.revision)&&payload.revision>=0,'POST includes required revision');actions.push(payload.action);return new Response(JSON.stringify(payload.action==='generate'?{...emptyPrompt('hero'),status:'READY',body:'可编辑设计',revision:2,fingerprint:'f'}:{...current,automation:automation('FACTS','RUNNING')}));}) as typeof fetch;
 try{
  for(const label of ['生成初版提示词','补齐提示词']){actions.length=0;stateUpdates.length=0;await click(label,base);assert.deepEqual(actions,['prepare-facts']);assert.ok(stateUpdates.some(value=>typeof value==='string'&&value.includes('完成后请再点击生成提示词')));}
  actions.length=0;await click('整理剧本事实',base);assert.deepEqual(actions,['prepare-facts'],'Explicit preparation never generates art prompts');
  current={...base,visualFactsStatus:'REVIEW',visualFactIssues:[{subjectKey:'other',message:'其他人物问题'}]};actions.length=0;await click('生成初版提示词',current);assert.deepEqual(actions,['generate'],'Unrelated REVIEW issues do not block this asset');
  console.log('PASS: fact statuses and scoped issues rendered; missing single/batch generation prepares facts only with explicit notice; explicit preparation never generates prompts; unrelated review permits generation. No browser or model calls.');
 }finally{globalThis.fetch=originalFetch;reactModule.exports=realReact;delete require.cache[componentPath];}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
