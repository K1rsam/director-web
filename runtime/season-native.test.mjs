import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCoordinator} from './storyboard-v4/coordinator.mjs';
import {createProductionWorkflowService} from './production-workflow.mjs';
import {seasonHash} from './season-scope.mjs';
const scope={version:'series-season-scope-v1',status:'locked',episodeNumbers:[5,2],sourceVersion:'v',id:'S01'};
test('native coordinator advertises actual season contract and rejects out-of-scope creation before runner',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'season-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));let calls=0;
 const c=createCoordinator({dataRoot:directory,modelRunner:async()=>{calls++;throw new Error('must not dispatch');}});t.after(()=>c.shutdown());
 assert.equal(c.runtimeIdentity().seasonScopeVersion,'series-season-scope-v1');
 await assert.rejects(c.create({source:{key:'e9',sourceRows:[{id:'r1',text:'甲：原话。'}]},binding:{projectId:'p',episodeId:'e9',episodeNumber:9,sourceVersion:'v',season:{scope,scopeHash:seasonHash(scope)}},settings:{fantasyMode:'off'}}),{code:'SEASON_SCOPE'});assert.equal(calls,0);
});
test('native workflow freezes source order and changed scope cannot dispatch any paid action',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'season-workflow-'));t.after(()=>rm(directory,{recursive:true,force:true}));let calls=0;
 const snapshot={sourceVersion:'v',availableEpisodes:[5,2,9],stage1:{ready:false},seasonMode:'season',season:{scope,scopeHash:seasonHash(scope)},standard:{ready:true},direction:{status:'CONFIRMED'},assets:{},runs:{}};
 const s=createProductionWorkflowService({directory:path.join(directory,'flow'),budgetDirectory:path.join(directory,'budget'),adapters:{withBudget:async(_b,fn)=>fn(),inspect:async()=>snapshot,run:async()=>{calls++;return {};}}});
 let v=await s.create({projectId:'p',actorId:'u',episodeNumbers:[2,5],costAcknowledged:true});assert.deepEqual(v.workflow.episodeNumbers,[5,2]);assert.equal(v.workflow.season.scopeHash,seasonHash(scope));
 await assert.rejects(s.create({projectId:'p',actorId:'u',episodeNumbers:[9],costAcknowledged:true}),{code:'SEASON_SCOPE'});
 snapshot.season={scope:{...scope,episodeNumbers:[5]},scopeHash:'changed'};v=await s.inspect(v.workflow.id);assert.equal(v.nextAction.kind,'WAIT_SEASON_SCOPE');await s.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(calls,0);
});
