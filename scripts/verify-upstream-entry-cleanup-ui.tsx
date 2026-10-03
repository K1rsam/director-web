/** Real SSR components with in-memory read fixtures; no server, DB writes or model calls. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {prepareFidelityImport} from '../lib/fidelity-import';
import type {P1ReviewState} from '../lib/fidelity-p1-review';

const require=createRequire(import.meta.url);
function stub(name:string,exports:unknown){const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports} as NodeModule;}
let actions=0;
const noAction=async()=>{actions++;throw new Error('Read-only rendering must not submit');};
stub('../app/actions',{importProjectAction:noAction});
const {ProjectCreateForm}=require('../app/projects/new/project-create-form');
const {FidelityReviewSummary}=require('../app/projects/[projectId]/source/fidelity-review-summary');
const failures:string[]=[];
let checks=0;
async function check(name:string,run:()=>void|Promise<void>){checks++;try{await run();}catch(error){failures.push(`${name}: ${error instanceof Error?error.message.split('\n')[0]:String(error)}`);}}

async function main(){
 const source='第一集\r\n\r\n1-1 门厅 内 日\r\n\t　\r\n甲：保留  两个空格。\r\n\r\n△甲递出钥匙。\r\n';
 const {receipt}=await prepareFidelityImport('original.txt',Buffer.from(source),'fidelity');
 const before=JSON.stringify(receipt);
 const summary=(review?:P1ReviewState)=>renderToStaticMarkup(createElement(FidelityReviewSummary,{receipt:{...receipt,p1Review:review}}));
 await check('新建入口移除外部整理工具但保留直接导入与旧包兼容',()=>{
  const html=renderToStaticMarkup(createElement(ProjectCreateForm,{styles:[]}));
  assert.doesNotMatch(html,/让其他 AI 整理|生成外部整理材料|复制完整材料|\/api\/fidelity\/(material|skill)|下载 Skill/);
  assert.ok(html.includes('value="fidelity"')&&html.includes('value="direct"')&&html.includes('name="trustExternalDecisions"'));
  assert.ok(html.includes('.json,.zip')&&html.includes('程序初检，按需 AI 辅助'));
  assert.doesNotMatch(html,/P1 将调用 AI 检查全文结构|原稿：AI 检查结构/);
 });
 await check('程序完成不能标为AI全文检查',()=>{
  const html=summary({status:'COMPLETE',method:'PROGRAM',runIds:[]});
  assert.ok(html.includes('程序结构验证已完成')&&html.includes('未调用 AI'));
  assert.doesNotMatch(html,/AI 全文结构检查已完成/);
 });
 await check('真实AI记录仍显示其完成证据',()=>{
  const html=summary({status:'COMPLETE',method:'AI',runIds:['run-1']});
  assert.ok(html.includes('AI 全文结构检查已完成')&&html.includes('保留 1 条调用记录'));
 });
 await check('未指定方法的待处理状态不承诺AI全文检查',()=>{
  const html=summary({status:'PENDING',completedRanges:[]});
  assert.ok(html.includes('结构检查待完成'));
  assert.doesNotMatch(html,/等待完成 AI 全文结构检查/);
 });
 await check('缺失方法和调用记录的旧完成态不冒充AI',()=>{
  assert.doesNotMatch(summary({status:'COMPLETE'}),/AI 全文结构检查已完成/);
 });
 const reads:string[]=[];
 stub('next/navigation',{redirect:noAction});stub('next/cache',{revalidatePath:noAction});
 stub('../lib/auth',{requireProjectAccess:async()=>{reads.push('auth');}});
 stub('../lib/prisma',{prisma:{project:{findUniqueOrThrow:async()=>{reads.push('project');return {title:'来源检查'};}},episode:{count:async()=>1}}});
 stub('../lib/fidelity-store',{readFidelityReceipt:async()=>{reads.push('receipt');return {receipt,snapshot:{id:'receipt-1'},sourceSnapshot:{id:'source-1'}};},applyFidelityDecision:noAction});
 stub('../app/ui/app-chrome',{AppChrome:({children}: {children?:ReactNode})=>createElement('main',null,children)});
 const Page=require('../app/projects/[projectId]/source/page').default;
 await check('默认清洗阅读过滤空白行且保留原行号，原件审计保持折叠',async()=>{
  const html=renderToStaticMarkup(await Page({params:Promise.resolve({projectId:'p1'}),searchParams:Promise.resolve({})}));
  const reading=html.match(/<details\b([^>]*)id="source-reading-view"[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(reading&&/\bopen(?:\s|=|$)/.test(reading[1]),'cleaned view is visible by default');
  const lines=[...reading[2].matchAll(/<span[^>]*>(\d+)<\/span><pre[^>]*>([\s\S]*?)<\/pre>/g)];
  assert.deepEqual(lines.map(line=>Number(line[1])),[1,3,5,7]);
  assert.ok(lines.every(line=>line[2].trim())&&reading[2].includes('甲：保留  两个空格。'));
  const audit=html.match(/<details\b([^>]*)id="source-original-audit"[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(audit&&!/\bopen(?:\s|=|$)/.test(audit[1]),'full raw source is only in collapsed audit');
  assert.ok(audit[2].includes(source));
  for(const field of ['firstLine','lastLine','revision','sourceRevision','sourceVersion','decisionVersion'])assert.ok(html.includes(`name="${field}"`));
  assert.doesNotMatch(html,/\/api\/fidelity\/skill|format=external/);
  assert.ok(html.includes('format=md')&&html.includes('format=original')&&html.includes('下载备份 JSON'));
  assert.ok(reads.indexOf('auth')<reads.indexOf('receipt'));
 });
 assert.equal(actions,0);assert.equal(JSON.stringify(receipt),before,'read-only render preserves source and evidence');
 for(const failure of failures)console.error(`FAIL ${failure}`);
 assert.equal(failures.length,0,`${failures.length}/${checks} entry-cleanup checks failed`);
 console.log(`PASS ${checks} entry-cleanup SSR checks: program/AI truth, compact reading with original coordinates, recovery and import compatibility; no DB/model calls.`);
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
