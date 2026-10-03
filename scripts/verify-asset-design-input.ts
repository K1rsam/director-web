import assert from 'node:assert/strict';
import {validatePromptOutput} from '../lib/asset-prompt-contract';
import {projectAssetDesignFacts} from '../lib/asset-design-model-input';
import type {VisualFact} from '../lib/asset-visual-facts-contract';

assert.deepEqual(validatePromptOutput({key:'a',body:'黑发，灰色外套',suggestions:'鞋款为设计补足'},'a'),{body:'黑发，灰色外套',facts:'',suggestions:'鞋款为设计补足'},'new design output must not require the source-facts field that the program fills');
assert.deepEqual(validatePromptOutput({key:'a',body:'黑发',facts:'旧响应仍可读取',suggestions:''},'a'),{body:'黑发',facts:'旧响应仍可读取',suggestions:''});
assert.throws(()=>validatePromptOutput({key:'a',body:'黑发',facts:3,suggestions:''},'a'));
assert.throws(()=>validatePromptOutput({key:'b',body:'黑发',suggestions:''},'a'));
console.log('PASS design output no longer pays for a required facts echo; old responses and validation remain compatible');

const quote='甲的黑发、灰衣与银色袖扣均是明确原文。'.repeat(30);
const facts:VisualFact[]=['hair','coat','cuff'].map((attribute,i)=>({id:String(i).repeat(64),subjectKey:'a',attribute,value:attribute,scope:'STABLE',quote,chunkId:'chunk',startLine:1,endLine:1}));
const before=JSON.stringify(facts);
const projected=process.argv.includes('--legacy')?{lockedFacts:facts}:projectAssetDesignFacts(facts);
assert.equal(JSON.stringify(projected).split(quote).length-1,1,'the same source quote must be transmitted once, not repeated for each attribute');
assert(projected.lockedFacts.length===3);
assert(JSON.stringify(projected).length<JSON.stringify({lockedFacts:facts}).length);
assert.equal(JSON.stringify(facts),before,'canonical stored evidence is not edited');
if('evidence' in projected){
  for(const fact of projected.lockedFacts){assert(projected.evidence!.some(e=>e.id===('evidenceId' in fact?fact.evidenceId:undefined)));}
}
console.log('PASS repeated quote projected once while all attributes and canonical evidence remain');
