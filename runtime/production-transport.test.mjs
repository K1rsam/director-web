import test from 'node:test';
import assert from 'node:assert/strict';
import {projectProductionTransport} from './production-transport.mjs';

test('actual sent production material deduplicates exact text, with an independent lossless decoder',()=>{
 const lines=['甲推门，仔细观察屋内的窗、门、通路，逐一确认。'.repeat(12),'乙：'+('你还记得我说过的事吗？'.repeat(16))];
 const raw={source:{sourceRows:lines.map((text,i)=>({id:'s'+i,text})),contextRows:[{id:'prev',text:'此前的完整动作。'.repeat(80)}]},
  episodeBoundary:{seed:{previousSource:{text:'此前的完整动作。'.repeat(80)},currentOpening:{text:lines.join('\n')}},actual:{unit:{exitState:'实际尾稿不改。'}}},
  productionMaterials:[{id:'asset:CH01',value:{sourceFacts:[{quote:lines[0]}],unknownExtension:{quote:lines[0]}}}]};
 const original=structuredClone(raw),out=projectProductionTransport(raw);
 const get=p=>p.slice(2).split('/').reduce((v,k)=>v[k],out.input);
 const expand=v=>!v||typeof v!=='object'?v:v.$same?get(v.$same):v.$joinRows?out.input.source[v.$joinRows[0]].slice(v.$joinRows[1],v.$joinRows[2]+1).map(r=>r.text).join(v.$joinRows[3]):Array.isArray(v)?v.map(expand):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,expand(x)]));
 assert.deepEqual(expand(out.input),original);assert.deepEqual(raw,original);
 assert.ok(out.hint);assert.ok(JSON.stringify(out.input).length+out.hint.length<JSON.stringify(original).length);
 assert.deepEqual(out.input.episodeBoundary.actual,raw.episodeBoundary.actual);
 assert.deepEqual(out.input.productionMaterials[0].value.unknownExtension,raw.productionMaterials[0].value.unknownExtension);
});
test('non-identical lines, notation-like source text, and unknown shapes are not guessed or truncated',()=>{
 const raw={source:{sourceRows:[{id:'s1',text:'甲：原话。'}],contextRows:[]},episodeBoundary:{seed:{currentOpening:{text:'甲： 原话。\r\n另有一句。'}}},productionMaterials:[]};
 assert.deepEqual(projectProductionTransport(raw),{input:raw,hint:''});
 assert.deepEqual(projectProductionTransport({...raw,source:null}),{input:{...raw,source:null},hint:''});
 const marked={...raw,unknown:{literal:{$same:'#/not-notation'}},episodeBoundary:{seed:{currentOpening:{text:'甲：原话。'}}}};
 assert.deepEqual(projectProductionTransport(marked),{input:marked,hint:''});
});
