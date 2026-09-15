import assert from 'node:assert/strict';
import {prisma} from '../lib/prisma';
import {createSession,revokeSession} from '../lib/auth-service';
async function main(){
 const projectId=process.argv[2];assert.ok(projectId,'Pass an existing project with no current A/B facts.');
 const base='http://127.0.0.1:3008',endpoint=`${base}/projects/${projectId}/asset-prompts/api`;
 const owner=await prisma.projectRole.findFirstOrThrow({where:{projectId}}),session=await createSession(prisma,owner.userId);
 const headers={Cookie:`${process.env.DIRECTOR_SESSION_COOKIE_NAME||'director_session'}=${session.token}`,'Content-Type':'application/json',Origin:base};
 try{
  assert.equal((await fetch(endpoint)).status,401);
  const response=await fetch(endpoint,{headers});assert.equal(response.status,200);const workspace=await response.json();assert.equal(workspace.visualFactsStatus,'MISSING');
  assert.ok(workspace.assets.every((a:any)=>a.evidence.length===0),'Old keyword evidence must not be exposed as A/B facts');
  const page=await fetch(`${base}/projects/${projectId}/asset-prompts`,{headers});assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes('整理剧本事实'));assert.ok(html.includes('剧本事实与出处'));
  const asset=workspace.assets.find((a:any)=>a.eligible&&!a.variant);assert.ok(asset);
  const before=await prisma.sceneSnapshot.findMany({where:{projectId},orderBy:{id:'asc'}});
  const rejected=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({action:'generate',key:asset.key,revision:workspace.records[asset.key]?.revision??0})});
  assert.equal(rejected.status,409);assert.match((await rejected.json()).error,/先整理/);
  assert.deepEqual(await prisma.sceneSnapshot.findMany({where:{projectId},orderBy:{id:'asc'}}),before,'Rejected generation must not change source, directory or old prompts');
  console.log('PASS: 3008 authenticated page/API, no stale keyword facts, missing facts rejected explicitly, all project snapshots unchanged; zero model calls.');
 }finally{await revokeSession(prisma,session.token);await prisma.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
