import assert from 'node:assert/strict';
import {createSeriesDirectionDraft,confirmSeriesDirection,projectSeriesDirection,type SeriesDirectionInput,type SeriesSourceContext} from '../lib/series-direction';

const source:SeriesSourceContext={projectId:'knowledge-fixture',sourceVersion:'source-1',episodeIds:['e1','e2'],evidenceIds:['episode:e1','episode:e2']};
const content={settingTags:[],mechanismTags:[],arcTags:[],primaryTone:'克制',secondaryTones:[],audiencePromise:'逐步发现关系。',expressionRules:[],avoidances:[],episodeFlexibility:'依原文时点变化。'};
const knowledgeIndex=[
 {id:'claim',kind:'RELATIONSHIP',claim:'CHARACTER_CLAIM',statement:'甲自称乙的兄长。',subjects:['甲','乙'],source:{evidenceId:'episode:e1',episodeId:'e1',quote:'甲：我是你兄长。',start:0,end:9}},
 {id:'reveal',kind:'REVEAL',claim:'SOURCE',statement:'甲的兄长身份被证伪。',subjects:['甲','乙'],source:{evidenceId:'episode:e2',episodeId:'e2',quote:'档案显示甲与乙没有血缘。',start:10,end:24}},
 {id:'change',kind:'CHANGE',claim:'SOURCE',statement:'乙的右手受伤。',subjects:['乙'],source:{evidenceId:'episode:e2',episodeId:'e2',quote:'乙的右手受伤。',start:25,end:33}},
];
const input={id:'direction',revision:1,sourceVersion:'source-1',reviewedEpisodeIds:source.episodeIds,evidenceRefs:source.evidenceIds,content,knowledgeIndex} as SeriesDirectionInput;
const draft=createSeriesDirectionDraft(input,source);
assert.equal((draft as any).knowledgeIndex?.length,3,'existing all-series reading retains a source-grounded relation/reveal/change index');
const approval={id:'human-decision',projectId:source.projectId,sourceVersion:source.sourceVersion,draftHash:draft.hash,actorId:'reviewer',confirmedAt:'2026-10-01T00:00:00.000Z'};
const card=confirmSeriesDirection(draft,source,approval),first=projectSeriesDirection(card,source,'e1',approval) as any,second=projectSeriesDirection(card,source,'e2',approval) as any;
assert.equal(first.brief,second.brief);assert.ok([...first.brief].length<=600);
assert.deepEqual(first.seriesKnowledge.map((x:any)=>x.id),['claim'],'future reveal and injury are not supplied early');
assert.equal(first.seriesKnowledge[0].claim,'CHARACTER_CLAIM');
assert.equal(first.seriesKnowledge[0].timing,'CURRENT_EPISODE_EVENT');
assert.equal(second.seriesKnowledge[0].timing,'PRIOR_EVIDENCE','past source is evidence, not a claim that state persists');
assert.equal(second.seriesKnowledge.length,3);
const legacy=createSeriesDirectionDraft({...input,knowledgeIndex:undefined} as SeriesDirectionInput,source);
assert.ok(!Object.hasOwn(legacy,'knowledgeIndex'),'legacy card hashes remain compatible');
const tampered=structuredClone(card) as any;tampered.knowledgeIndex[1].source.episodeId='e1';
assert.throws(()=>projectSeriesDirection(tampered,source,'e1',approval),/DIRECTION_INTEGRITY/);
assert.throws(()=>createSeriesDirectionDraft({...input,knowledgeIndex:[{...knowledgeIndex[0],source:{...knowledgeIndex[0].source,evidenceId:'invented'}}]} as SeriesDirectionInput,source),/DIRECTION_EVIDENCE/);
assert.throws(()=>projectSeriesDirection(card,{...source,episodeIds:['e2','e1']},'e1',approval),/DIRECTION_INTEGRITY|DIRECTION_STALE/,'knowledge chronology must bind the source episode order');
console.log('PASS series knowledge: immutable provenance, same <=600-character direction, episode-timed reveals/states, attributed claims and legacy compatibility; DB/model calls 0');
