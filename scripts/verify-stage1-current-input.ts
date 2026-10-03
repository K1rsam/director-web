/** Current Stage 1 request assembly against a consistent scratch DB. No dispatch, original DB writes or source output. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
const require=createRequire(import.meta.url), size=(value:unknown)=>JSON.stringify(value).length;

function expand(table:any):unknown {
  if(Array.isArray(table))return table;
  const values=table.rows.map((row:any[])=>({...table.shared,...Object.fromEntries(table.columns.map((key:string,i:number)=>[key,
    table.dictionaries?.[key]?table.dictionaries[key][row[i]]:row[i]]))}));
  const origin=(row:any)=>({...table.evidenceShared,...Object.fromEntries(table.evidenceColumns.map((key:string,i:number)=>[key,row.evidence[i]]))});
  const ids=values.map((row:any)=>table.idDerivation?createHash('sha256').update(JSON.stringify([
    table.idDerivation.sourceVersion,table.idDerivation.sourceContextVersion,origin(row)])).digest('hex'):row.id);
  return values.map((row:any,i:number)=>({...row,id:ids[i],evidence:origin(row),retrieval:row.retrieval===null
    ?{mode:'SUBJECT_MENTION',anchorFactIds:[ids[i]]}:{mode:row.retrieval[0],anchorFactIds:row.retrieval[1].map((position:number)=>ids[position])}}));
}

async function main(){
  const projectFlag=process.argv.indexOf('--project'), projectId=projectFlag>=0?process.argv[projectFlag+1]:null;
  if(!projectId)throw new Error('Use --project <local project ID>; no task will be run.');
  const scratch=mkdtempSync(path.join(tmpdir(),'3008-stage1-input-'));let db:any;
  try {
    const originalDb=new DatabaseSync(path.resolve('prisma/dev.db'),{readOnly:true});
    try {await backup(originalDb,path.join(scratch,'audit.db'));} finally {originalDb.close();}
    Object.assign(process.env,{DATABASE_URL:'file:'+path.join(scratch,'audit.db'),NODE_ENV:'production'});
    db=require('../lib/prisma').prisma;
    const runner=require('../lib/role-runner'), forbidden=async()=>{throw new Error('Offline audit forbids model calls');};
    require.cache[require.resolve('../lib/role-runner')]!.exports={...runner,runRoleByProvider:forbidden,runCliRoleJson:forbidden,runApiRoleJson:forbidden};
    const {loadFoundationInputs}=require('../lib/foundation-state'), {loadFoundationDocument}=require('../lib/foundation-document');
    const {loadLightScenes}=require('../lib/light-foundation-supply'), {buildDeliveryInput,costFingerprint}=require('../lib/foundation-delivery');
    const {projectFoundationModelInput}=require('../lib/foundation-model-input'), {buildLightFoundationPrompt}=require('../lib/foundation-production-prompts');
    const input=await loadFoundationInputs(projectId,db), {document:doc}=await loadFoundationDocument(db,projectId,input), scenes=await loadLightScenes(projectId,db);
    assert.ok(doc.f2,'Current catalogue is required; never generate it for an audit');
    const before=structuredClone({input,doc,scenes}), all=input.sourceIndex.episodes.map((episode:any)=>episode.number), tail=all.slice(-2), metrics=[];
    for(const [stage,phase,scope] of [['F2','GENERATE_F2',tail],['Q1','REPAIR',tail],['Q1','EDIT',all]] as const) {
      const localKeys=doc.f2.assets.filter((asset:any)=>asset.usageEpisodes.some((n:number)=>scope.includes(n))).map((asset:any)=>asset.key);
      const request=buildDeliveryInput(stage,phase,input,doc,[...scope],[],[],doc.f2.assets,scenes,
        phase==='REPAIR'?{episodes:[...scope],keys:localKeys}:undefined);
      const {sourceVersion:_sourceVersion,sourceContextVersion:_contextVersion,...fullIdFacts}=request.facts;
      const legacy=projectFoundationModelInput({...request,facts:fullIdFacts}), current=projectFoundationModelInput(request);
      assert.deepEqual(expand(current.facts.historicalEvidenceCandidates),request.facts.historicalEvidenceCandidates);
      assert.deepEqual(expand(legacy.facts.historicalEvidenceCandidates),request.facts.historicalEvidenceCandidates);
      const {historicalEvidenceCandidates:_old,...oldFacts}=legacy.facts, {historicalEvidenceCandidates:_new,...newFacts}=current.facts;
      assert.deepEqual(newFacts,oldFacts,'All other facts and protocol fields are unchanged');
      const {facts:_a,...oldRest}=legacy, {facts:_b,...newRest}=current;
      assert.deepEqual(newRest,oldRest,'Source, scenes, registry, targets and all non-history inputs are unchanged');
      assert.equal(costFingerprint(stage,request),costFingerprint(stage,legacy));
      assert.equal(costFingerprint(stage,request),costFingerprint(stage,current));
      const promptBefore=buildLightFoundationPrompt(stage,legacy).length+input.systemPrompts[stage].length;
      const promptAfter=buildLightFoundationPrompt(stage,request).length+input.systemPrompts[stage].length;
      metrics.push({stage,phase,scope,historicalRows:request.facts.historicalEvidenceCandidates.length,
        format:current.facts.historicalEvidenceCandidates.format??'ARRAY',historicalBefore:size(legacy.facts.historicalEvidenceCandidates),
        historicalAfter:size(current.facts.historicalEvidenceCandidates),dispatchBefore:promptBefore,dispatchAfter:promptAfter,
        savedChars:promptBefore-promptAfter,savedPercent:Number(((promptBefore-promptAfter)/promptBefore*100).toFixed(2)),
        exactRoundtrip:true,otherInputsUnchanged:true,paidIdentityUnchanged:true});
    }
    assert.deepEqual({input,doc,scenes},before,'No canonical mutation');
    console.log(JSON.stringify({modelCalls:0,unit:'UTF16_CHARS_NOT_TOKENS',comparison:'Current real builders/materials, hypothetical scopes; not new sent requests',
      documentCoverage:doc.f2.coverage.length,reviewedEpisodes:doc.editorialCoverage.length,metrics},null,2));
  } finally {if(db)await db.$disconnect();rmSync(scratch,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
