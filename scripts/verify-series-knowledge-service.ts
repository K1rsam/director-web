import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

async function main(){
 const file=path.join(mkdtempSync(path.join(tmpdir(),'direction-knowledge-')),'test.db'),sql=new DatabaseSync(file);
 for(const migration of readdirSync('prisma/migrations').sort())if(/^\d/.test(migration))sql.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();process.env.DATABASE_URL=`file:${file}`;
 const {prisma}=await import('../lib/prisma'),service=await import('../lib/series-direction-service');
 try{
  const user=await prisma.user.create({data:{username:'knowledge',email:'knowledge@synthetic.invalid',passwordHash:'not-a-login'}});
  const project=await prisma.project.create({data:{title:'方向时点合成样本',executionMode:'API',roles:{create:{userId:user.id,role:'ADMIN'}},episodes:{create:[{number:1,content:'1-1 仓库 日 内\n甲：我是乙的兄长。'},{number:2,content:'2-1 档案室 日 内\n△档案证实甲与乙没有血缘。'}]}}});
  const episodes=await prisma.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}});
  const content={settingTags:[],mechanismTags:[],arcTags:[],primaryTone:'克制',secondaryTones:[],audiencePromise:'逐步揭开关系。',expressionRules:[],avoidances:[],episodeFlexibility:'原文时点优先。'};
  let calls=0,view=await service.getSeriesDirectionWorkspace(project.id,user.id);
  view=await service.generateSeriesDirectionCandidate(project.id,user.id,{action:'generate',stateToken:view.stateToken,sourceVersion:view.source.sourceVersion,costAcknowledged:true},{runner:async input=>{
   calls++;const p=JSON.parse(input.prompt.split('INPUT_JSON:\n')[1]);
   const data=p.phase==='evidence'?{coverage:p.units.map((u:any)=>u.id),summary:'关系主张在后集被证伪。',evidence:p.units.map((u:any)=>({unitId:u.id,quote:u.text.slice(0,30),signal:'关系依据'})),knowledge:p.units.map((u:any)=>({unitId:u.id,quote:u.text.split('\n')[1],kind:u.text.includes('甲：')?'RELATIONSHIP':'REVEAL',claim:'SOURCE',statement:u.text.includes('甲：')?'甲自称乙的兄长。':'甲与乙无血缘被揭示。',subjects:['甲','乙']}))}:{content};
   return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};
  }});
  assert.equal(view.generation?.outcome,'SUCCEEDED');
  assert.equal(view.draft?.knowledgeIndex?.length,2,'knowledge is retained in the existing evidence calls, not separate per-episode summaries');
  assert.equal(view.draft!.knowledgeIndex![0].claim,'CHARACTER_CLAIM','a model cannot upgrade quoted dialogue to objective source truth');
  assert.equal(calls,view.generationPlan.calls,'no extra model calls for the index');
  view=await service.mutateSeriesDirection(project.id,user.id,{action:'save',stateToken:view.stateToken,sourceVersion:view.source.sourceVersion,content,coverageAcknowledged:true});
  assert.equal(view.draft?.knowledgeIndex?.length,2,'editing the direction preserves its current source-bound evidence index');
  view=await service.mutateSeriesDirection(project.id,user.id,{action:'confirm',stateToken:view.stateToken,sourceVersion:view.source.sourceVersion,draftHash:view.draft!.hash,coverageAcknowledged:true});
  const first=await service.readSeriesDirectionProjection(project.id,episodes[0].id),second=await service.readSeriesDirectionProjection(project.id,episodes[1].id);
  assert.equal(first.projection?.seriesKnowledge.length,1);assert.equal(second.projection?.seriesKnowledge.length,2);
  assert.ok(!JSON.stringify(first.projection).includes('没有血缘'),'no future source text is delivered early');
  console.log('PASS isolated series knowledge service: same evidence-call count, actual source offsets, dialogue attribution, preserved index on human edit, episode-time projection; real model calls 0');
 }finally{await prisma.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
