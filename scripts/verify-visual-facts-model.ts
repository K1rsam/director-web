import assert from 'node:assert/strict';
import {copyFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {selectAssetVisualFacts} from '../lib/asset-visual-facts-selection';
// Explicit, bounded live semantic smoke test: one synthetic source chunk, A + B only.
async function main(){
 assert.equal(process.argv[3],'--real','This test requires --real and calls the configured CLI model twice.');
 const dir=path.resolve('outputs/stage15-semantic-tests');await mkdir(dir,{recursive:true});
 const database=path.join(dir,`test-${Date.now()}.db`);await copyFile(process.argv[2],database);process.env.DATABASE_URL=`file:${database.replaceAll('\\','/')}`;
 const {prisma}=await import('../lib/prisma');const {ensureAssetVisualFacts}=await import('../lib/asset-visual-facts-service');
 const {runRoleByProvider}=await import('../lib/role-runner');
 try{
  const row=(await prisma.sceneSnapshot.findMany({where:{sceneKey:'FOUNDATION_DOCUMENT'}})).find(r=>JSON.parse(r.content).f2?.assets?.length);assert.ok(row);
  const document=JSON.parse(row.content),template=document.f2.assets.find((a:any)=>a.type==='CH');assert.ok(template);
  const first={...template,key:'C_test_a',name:'林甲',aliases:[],variants:[{...template.variants[0],key:'C_test_a_short',name:'林甲·剪短发后'}]};
  const second={...template,key:'C_test_b',name:'宋乙',aliases:[],variants:[]};
  document.f2.assets=[first,second];
  const source='第1集\n1-1 日 内 理发店\n人物：林甲、宋乙\n人物资料：林甲，红色长发，戴眼镜。宋乙，林甲的发小，父亲宋辉。\n△林甲摘下自己的眼镜，递给宋乙。宋乙帮林甲擦了擦眼镜，还给林甲。\n△林甲重新戴上眼镜。理发师将林甲的红色长发剪成短发，没有染发。\n△宋乙依旧站在一旁。';
  const project=await prisma.project.create({data:{title:'synthetic AB accuracy smoke',executionMode:'CLI',episodes:{create:{number:1,content:source}}}});
  await prisma.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT',content:JSON.stringify(document)}});
  let calls=0;const result=await ensureAssetVisualFacts(project.id,async input=>{calls++;console.log(`Running ${input.role.code}`);return runRoleByProvider(input);});
  await writeFile(path.join(dir,'latest-result.json'),JSON.stringify({calls,result},null,2));assert.equal(calls,2);
  const firstFacts=result.facts.filter(f=>f.subjectKey===first.key),secondFacts=result.facts.filter(f=>f.subjectKey===second.key);
  assert.ok(firstFacts.some(f=>/眼镜/.test(f.value)),'Glasses ownership must be retained');
  assert.equal(secondFacts.some(f=>/佩戴|戴着|戴眼镜/.test(f.value)),false,'Helping clean another person’s glasses must not become personal eyewear');
  assert.ok(firstFacts.some(f=>/红/.test(f.value)),'Hair color retained');
  assert.ok(firstFacts.some(f=>/短/.test(f.value)&&f.versionKey==='C_test_a_short'),'Short hair belongs to later version');
  assert.ok(firstFacts.some(f=>/长/.test(f.value)),'Earlier long hair retained');
  assert.equal(firstFacts.some(f=>/宋辉|发小/.test(f.value)),false,'Other character biography is not appearance');
  assert.equal(result.issues.filter(i=>i.blocking!==false).length,0,'Clear source versions should not be blocked by unrelated missing scenery');
  const selected=selectAssetVisualFacts(first.key,'C_test_a_short',result.facts,[{key:first.key},{key:'C_test_a_short',fromKey:first.key}]);
  assert.ok(selected.facts.some(f=>/短/.test(f.value)));assert.ok(selected.facts.some(f=>/红/.test(f.value)));assert.ok(selected.facts.some(f=>/眼镜/.test(f.value)));
  console.log(`PASS: ${calls} real calls; glasses ownership, action-derived facts, red hair and haircut versions, biography boundary. Review issues: ${result.issues.length}. This fixture does not establish all-script accuracy.`);
 }finally{await prisma.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
