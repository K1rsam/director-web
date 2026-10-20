/** Execute the actual free action body; no DB, network or model. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
async function main(){
 const source=ts.createSourceFile('actions.ts',readFileSync('app/actions.ts','utf8'),ts.ScriptTarget.Latest,true);
 const node=source.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='recoverSavedFoundationDeliveryAction');assert.ok(node);
 const code=ts.transpileModule(node.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 for(const denied of [false,true]){
  let authorized=false,recoveries=0;const redirects:string[]=[],refreshes:string[]=[],authError=new Error('Forbidden'),redirectSignal=new Error('Redirect');
  const exports:Record<string,(form:FormData)=>Promise<void>>={};
  new Function('exports','require','requireProjectAccess','revalidatePath','redirect',code)(exports,(module:string)=>{
   assert.equal(module,'@/lib/foundation-delivery');return {recoverSavedFoundationDelivery:async(projectId:string,state:string)=>{assert(authorized);assert.equal(projectId,'project');assert.equal(state,'expected');recoveries++;}};
  },async(projectId:string)=>{assert.equal(projectId,'project');if(denied)throw authError;authorized=true;},(p:string)=>refreshes.push(p),(p:string)=>{redirects.push(p);throw redirectSignal;});
  const form=new FormData();for(const [key,value] of Object.entries({projectId:'project',expectedState:'expected',allowUnknownRetry:'yes'}))form.set(key,value);
  await assert.rejects(exports.recoverSavedFoundationDeliveryAction(form),error=>error===(denied?authError:redirectSignal));
  assert.equal(recoveries,denied?0:1);assert.deepEqual(refreshes,denied?[]:['/projects/project','/']);assert.deepEqual(redirects,denied?[]:['/projects/project']);
 }
 console.log('PASS free recovery action: project authentication before mutation, server CAS, no launch/queue/provider or unknown retry authorization');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
