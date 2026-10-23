import test from 'node:test';
import assert from 'node:assert/strict';
import * as quality from './quality.mjs';
import {buildOutputSchema} from './output-schema.mjs';
import {captureRules} from './core.mjs';
import {VERSION} from './shared.mjs';

const version='voice-delivery-v1';
function fixture(){
 const source={key:'voice-test',contextRows:[],sourceRows:[{id:'r1',kind:'dialogue',text:'甲（含糊哼出，尾音极短）：嗯。'}],dialogue:[{id:'q1',speaker:'甲',quote:'嗯。',cue:'含糊哼出，尾音极短',channel:'现场对白',kind:'vocalization',sourceIds:['r1']}]};
 const shot={id:'p-s1',duration:3,camera:'固定近景',picture:'甲看着实景牌匾“东门”，手指停在原位。',lighting:'窗光',sound:'一声短哼',dialogueParts:[{lineId:'q1',text:'嗯。',presentation:'画内',delivery:'喉间压低短哼，尾音骤停',voiceStart:1,voiceEnd:2}],transition:'停在甲目光',sourceRefs:['r1'],contextRefs:[],postproductionNotes:[{text:'人名身份条：甲；左下角淡入，停留2秒后淡出，仅后期编辑。',sourceRefs:['r1']}]};
 const draft={schemaVersion:VERSION,units:[{id:'p-u1',title:'确认',scene:'内 日',props:['东门牌匾'],participants:['甲'],unitDirection:'让目光与短哼接续。',lighting:'窗光',initialState:'甲站在牌匾前。',exitState:'甲仍看向牌匾。',intent:{subject:'甲',change:'看向确认',landing:'目光落定',retain:['原声短哼']},shots:[shot]}],fantasyRealization:[]};
 return {draft,source};
}
test('new execution text does not inject raw vocalization cue; legacy text is unchanged',()=>{
 const f=fixture(),before=structuredClone(f),legacy=quality.renderDraft({...f,seedanceExportVersion:'seedance-execution-v4'});
 assert.match(legacy,/含糊哼出，尾音极短/);
 const text=quality.renderDraft({...f,seedanceExportVersion:'seedance-execution-v4',generationTextVersion:version});
 assert.doesNotMatch(text,/含糊哼出，尾音极短/);assert.match(text,/甲（声事件·喉间压低短哼，尾音骤停）：“嗯。”/);
 assert.match(text,/实景牌匾“东门”/);assert.doesNotMatch(text,/人名身份条|仅后期|左下角/);assert.deepEqual(f,before);
});
test('new response schema carries separate shot notes without changing legacy schema',()=>{
 const {source}=fixture(),args={stage:'author',source,settings:{fantasyEnabled:false},selection:{selectedIds:[]}};
 const old=buildOutputSchema(args),next=buildOutputSchema({...args,generationTextVersion:version});
 assert.equal(old.properties.units.items.properties.shots.items.properties.postproductionNotes,undefined);
 const schema=next.properties.units.items.properties.shots.items.properties.postproductionNotes;
 assert.ok(schema,'new schema lacks the independent editor-note channel');assert.equal(schema.type,'array');assert.deepEqual(schema.items.properties.sourceRefs.items.enum,['r1']);
});
test('separate editor export keeps exact source coordinates and is not a generation paragraph',()=>{
 assert.equal(typeof quality.renderPostproductionNotes,'function','independent editor export is missing');
 const f=fixture(),before=structuredClone(f),notes=quality.renderPostproductionNotes({...f,generationTextVersion:version});
 assert.match(notes,/p-u1.*p-s1/s);assert.match(notes,/r1/);assert.match(notes,/人名身份条：甲/);assert.doesNotMatch(notes,/喉间压低短哼|实景牌匾/);
 assert.equal(quality.renderPostproductionNotes(f),'');f.draft.units[0].shots[0].postproductionNotes=[];
 assert.equal(quality.renderPostproductionNotes({...f,generationTextVersion:version}),'');assert.deepEqual(before.source,f.source);
});
test('invalid editor source coordinates fail structurally and never become automatic semantic approval',()=>{
 const f=fixture();f.draft.units[0].shots[0].postproductionNotes[0].sourceRefs=['foreign'];
 assert.equal(quality.validateDraft({...f,generationTextVersion:version}).errors.some(e=>e.code==='POSTPRODUCTION_NOTES'),true);
 assert.equal(quality.validateDraft(f).errors.some(e=>e.code==='POSTPRODUCTION_NOTES'),false);
});
test('new rule capture freezes the generation-text protocol',()=>assert.equal(captureRules().generationTextVersion,version));
test('dialogue text and punctuation still bind to the original quote, while channel changes are rejected',()=>{
 for(const text of ['嗯！','嗯','含糊哼出：嗯。']){
  const f=fixture();f.draft.units[0].shots[0].dialogueParts[0].text=text;
  assert.ok(quality.validateDraft({...f,generationTextVersion:version}).errors.some(e=>e.code==='DIALOGUE_CONTENT'));
 }
 const f=fixture();f.draft.units[0].shots[0].dialogueParts[0].presentation='VO';
 assert.ok(quality.validateDraft({...f,generationTextVersion:version}).errors.some(e=>e.code==='CHANNEL'));
});
