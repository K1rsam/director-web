import assert from 'node:assert/strict';
import test from 'node:test';
import {deriveView} from '../app/projects/[projectId]/episodes/[episodeId]/storyboard/view-state';
import type {Run} from '../app/projects/[projectId]/episodes/[episodeId]/storyboard/types';
import * as productionUi from '../app/projects/[projectId]/production/types';

const shared={maxCalls:40,maxTokens:2000000,calls:10,knownTokens:880706,unknownAttempts:1,inFlight:0,complete:false};
function fixture(extra:Record<string,unknown>={}):Run{
 return {id:'synthetic-run',status:'paused',createdAt:'2026-10-14T00:00:00.000Z',active:false,sourceStale:false,preparation:{ready:true},
  settings:{maxUnitSeconds:30,fantasyMode:'off'},sourceRows:[{id:'S1',text:'合成来源。'}],choice:{mode:'off'},
  plan:{emotionArc:'合成情绪',workPackages:[{id:'P1',sourceRefs:['S1'],emotionContract:{subject:'合成人物',contextTone:'合成基调',audienceEffect:'合成感受',change:'合成变化',landing:'合成落点',retain:[]},dependsOn:[]}],provisionalUnits:[],fantasyCandidates:[]},
  adopted:[],candidates:[],operations:[{attemptId:'synthetic-unknown',stage:'author',packageIds:['P1'],status:'unknown',createdAt:'2026-10-14T00:00:00.000Z',requestOutcome:'UNKNOWN',usage:null,cancelAcknowledgement:{at:'2026-10-14T00:00:01.000Z',acceptUnknownUsage:true}}],
  usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0,knownTokens:0,complete:false,unknownAttempts:1,acknowledgedUnknownAttempts:1},budget:{maxCalls:40,maxTokens:2000000,maxRepairs:2},
  production:{boundary:null,materialNeeds:[],sharedBudget:{...shared,...extra},pendingRepair:null,blocking:false,chainComplete:false,chainMode:'CHAIN'}};
}

test('shared blocking count can release only the budget gate while unknown/null evidence remains',()=>{
 const run=fixture({acknowledgedUnknownAttempts:1,blockingUnknownAttempts:0}),before=structuredClone(run),view=deriveView(run,true);
 assert.equal(view.canRun,true);assert.equal(view.budgetReason,'');assert.match(view.description,/共享账本.*授权.*1/);assert.match(view.description,/仍为未知费用/);
 assert.deepEqual(run,before);assert.equal(run.usage.complete,false);assert.equal(run.operations[0].usage,null);
});

test('old shared ledger and locally acknowledged risk never masquerade as shared authorization',()=>{
 const legacy=deriveView(fixture(),true);assert.equal(legacy.canRun,false);assert.match(legacy.budgetReason,/共享.*未知/);assert.doesNotMatch(legacy.description,/共享账本已授权/);
 assert.match(legacy.description,/单任务确认不替代共享账本授权/);
 const partial=deriveView(fixture({acknowledgedUnknownAttempts:1}),true);assert.equal(partial.canRun,false,'without a blocking count use the original unknown count');
});

test('unacknowledged shared attempts, local unknowns, source gates and original caps still block paid actions',()=>{
 assert.equal(deriveView(fixture({unknownAttempts:2,acknowledgedUnknownAttempts:1,blockingUnknownAttempts:1}),true).canRun,false);
 const local=fixture({acknowledgedUnknownAttempts:1,blockingUnknownAttempts:0});local.usage.acknowledgedUnknownAttempts=0;assert.equal(deriveView(local,true).canRun,false);
 const unresolved=fixture({acknowledgedUnknownAttempts:1,blockingUnknownAttempts:0});delete unresolved.operations[0].cancelAcknowledgement;assert.equal(deriveView(unresolved,true).canRun,false);
 const unavailable=fixture();unavailable.production!.sharedBudget={unavailable:true};assert.equal(deriveView(unavailable,true).canRun,false);
 for(const field of ['sourceStale','sourceCheckPending','blocked'] as const){const run=fixture({acknowledgedUnknownAttempts:1,blockingUnknownAttempts:0});run[field]=true;assert.equal(deriveView(run,true).canRun,false);}
 assert.equal(deriveView(fixture({calls:40,acknowledgedUnknownAttempts:1,blockingUnknownAttempts:0}),true).canRun,false);
 assert.equal(deriveView(fixture({knownTokens:2000000,acknowledgedUnknownAttempts:1,blockingUnknownAttempts:0}),true).canRun,false);
});

test('project and parallel budget guard use shared blocking count, never subtract local acknowledgements',()=>{
 const api=productionUi as typeof productionUi & {productionBudgetStopped:(budget:{paused:boolean;maxCalls:number;maxTokens:number;summary:typeof shared & {acknowledgedUnknownAttempts?:number;blockingUnknownAttempts?:number}})=>boolean};
 assert.equal(typeof api.productionBudgetStopped,'function');
 const budget={paused:false,maxCalls:40,maxTokens:2000000,summary:{...shared}};
 assert.equal(api.productionBudgetStopped(budget),true);
 assert.equal(api.productionBudgetStopped({...budget,summary:{...shared,acknowledgedUnknownAttempts:1}}),true);
 const accepted={...budget,summary:{...shared,acknowledgedUnknownAttempts:1,blockingUnknownAttempts:0}};
 assert.equal(api.productionBudgetStopped(accepted),false);assert.equal(api.productionBudgetStopped({...accepted,paused:true}),true);
 assert.equal(api.productionBudgetStopped({...accepted,summary:{...accepted.summary,calls:40}}),true);
 assert.equal(api.productionBudgetStopped({...accepted,summary:{...accepted.summary,knownTokens:2000000}}),true);
 assert.equal(api.productionBudgetStopped({...accepted,summary:{...accepted.summary,unknownAttempts:2,blockingUnknownAttempts:1}}),true);
});
