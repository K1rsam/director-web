/** Execute the real action body with offline boundaries. No DB, provider, or Next server. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function main() {
 const source=ts.createSourceFile('actions.ts',readFileSync('app/actions.ts','utf8'),ts.ScriptTarget.Latest,true);
 const node=source.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text==='confirmFoundationDeliveryChoiceAction');
 assert.ok(node);
 const code=ts.transpileModule(node.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 for(const queued of [null,{id:'queued-after-final-choice'}]) {
  let launches=0,auth=0,saves=0;const refreshes:string[]=[];let target='';
  const modules:Record<string,unknown>={'@/lib/prisma':{prisma:{offline:true}},'@/lib/foundation-delivery':{
   confirmAndContinueFoundationDelivery:async (_db:unknown,input:Record<string,unknown>)=>{assert.equal(auth,1);assert.equal(input.contractId,'choice');saves++;return queued;},
   launchFoundationDelivery:async (task:unknown)=>{assert.equal(task,queued);launches++;}
  }};
  const exports:Record<string,(data:FormData)=>Promise<void>>={};
  const redirectSignal=new Error('offline redirect');
  new Function('exports','require','requireProjectAccess','FoundationChoiceError','revalidatePath','redirect',code)(exports,(name:string)=>{assert.ok(name in modules);return modules[name];},async()=>{auth++;},class extends Error {},(path:string)=>refreshes.push(path),(path:string)=>{target=path;throw redirectSignal;});
  const form=new FormData();for(const [key,value] of Object.entries({projectId:'project',contractId:'choice',revision:'revision',expectedTaskId:'task',optionIndex:'1'}))form.set(key,value);
  await assert.rejects(()=>exports.confirmFoundationDeliveryChoiceAction(form),error=>error===redirectSignal);
  assert.equal(saves,1);assert.equal(launches,queued?1:0);
  assert.deepEqual(refreshes,['/projects/project','/']);
  assert.equal(target,`/projects/project?foundationNotice=${queued?'decision-continued':'decision-collected'}#presentation-contracts`);
 }
 console.log('PASS real choice action: collected choice saves with zero launch; final choice launches once; both refresh and return to confirmation area');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
