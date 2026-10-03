import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {buildSourceIndex} from '../lib/project-foundation-contracts';
import {buildEpisodeBoundarySeed} from '../lib/episode-boundary-seed';
import {buildLightBoundaryContext} from '../lib/light-foundation-supply';

const require=createRequire(import.meta.url);
const {makeEpisodeInput}=require('../runtime/storyboard-v4/input.mjs');
const {validateProductionFeedback}=require('../runtime/episode-boundary.mjs');
const episode={id:'synthetic-ep2',projectId:'synthetic-project',number:2,title:'本集',content:'第二集\n2-1 大厅 日 内\n△乙关门。'};
const project={id:episode.projectId,style:'3D国漫',aspectRatio:'16:9'};
const lines=['第一集','1-1 大厅 日 内','出场人物：甲、乙、众人','甲：整个世界必须听我命令！','众人：','（齐声）','我们绝不能失败！',
 '导演处理：这只是创作辅助。','甲：绝不能输。乙：必须听令。','【未知提示】这条不是动作证据。','△甲放下钥匙。'];
const feedback=(id:string)=>({relation:'DIRECT',entry:[{key:'claim',value:'整句为世界规则',authority:'SOURCE',sourceRefs:[id]}],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]});
for(const eol of ['\n','\r\n','\r']){
 const text=lines.join(eol),index=buildSourceIndex([{number:1,title:'前集',content:text},episode]);
 const episodeBoundary=buildEpisodeBoundarySeed(index,[],2,{knownSpeakers:['甲','乙','众人'],syntax:'current'});
 const boundaryContext=buildLightBoundaryContext(index,null,[],[2],{episodeBoundary});
 assert(episodeBoundary.previousSource?.nodes.some(node=>node.kind==='DIALOGUE_GROUP'),'exercise real group compiler output');
 assert(episodeBoundary.previousSource?.nodes.some(node=>node.target==='UNRESOLVED'),'exercise real unresolved note output');
 const packet={sourceVersion:index.version,sourceText:episode.content,episodeBoundary,boundaryContext};
 const result=makeEpisodeInput({episode,project,handoff:{packet},inputProtocol:'upstream-material-v2'});
 for(const row of result.source.contextRows){
  if(row.text==='△甲放下钥匙。'){
   assert.equal(row.kind,'action');assert.equal(validateProductionFeedback(feedback(row.id),{source:result.source}).entry[0].authority,'SOURCE');
  }else{
   assert.equal(row.evidenceRole,'guidance',row.text);
   assert.throws(()=>validateProductionFeedback(feedback(row.id),{source:result.source}),{code:'PRODUCTION_FEEDBACK'},row.text);
  }
 }
 assert.equal(result.source.contextRows.map((row:{text:string})=>row.text).join(eol),boundaryContext?.previousSource.text,'keep the complete original excerpt');
 assert.equal(result.source.contextRows.find((row:{text:string})=>row.text==='甲：绝不能输。乙：必须听令。').kind,'dialogue');
 assert.equal(result.source.contextRows.find((row:{text:string})=>row.text==='我们绝不能失败！').kind,'dialogue');
}
console.log('PASS real standard compiler → prior boundary → V2 input → feedback authority; LF/CRLF/CR, group/multiline speech, unresolved notes and exact source actions; no models or database writes');
