import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getRefinementBase,getRefinementComparison} from './refinement-comparison.mjs';
import {refinementAssemblyHash} from './director-refinement.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const fixture=()=>{
 const draft={units:[{id:'u1',title:'迟疑',shots:[{id:'s1',picture:'甲抬眼。',duration:2}]}],fantasyRealization:[]};
 const d={assembly:{text:'00:01.0 甲：我……愿意。\n',draft,validation:{errors:[]}},adopted:[{candidateId:'base'}],operations:[],candidates:[]};
 const h=refinementAssemblyHash(d),candidate={id:'candidate',attemptId:'attempt',purpose:'director_refinement',status:'refinement_ready',previewText:d.assembly.text,draft:structuredClone(draft),refinement:{baseAssemblyHash:h}};
 d.operations.push({attemptId:'attempt',purpose:'director_refinement',refinement:{baseAssemblyHash:h}});d.candidates.push(candidate);
 return {d,candidate};
};
test('identical full text is unchanged with exact UTF-8 hashes and no claimed coordinates',()=>{
 const {d,candidate}=fixture();candidate.draft.units[0].title='只改未导出的元数据';
 assert.deepEqual(getRefinementComparison(d,candidate),{status:'unchanged',baseTextHash:hash(d.assembly.text),candidateTextHash:hash(candidate.previewText),changedUnitIds:[],changedShotIds:[]});
});
test('punctuation, timecodes and whitespace are compared without normalization',()=>{
 for(const transform of [s=>s.replace('……','…'),s=>s.replace('00:01.0','00:01.1'),s=>' '+s,s=>s.replace('\n','\r\n')]){
  const {d,candidate}=fixture();candidate.previewText=transform(candidate.previewText);
  const result=getRefinementComparison(d,candidate);
  assert.equal(result.status,'changed');assert.equal(result.baseTextHash,hash(d.assembly.text));assert.equal(result.candidateTextHash,hash(candidate.previewText));
  assert.notEqual(result.baseTextHash,result.candidateTextHash);assert.deepEqual(result.changedUnitIds,[]);assert.deepEqual(result.changedShotIds,[]);
 }
});
test('changed draft objects report known unit and shot coordinates',()=>{
 const {d,candidate}=fixture();candidate.previewText='00:01.1 甲：我……愿意。\n';candidate.draft.units[0].shots[0].duration=3;
 candidate.draft.units.push({id:'u2',shots:[{id:'s2',picture:'甲落定。',duration:1}]});
 const result=getRefinementComparison(d,candidate);
 assert.deepEqual(result.changedUnitIds,['u1','u2']);assert.deepEqual(result.changedShotIds,['s1','s2']);
});
test('missing or ambiguous draft coordinates are never guessed from text',()=>{
 const {d,candidate}=fixture();candidate.previewText+='甲落定。';delete candidate.draft;
 assert.deepEqual(getRefinementComparison(d,candidate).changedUnitIds,[]);assert.deepEqual(getRefinementComparison(d,candidate).changedShotIds,[]);
 candidate.draft={units:[{id:'u1',shots:[{id:'s1'}]},{id:'u1',shots:[{id:'s1'}]}]};
 assert.deepEqual(getRefinementComparison(d,candidate).changedUnitIds,[]);assert.deepEqual(getRefinementComparison(d,candidate).changedShotIds,[]);
});
test('adoption keeps comparison bound to the exact archived original',()=>{
 const {d,candidate}=fixture(),base=structuredClone(d.assembly);
 d.refinementArchives=[{candidateId:candidate.id,baseAssemblyHash:candidate.refinement.baseAssemblyHash,assembly:base,adopted:structuredClone(d.adopted)}];
 d.assembly={...d.assembly,text:'当前已采用稿'};d.adopted=[{candidateId:candidate.id}];candidate.status='adopted';
 assert.equal(getRefinementBase(d,candidate),base);assert.equal(getRefinementComparison(d,candidate).status,'unchanged');
});
test('stale or mismatched bindings fail closed instead of comparing unrelated drafts',()=>{
 const {d,candidate}=fixture();d.assembly.text='另一个基稿';
 assert.equal(getRefinementBase(d,candidate),null);
 assert.deepEqual(getRefinementComparison(d,candidate),{status:'unavailable',baseTextHash:null,candidateTextHash:hash(candidate.previewText),changedUnitIds:[],changedShotIds:[]});
 d.refinementArchives=[{candidateId:'other',baseAssemblyHash:candidate.refinement.baseAssemblyHash,assembly:structuredClone(d.assembly),adopted:structuredClone(d.adopted)}];
 assert.equal(getRefinementComparison(d,candidate).status,'unavailable');
});
test('an archive label cannot make modified archive bytes a valid baseline',()=>{
 const {d,candidate}=fixture();d.refinementArchives=[{candidateId:candidate.id,baseAssemblyHash:candidate.refinement.baseAssemblyHash,assembly:structuredClone(d.assembly),adopted:structuredClone(d.adopted)}];
 d.refinementArchives[0].assembly.text='被改写的归档';
 assert.equal(getRefinementComparison(d,candidate).status,'unavailable');
});
