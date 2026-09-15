import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
async function main(){
 const backup=process.argv[2];if(!backup)throw new Error('Use a consistent backup');
 mkdirSync('outputs/asset-automation-tests',{recursive:true});const database=path.resolve(`outputs/asset-automation-tests/test-${Date.now()}.db`);copyFileSync(backup,database);process.env.DATABASE_URL=`file:${database.replaceAll('\\','/')}`;
 const {prisma}=await import('../lib/prisma');const {launchAssetPromptAutomation,AUTOMATION_KEY}=await import('../lib/asset-prompt-automation');const {loadFoundationInputs}=await import('../lib/foundation-state');
 const project=await prisma.project.create({data:{title:'isolated empty asset queue',episodes:{create:{number:1,content:'第1集\n1-1 客厅 日 内\n甲：你好。'}}}});
 const input=await loadFoundationInputs(project.id);await launchAssetPromptAutomation(project.id,input.sourceVersion,undefined,'PROMPTS');
 let status='RUNNING';for(let i=0;i<30&&status==='RUNNING';i++){await new Promise(r=>setTimeout(r,500));const row=await prisma.sceneSnapshot.findFirstOrThrow({where:{projectId:project.id,sceneKey:AUTOMATION_KEY}});const state=JSON.parse(row.content);status=state.status;assert.equal(state.total,0);if(status==='FAILED')throw new Error(state.error);}
 assert.equal(status,'COMPLETE');assert.equal(await prisma.pipelineRun.count({where:{projectId:project.id}}),0);console.log('PASS: detached worker persisted and completed empty queue; no model invocation; isolated database');await prisma.$disconnect();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
