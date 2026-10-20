import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBoundaryContext,reconcileBoundary} from './episode-boundary.mjs';
import {FEEDBACK_RESULT_VERSION} from './storyboard-v4/core/production-feedback-result.mjs';

function fixture(){
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'sv1',fromEpisode:1,toEpisode:2,adjacentEpisode:true,previousSource:{episode:1,text:'甲只有一只手。',sourceRange:{start:0,end:7},nodes:[{id:'n1',target:'BODY',kind:'ACTION',sourceRange:{start:0,end:7}}]},currentOpening:{episode:2,text:'甲单手取盔。',sourceTextHash:'source-2'},story:{},unknowns:[]};
 const selected={runId:'previous',episode:1,sourceVersion:'sv1',selectionRevision:1};
 const actual={...selected,validated:true,version:'tail1',states:[],unit:{id:'tail',initialState:'甲的空袖垂下',shots:[{id:'tail-s1',picture:'空袖垂落，剩下的拳头握紧'}]}};
 const context=makeBoundaryContext({seed,selected,actual});
 const source={sourceRows:[{id:'s1',kind:'action',text:'甲单手取盔。'}],contextRows:[],dialogue:[]};
 const entry={key:'character/limb',value:'缺一臂，剩下的拳头握紧',authority:'SOURCE',sourceRefs:['boundary:1:n1']};
 const draft={schemaVersion:'performance-core-v4',units:[{id:'opening',initialState:'甲空袖下垂',shots:[{id:'opening-s1',picture:'单手摘下头盔，另一侧空袖仍垂落'}]}],fantasyRealization:[]};
 const feedback={relation:'DIRECT',entry:[entry],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[],entryEvidence:[{key:entry.key,verdict:'CONSISTENT',reason:'前尾和本集均保持独臂，未补造前尾状态键',priorEvidence:[{unitId:'tail',shotId:'tail-s1',field:'picture',quote:'空袖垂落，剩下的拳头握紧'}],currentEvidence:[{unitId:'opening',shotId:'opening-s1',field:'picture',quote:'另一侧空袖仍垂落'}]}]};
 const request={stage:'finish',source,episodeBoundary:structuredClone(context),productionSnapshot:{feedbackResultVersion:FEEDBACK_RESULT_VERSION,touchesOpening:true}};
 return {context,feedback,source,nativeEvidence:{request,draft}};
}
test('native normal finishing proof handles missing SOURCE key without synthesizing actual or deleting missing evidence',()=>{
 const f=fixture(),before=structuredClone(f),r=reconcileBoundary(f);
 assert.equal(r.status,'NOT_CONSUMED');assert.equal(r.inherit,false);
 assert.deepEqual(r.sourceReviewedKeys,['character/limb']);assert.deepEqual(r.missingKeys,['character/limb']);assert.ok(r.nativeEvidenceReviewId);
 assert.deepEqual(f,before);
 assert.deepEqual(reconcileBoundary({...f,previousCheck:r}),r);
});
test('old protocol, no proof, stale actual and unverified predecessor facts stay unresolved',()=>{
 for(const change of [f=>delete f.nativeEvidence.request.productionSnapshot.feedbackResultVersion,f=>f.feedback.entryEvidence=[],f=>f.context.versionId='changed',f=>f.feedback.entry[0].sourceRefs=['unverified-context']]){
  const f=fixture();change(f);assert.equal(reconcileBoundary(f).status,'UNRESOLVED');
 }
});
test('known actual/locked conflict, explicit hand-release conflict and inconclusive proof never release the gate',()=>{
 const f=fixture();f.feedback.conflicts=[{key:'hand/release',problem:'前尾提前松手，本集原文才松手',sourceRefs:['s1']}];
 assert.equal(reconcileBoundary(f).status,'CONSTRAINT_CONFLICT');
 const known=fixture();known.context.actual.states=[{...known.feedback.entry[0],value:'双臂完好'}];
 assert.equal(reconcileBoundary(known).status,'CONSTRAINT_CONFLICT');
 const design=fixture();design.feedback.entry[0].authority='DESIGN';assert.equal(reconcileBoundary(design).status,'UNRESOLVED');
 const unresolved=fixture();unresolved.feedback.entryEvidence[0].verdict='UNRESOLVED';assert.equal(reconcileBoundary(unresolved).status,'UNRESOLVED');
 const quote=fixture();quote.feedback.entryEvidence[0].priorEvidence[0].quote='不存在的原稿';assert.equal(reconcileBoundary(quote).status,'UNRESOLVED');
});
