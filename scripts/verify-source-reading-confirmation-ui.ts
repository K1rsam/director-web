import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {SourceReadingConfirmation} from '../app/projects/[projectId]/source/reading-confirmation';
import type {SourceReadingState} from '../lib/source-reading-confirmation';

async function main(){
 const state:SourceReadingState={required:true,binding:{sourceImportId:'source',readingHash:'reading',originalHash:'original',readerFingerprint:'reader'},confirmed:false,confirmationId:null,confirmedAt:null};
 let network=0;globalThis.fetch=async()=>{network++;throw new Error('No fetch allowed');};
 const action=async()=>{},html=renderToStaticMarkup(createElement(SourceReadingConfirmation,{projectId:'p',state,canConfirm:true,action}));
 assert.match(html,/不启动模型/);assert.match(html,/原 Word 与修订记录保留/);
 assert.match(html,/<input[^>]*type="checkbox"[^>]*required/);assert.doesNotMatch(html,/checked=/);
 for(const name of Object.keys(state.binding!))assert.match(html,new RegExp(`name="${name}"`));
 assert.doesNotMatch(renderToStaticMarkup(createElement(SourceReadingConfirmation,{projectId:'p',state,canConfirm:false,action})),/<form|<button/);
 const confirmed=renderToStaticMarkup(createElement(SourceReadingConfirmation,{projectId:'p',state:{...state,confirmed:true,confirmationId:'receipt'},canConfirm:true,action}));
 assert.match(confirmed,/已确认采用当前读取文本/);assert.doesNotMatch(confirmed,/<form|<button/);
 const source=ts.createSourceFile('page.tsx',readFileSync('app/projects/[projectId]/source/page.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 assert.match(source.text,/bindSourceReadingToDisplayedReceipt\(await readSourceReadingState\(projectId,prisma,current.sourceSnapshot\),current.receipt\)/);
 const node=source.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='confirmReading');assert.ok(node);
 const code=ts.transpileModule(node.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 for(const denied of [false,true]){
  let authorized=false,mutations=0;const refreshes:string[]=[],authError=new Error('Forbidden'),redirectSignal=new Error('Redirect');
  const execute=new Function('requireProjectAccess','confirmSourceReading','revalidatePath','redirect',code+'\nreturn confirmReading;')(
   async(projectId:string)=>{assert.equal(projectId,'p');if(denied)throw authError;authorized=true;return {id:'session-user'};},
   async(request:Record<string,unknown>)=>{assert(authorized);assert.equal(request.userId,'session-user');assert.equal(request.confirmed,true);assert.equal(request.choice,'USE_CURRENT_READING');mutations++;},
   (p:string)=>refreshes.push(p),()=>{throw redirectSignal;}) as (form:FormData)=>Promise<void>;
  const form=new FormData();for(const [name,value]of Object.entries({projectId:'p',...state.binding!,choice:'USE_CURRENT_READING',confirmed:'on',userId:'forged-user'}))form.set(name,value);
  await assert.rejects(execute(form),e=>e===(denied?authError:redirectSignal));
  assert.equal(mutations,denied?0:1);assert.deepEqual(refreshes,denied?[]:['/projects/p','/projects/p/source']);
 }
 assert.equal(network,0);console.log('PASS reading-confirmation form/action: explicit unchecked consent, source hashes, authenticated session actor, role/read-only/confirmed views, zero fetch/worker/model');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
