import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine,rebuildFrozenRequest} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {normalizePlan,buildRequest} from './core.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {digest} from './shared.mjs';

const v1='production-feedback-result-v1',v2='production-feedback-result-v2';
const receipt={relation:'UNKNOWN',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]};
async function prepared(t,{rules=v2,production=v2}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'pfr-prepare-review-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const requests=[],engine=createEngine({directory,modelRunner:async request=>{
  requests.push(request);throw Object.assign(new Error('Provider execution is forbidden in this isolated preparation test'),{code:'PROVIDER_FORBIDDEN',requestOutcome:'NOT_SENT'});
 }}),store=createStore(directory),f=tailFixture();
 await engine.create({id:'review',source:f.source,settings:f.settings,production:{version:'production-feedback-v1',materials:[],boundary:null,outgoingAgreements:[],...(production===undefined?{}:{feedbackResultVersion:production})}});
 await store.update('review',d=>{
  if(rules===null)delete d.rulesSnapshot.productionFeedbackResultVersion;else d.rulesSnapshot.productionFeedbackResultVersion=rules;
  if(production===null)delete d.production.feedbackResultVersion;
  d.plan=normalizePlan(f.plan,d.source,{unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy});
  const packageIds=d.plan.workPackages.map(w=>w.id),draft=tailDraft({plan:d.plan,source:d.source});
  d.adopted=[{candidateId:'baseline',packageIds,draft,stage:'author'}];
  d.candidates=[{id:'baseline',attemptId:'baseline-attempt',stage:'author',packageIds,draft,status:'adopted',productionFeedback:structuredClone(receipt)}];
  d.operations=[{attemptId:'baseline-attempt',stage:'author',packageIds,status:'completed',epoch:d.epoch,productionSnapshot:{touchesEnding:true,materials:[]}}];
  d.status='text_ready_for_review';d.assembly={draft,validation:{errors:[]},text:'离线完整基稿'};return d;
 });
 return {engine,store,requests};
}
const execute=(engine,{refinement=false}={})=>engine.execute('review',{stage:'finish',finishMode:'delta',packageIds:['p1','p2','p3'],attemptId:'review-finish',...(refinement?{purpose:'director_refinement'}:{})});

for(const [label,pair] of [
 ['missing production marker',{rules:v2,production:null}],
 ['production downgraded to v1',{rules:v2,production:v1}],
 ['rules downgraded to v1',{rules:v1,production:v2}],
 ['missing rules marker',{rules:null,production:v2}],
 ['unknown production version',{rules:v2,production:'future'}]
])test(`real finish preparation rejects ${label} before creating an operation or reaching a provider`,async t=>{
 const {engine,requests}=await prepared(t,pair),before=await engine.read('review');
 await assert.rejects(execute(engine),{code:'RULE_SNAPSHOT'});
 assert.equal(requests.length,0);assert.deepEqual(await engine.read('review'),before);
});

for(const version of [v1,v2])test(`paired ${version} reaches only the forbidden-provider boundary with its own basis and schema`,async t=>{
 const {engine,requests}=await prepared(t,{rules:version,production:version});
 await assert.rejects(execute(engine),{code:'PROVIDER_FORBIDDEN'});assert.equal(requests.length,1);
 const request=requests[0],fields=request.schema.properties.productionFeedback.properties;
 assert.equal(request.productionSnapshot.feedbackResultVersion,version);assert.equal(request.previousDraft.feedbackBasis.version,version);
 assert.equal(Boolean(fields.resultRevision.properties.exitDecisions.items.properties.continuation),version===v2);
});

for(const version of [v1,v2])test(`paired ${version} refinement remains independent of ordinary result-revision schema`,async t=>{
 const {engine,requests}=await prepared(t,{rules:version,production:version});
 await assert.rejects(execute(engine,{refinement:true}),{code:'PROVIDER_FORBIDDEN'});assert.equal(requests.length,1);
 assert.equal(requests[0].schema.properties.productionFeedback.properties.resultRevision,undefined);
 assert.ok(!requests[0].prompt.includes('完整结果回执'+version));
});

test('refinement also stops a genuinely mismatched new production root before the provider boundary',async t=>{
 const {engine,requests}=await prepared(t,{production:null}),before=await engine.read('review');
 await assert.rejects(execute(engine,{refinement:true}),{code:'RULE_SNAPSHOT'});
 assert.equal(requests.length,0);assert.deepEqual(await engine.read('review'),before);
});

test('old unversioned production keeps its original no-result-contract preparation path',async t=>{
 const {engine,requests}=await prepared(t,{rules:null,production:null});
 await assert.rejects(execute(engine),{code:'PROVIDER_FORBIDDEN'});
 assert.equal(requests[0].productionSnapshot.feedbackResultVersion,undefined);
 assert.equal(requests[0].schema.properties.productionFeedback.properties.resultRevision,undefined);
});

test('frozen v1 operation replays its captured snapshot without consulting a mismatched current production root',async t=>{
 const {engine}=await prepared(t,{rules:v1,production:v1}),d=await engine.read('review'),packageIds=['p1','p2','p3'];
 const productionSnapshot={version:'production-feedback-v1',feedbackResultVersion:v1,materials:[],episodeBoundary:null,touchesOpening:false,touchesEnding:true,outgoingAgreements:[]};
 const previousDraft=structuredClone(d.assembly.draft),payload={stage:'finish',finishMode:'delta',source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageIds,
  rulesSnapshot:d.rulesSnapshot,voiceReference:d.voiceReference,dependencyExits:{},previousDraft,productionSnapshot};
 const saved=buildRequest(payload),op={stage:'finish',finishMode:'delta',packageIds,previousDraft,productionSnapshot,issues:[],dependencyFormat:'continuity-v1'};
 d.production.feedbackResultVersion=v2;
 const rebuilt=rebuildFrozenRequest(d,op);
 assert.equal(digest([rebuilt.promptHash,rebuilt.instructionHash,rebuilt.inputHash]),digest([saved.promptHash,saved.instructionHash,saved.inputHash]));
 assert.deepEqual(rebuilt.schema,saved.schema);assert.equal(rebuilt.productionSnapshot.feedbackResultVersion,v1);
});
