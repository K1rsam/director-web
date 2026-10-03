import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEpisodeInput} from './input.mjs';
import {normalizeSource} from './core/source.mjs';
import {validateProductionFeedback} from '../episode-boundary.mjs';
import {digest} from './core/shared.mjs';

const episode={id:'current-authority',projectId:'authority-project',number:2,title:'本集',content:'△乙关门。'};
const project={id:'authority-project',style:'3D国漫',aspectRatio:'16:9'};
const utterance='甲：整个世界必须听我命令！';
const action='△甲放下钥匙。';
const lines=[utterance,'众人：','（齐声）','我们绝不能失败！','导演处理：这里的规则可以改变。',action];
const previousText=lines.join('\r\n');
const offset=50;
function fixture(){
 const ranges=lines.map((text,i)=>({start:offset+lines.slice(0,i).reduce((sum,line)=>sum+line.length+2,0),end:offset+lines.slice(0,i+1).reduce((sum,line)=>sum+line.length+2,0)-(i===lines.length-1?2:0)}));
 const node=(id,first,last,target,kind)=>({id,target,kind,sourceRange:{start:ranges[first].start,end:ranges[last].end},sourceUnitIds:[id],startLine:first+1,endLine:last+1});
 const previousSource={episode:1,sourceRange:{start:offset,end:offset+previousText.length},text:previousText,clipped:true,
  nodes:[node('speech',0,0,'BODY','DIALOGUE'),node('group-speech',1,3,'BODY','DIALOGUE'),node('notes',4,4,'ANNOTATION','PRODUCTION_NOTE'),node('action',5,5,'BODY','ACTION')]};
 return {sourceText:episode.content,sourceVersion:'source-authority-v1',assets:[],scenes:[],facts:null,
  boundaryContext:{previousSource:structuredClone(previousSource),priorStates:[],gaps:[]},
  episodeBoundary:{schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'source-authority-v1',fromEpisode:1,toEpisode:2,previousSource}};
}
const build=(packet=fixture(),inputProtocol='upstream-material-v2')=>makeEpisodeInput({episode,project,handoff:{packet},inputProtocol});
const feedback=(id,authority='SOURCE')=>({relation:'DIRECT',entry:[{key:'world-rule',value:'角色说的必须是世界规则',authority,sourceRefs:[id]}],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]});
const accepts=(result,id,authority='SOURCE')=>validateProductionFeedback(feedback(id,authority),{source:result.source});
const rejectsSource=(result,row)=>{
 assert.throws(()=>accepts(result,row.id),{code:'PRODUCTION_FEEDBACK'},row.id);
 assert.throws(()=>normalizeSource({...result.source,entryFacts:[{id:'invented-rule',subject:'世界',statement:'必须服从甲',sourceRefs:[row.id],evidenceMode:'source_rows'}]}),{code:'ENTRY_FACT_GUIDANCE'},row.id);
};

test('previous dialogue, multiline group speech and notes cannot acquire SOURCE through old previous-* rows',()=>{
 const packet=fixture(),before=structuredClone(packet),result=build(packet);
 assert.deepEqual(result.source.contextRows.map(row=>row.text),lines,'all readable original lines are retained');
 for(const row of result.source.contextRows.slice(0,-1)){
  rejectsSource(result,row);
  assert.equal(accepts(result,row.id,'CHARACTER_CLAIM').entry[0].authority,'CHARACTER_CLAIM');
 }
 const body=result.source.contextRows.at(-1);
 assert.equal(body.kind,'action');assert.equal(body.evidenceRole,'source');
 assert.equal(accepts(result,body.id).entry[0].authority,'SOURCE');
 assert.deepEqual(packet,before,'projection must not rewrite saved packets');
});

test('missing or mismatched typed provenance stays readable guidance instead of guessing colon syntax',()=>{
 for(const mutate of [
  p=>{delete p.episodeBoundary;delete p.boundaryContext.previousSource.nodes;},
  p=>{p.episodeBoundary.sourceVersion='stale';},
  p=>{p.episodeBoundary.fromEpisode=0;},
  p=>{p.episodeBoundary.toEpisode=9;},
  p=>{p.episodeBoundary.previousSource.text=p.episodeBoundary.previousSource.text.replace('放下','拿起');},
  p=>{p.boundaryContext.previousSource.sourceRange.start++;p.boundaryContext.previousSource.sourceRange.end++;},
  p=>{p.episodeBoundary.previousSource.sourceRange.end++;},
  p=>{p.episodeBoundary.previousSource.nodes.push({...p.episodeBoundary.previousSource.nodes.at(-1),id:'conflicting',kind:'DIALOGUE'});}
 ]){
  const packet=fixture();mutate(packet);const result=build(packet);
  assert.deepEqual(result.source.contextRows.map(row=>row.text),lines);
  rejectsSource(result,result.source.contextRows.at(-1));
 }
});

