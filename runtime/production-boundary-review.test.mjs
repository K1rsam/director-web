import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProductionBoundaryPacket,assertBoundaryPacket} from './production-boundary-review.mjs';
import {selectedActualTail} from './episode-boundary.mjs';
import {digest} from './storyboard-v4/core/shared.mjs';

function fixture(){
 const source={sourceRows:[{id:'s',kind:'action',text:'甲握拳。'}],contextRows:[],dialogue:[]},unit={id:'u',shots:[{id:'tail',picture:'手仍握拳。'}]};
 const workflow={id:'workflow',projectId:'project-B',sourceVersion:'sv',selectionRevision:2,selectedRuns:{21:'prev',22:'current'}};
 const previous={id:'prev',source,assembly:{text:'原末稿',draft:{units:[unit]},validation:{errors:[]}},adopted:[{candidateId:'pf',draft:{units:[unit]}}],candidates:[{id:'pf',attemptId:'pa',productionFeedback:{exit:[{key:'hand',value:'握拳',authority:'SOURCE'}]}}],operations:[{attemptId:'pa',productionSnapshot:{touchesEnding:true}}],web:{binding:{projectId:'project-B',episodeNumber:21}}};
 const tail=selectedActualTail(previous),context={mode:'ACTUAL',versionId:'context',seed:{fromEpisode:21,toEpisode:22},actual:{runId:'prev',version:digest(tail),validated:true,...tail}};
 const feedback={relation:'DIRECT',entry:[{key:'hand',value:'握拳',authority:'SOURCE'}],exit:[],needs:[],conflicts:[]};
 const draft={schemaVersion:'performance-core-v4',units:[unit],fantasyRealization:[]};
 const current={id:'current',source,plan:{workPackages:[{id:'p',sourceRefs:['s']}]},assembly:{text:'首镜稿',draft},adopted:[{candidateId:'cf',packageIds:['p'],draft}],candidates:[{id:'cf',stage:'finish',status:'adopted',attemptId:'ca',packageIds:['p'],draft,productionFeedback:feedback}],operations:[{attemptId:'ca',productionSnapshot:{episodeBoundary:context}}],production:{boundary:context,boundaryCheck:{status:'MATCHED'}},web:{binding:{projectId:'project-B',episodeNumber:22,productionChain:{id:'workflow'}}}};
 const sources={previous:'第21集完整原文',current:'第22集完整原文'};return {workflow,current,previous,sources};
}
test('general evidence packet binds both complete sources, true tail, current final feedback and exact selection',()=>{
 const f=fixture(),before=structuredClone(f),packet=buildProductionBoundaryPacket(f.workflow,f.current,f.previous,f.sources);
 assert.deepEqual(packet.sources,f.sources);assert.equal(packet.current.entry.id,'cf');assert.deepEqual(packet.previous.tail,selectedActualTail(f.previous));assert.deepEqual(f,before);
 assertBoundaryPacket(packet,packet.evidenceHash);
 for(const mutate of [x=>x.sources.current+='新原文',x=>x.current.candidates[0].productionFeedback.entry[0].value='放手',x=>x.current.assembly.text+='变稿',x=>x.workflow.selectionRevision++]){
  const changed=structuredClone(f);mutate(changed);assert.throws(()=>assertBoundaryPacket(buildProductionBoundaryPacket(changed.workflow,changed.current,changed.previous,changed.sources),packet.evidenceHash),{code:'WORKFLOW_BOUNDARY_STALE'});
 }
 f.current.documentRevision=9;f.previous.documentRevision=20;assert.equal(buildProductionBoundaryPacket(f.workflow,f.current,f.previous,f.sources).evidenceHash,packet.evidenceHash,'non-semantic persistence revisions do not invalidate evidence');
});
test('preliminary, unselected, busy and missing true tail cannot be reviewed from summaries',()=>{
 for(const mutate of [f=>f.current.production.boundary.mode='PRELIMINARY',f=>f.workflow.selectedRuns[21]='other',f=>f.current.operations[0].status='running',f=>f.previous.assembly.draft.units=[]]){
  const f=fixture();mutate(f);assert.throws(()=>buildProductionBoundaryPacket(f.workflow,f.current,f.previous,f.sources),{code:'WORKFLOW_BOUNDARY_EVIDENCE'});
 }
});
test('per-episode selection binds the reviewed pair, not unrelated lane admissions',()=>{
 const f=fixture();f.current.web.binding.productionChain.selectionProtocol='per-episode-selection-v1';f.workflow.selectionHistory=[{episodeNumber:21,runId:'prev',selectionRevision:1},{episodeNumber:22,runId:'current',selectionRevision:2}];
 const first=buildProductionBoundaryPacket(f.workflow,f.current,f.previous,f.sources);f.workflow.selectionRevision++;
 f.workflow.selectedRuns[23]='another-lane';f.workflow.selectionHistory.push({episodeNumber:23,runId:'another-lane',selectionRevision:3});
 assert.equal(buildProductionBoundaryPacket(f.workflow,f.current,f.previous,f.sources).evidenceHash,first.evidenceHash);
 f.workflow.selectionHistory.push({episodeNumber:22,runId:'current',selectionRevision:4});
 assert.notEqual(buildProductionBoundaryPacket(f.workflow,f.current,f.previous,f.sources).evidenceHash,first.evidenceHash);
});
