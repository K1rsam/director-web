import assert from 'node:assert/strict';
import { dependencyIdentityKeys,selectDependencySafeRegistry,type DependencyIdentity } from '../lib/foundation-dependency-selector';
import { buildFoundationFacts,selectFoundationFacts } from '../lib/foundation-facts';
import { buildSourceIndex } from '../lib/project-foundation-contracts';
import type { ProductionCatalog } from '../lib/foundation-production-contracts';
import type { FoundationSourceContext } from '../lib/foundation-source';
import { PrismaClient } from '@prisma/client';

async function main(){
 const assets:DependencyIdentity[]=[
  {key:'a',name:'阿甲',aliases:['小甲'],usageEpisodes:[3],preparation:{fromKey:'a-old'},relationNote:'和乙同行'},
  {key:'a-old',name:'少年甲',aliases:[],variants:[{key:'v1',name:'受伤甲',preparation:{fromKey:'base'}}]},
  {key:'base',name:'原始形象',aliases:[]},
  {key:'other-a',name:'阿甲',aliases:['同名路人']},
  {key:'b',name:'乙',aliases:[]},
  {key:'hidden',name:'蒙面客',aliases:[]}
 ];
 const selected=dependencyIdentityKeys(assets,[3],'他走了。');
 for(const key of ['a','a-old','base','other-a','b'])assert(selected.includes(key),key);
 const registry=assets.map(({key,name,aliases})=>({key,name,aliases}));
 assert.deepEqual(selectDependencySafeRegistry(registry,assets,[3],'他走了。'),registry,'unresolved pronouns retain the minimal global identity index');
 assert.equal(assets.length,6,'same-name people never merged');
 assert(dependencyIdentityKeys(assets,[],'小甲来了。').includes('other-a'),'alias chain preserves ambiguous same-name alternatives');
 const index=buildSourceIndex([
  {number:1,title:'1',content:'第1集\n1-1 病房 日 内\n小甲受伤。\n他缠上绷带。\n'},
  {number:2,title:'2',content:'第2集\n2-1 病房 日 内\n小甲恢复。\n'},
  {number:3,title:'3',content:'第3集\n3-1 病房 日 内\n阿甲：回想当时。\n'}
 ]);
 const context:FoundationSourceContext={version:'ctx',background:[],unresolved:[],issues:[],complete:true,notices:[],coverage:'COMPLETE'};
 const catalog={assets:[{name:'阿甲',aliases:['小甲']}]} as ProductionCatalog;
 const facts=buildFoundationFacts(index,context,catalog),picked=selectFoundationFacts(facts,index,[3]);
 assert.equal(picked.historicalStates.length,2,'old-alias injury and recovery both retained for flashback review');
 assert(picked.historicalStates.some(f=>f.statement.includes('受伤')));
 assert(picked.historicalStates.some(f=>f.statement.includes('恢复')));
 const unnamed=facts.facts.find(f=>f.statement.includes('他缠上绷带'))!;
 assert(unnamed&&unnamed.subjects.length===0,'unattributed state remains indexed at original position');
 assert(!picked.historicalStates.includes(unnamed),'unattributed states are not broadcast to later episodes');
 console.log('PASS dependency closure: multiple aliases, same-name distinct people, chained derivation, relation evidence, pronoun registry, injury/recovery flashback, unknown-state nonbroadcast');
 if(process.argv.includes('--saved-audit')){
  const db=new PrismaClient();try{
   const runs=await db.pipelineRun.findMany({where:{projectId:(process.env.QA_PROJECT_ID || 'missing-test-project'),stageCode:{in:['F2','Q1']}},select:{id:true,stageCode:true,log:true},orderBy:{createdAt:'asc'}});
   const rows=[];
   for(const run of runs){let log:any;try{log=JSON.parse(run.log??'{}');}catch{continue;}
    for(const call of log.calls??[]){const prompt=call.taskPrompt;if(typeof prompt!=='string')continue;let input:any;try{input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);}catch{continue;}
     const ids=input.registry??[],history=input.facts?.historicalStates??[];
     rows.push({runId:run.id,stage:run.stageCode,requestChars:prompt.length,registryCount:ids.length,registryChars:JSON.stringify(ids).length,registryFields:[...new Set(ids.flatMap((a:any)=>Object.keys(a)))],historicalStateCount:history.length,historicalStateChars:JSON.stringify(history).length,safeRegistryRemoval:0});
    }
   }
   console.log(JSON.stringify({unit:'UTF16 chars, actual saved requests, no provider call',rows},null,2));
  }finally{await db.$disconnect();}
 }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