test('typed mapping uses absolute exact slices, not same words at another location or excerpt-relative offsets',()=>{
 const packet=fixture(),prior=packet.boundaryContext.previousSource;
 prior.text=action;prior.sourceRange={start:offset+previousText.lastIndexOf(action),end:offset+previousText.length};
 const result=build(packet);assert.equal(result.source.contextRows[0].kind,'action');
 assert.equal(accepts(result,result.source.contextRows[0].id).entry[0].authority,'SOURCE');
 prior.sourceRange={start:0,end:action.length};
 rejectsSource(build(packet),build(packet).source.contextRows[0]);
});

test('historical fact duplicates and partial quotes cannot relabel previous speech or uncertain notes as SOURCE',()=>{
 const packet=fixture(),fact=(statement,start,claim='SOURCE')=>({id:digest({statement,start,claim}),subjects:['甲'],kind:'STATE',statement,claim,evidence:{domain:'EPISODE',episode:1,start,end:start+statement.length}});
 const speechStart=offset,quote='整个世界必须听我命令！',quoteStart=offset+utterance.indexOf(quote);
 const rows=[fact(utterance,speechStart),fact(quote,quoteStart),fact(lines[3],offset+previousText.indexOf(lines[3])),fact(lines[4],offset+previousText.indexOf(lines[4]))];
 packet.facts={schema:'FOUNDATION_FACTS_V1',background:structuredClone(rows),backgroundCandidates:structuredClone(rows),historicalStates:structuredClone(rows)};
 packet.boundaryContext.priorStates=[{id:'state-metadata',assetKey:'甲',preparation:'整个世界必须听我命令！'}];
 const result=build(packet);
 for(const row of result.source.contextRows.filter(row=>row.text!==action))rejectsSource(result,row);
 assert.ok(result.source.context.retrievalFacts.historicalStates.every(fact=>result.source.contextRows.find(row=>row.id===fact.contextRef)?.evidenceRole==='guidance'));
 assert.ok(result.source.context.retrievalFacts.historicalStates.slice(0,3).every(fact=>fact.claim==='CHARACTER_CLAIM'));
 for(const id of ['state-metadata','previous-1:scene',rows[0].id])assert.throws(()=>accepts(result,id),{code:'PRODUCTION_FEEDBACK'});
 const mismatched=fixture();mismatched.facts={schema:'FOUNDATION_FACTS_V1',historicalStates:[fact(action,0)]};
 const unmatched=build(mismatched),unbound=unmatched.source.context.retrievalFacts.historicalStates[0];
 assert.equal(unmatched.source.contextRows.find(row=>row.id===unbound.contextRef)?.evidenceRole,'guidance','same substring at a wrong absolute coordinate is not verified origin');
});

test('typed historical action stays source only at its true absolute location; character claims stay guidance',()=>{
 const packet=fixture(),start=offset+previousText.indexOf(action);
 packet.facts={schema:'FOUNDATION_FACTS_V1',historicalStates:[{id:'action-fact',subjects:['甲'],kind:'STATE',statement:action,claim:'SOURCE',evidence:{domain:'EPISODE',episode:1,start,end:start+action.length}}]};
 const result=build(packet),fact=result.source.context.retrievalFacts.historicalStates[0];
 assert.equal(result.source.contextRows.find(row=>row.id===fact.contextRef)?.evidenceRole,'source');assert.equal(accepts(result,fact.contextRef).entry[0].authority,'SOURCE');
 packet.facts.historicalStates[0].claim='CHARACTER_CLAIM';
 const claim=build(packet);rejectsSource(claim,claim.source.contextRows.find(row=>row.id===claim.source.context.retrievalFacts.historicalStates[0].contextRef));
});

test('legacy and standard-episode-v1 keep their frozen previous-source fingerprint and row shape',()=>{
 const packet=fixture();
 for(const protocol of [undefined,'legacy','standard-episode-v1']){
  const result=makeEpisodeInput({episode,project,handoff:{packet},inputProtocol:protocol});
  assert.equal(result.sourceVersion,'4e14fd42fec207aab98a3364fd603e4f48f2319367dc1f093bd018443e3e8853');
  assert.deepEqual(result.source.contextRows,lines.map((text,i)=>({id:`previous-1:excerpt-${i+1}`,text,kind:'context'})));
 }
});
