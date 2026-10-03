import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEpisodeInput} from './input.mjs';

const episode={id:'ep',projectId:'p',number:1,title:'第1集',content:'甲：你好。'};
const project={id:'p',style:'3D国漫',aspectRatio:'16:9'};
test('new explicit failed script reception is rejected before dispatch',()=>{
 const handoff={readiness:'PARTIAL',reasons:['第1行说者待确认'],packet:{sourceText:episode.content,
  scriptReception:{version:'standard-episode-v1',ready:false,diagnostics:[{line:1,code:'UNKNOWN_COLON_LINE',message:'说者待确认'}]},standardScript:null}};
 assert.throws(()=>makeEpisodeInput({episode,project,handoff}),e=>e.code==='SOURCE_DIAGNOSTICS');
});
test('saved legacy adapter can still reproduce an unversioned source',()=>{
 const before=makeEpisodeInput({episode,project,handoff:{readiness:'READY',reasons:[],packet:{sourceText:episode.content}}});
 assert.equal(before.source.dialogue[0].speaker,'甲');
 assert.equal(before.source.dialogue[0].quote,'你好。');
 assert.equal(before.source.sourceProtocol,undefined);
});
