// Run with: node --import tsx --test scripts/verify-foundation-registry-read.mjs
// Execute the actual private function; do not add a test-only production export.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {foundationJson} from '../lib/foundation-state.ts';
import {isRecord} from '../lib/project-foundation-contracts.ts';
const file=new URL('../lib/foundation-delivery.ts',import.meta.url);
const text=await readFile(file,'utf8'),tree=ts.createSourceFile(file.pathname,text,ts.ScriptTarget.Latest,true);
const declaration=tree.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='currentRegistryComplete');
assert.ok(declaration,'test must execute the actual currentRegistryComplete function');
const code=ts.transpileModule(declaration.getText(tree)+';module.exports=currentRegistryComplete;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
let parses=0;
const module={exports:null};runInNewContext(code,{module,foundationJson(value){parses++;return foundationJson(value);},isRecord});
const check=module.exports;
const doc=()=>({revision:'r1',sourceVersion:'source1',sourceContextVersion:'context1',f2:{assets:Array.from({length:40},(_,i)=>({key:'K'+i,variants:[]}))}});
const rows=d=>d.f2.assets.flatMap((a,i)=>[{id:'a'+i,parentId:null,metadata:JSON.stringify({foundationKey:a.key,foundationCurrent:true,foundation:{documentRevision:d.revision,sourceVersion:d.sourceVersion,sourceContextVersion:d.sourceContextVersion}})},...a.variants.map((v,j)=>({id:'a'+i+'v'+j,parentId:'a'+i,metadata:JSON.stringify({foundationVariantKey:v.key,foundationParentKey:a.key,foundationCurrent:true,foundation:{documentRevision:d.revision,sourceVersion:d.sourceVersion,sourceContextVersion:d.sourceContextVersion}})}))]);
const edit=(row,patch)=>{row.metadata=JSON.stringify({...JSON.parse(row.metadata),...patch});};
test('one fresh registry read parses each asset metadata at most once',()=>{
 const d=doc(),r=rows(d),before=JSON.stringify([d,r]);parses=0;
 assert.equal(check(d,r),true);assert.equal(parses,r.length,'quadratic repeated JSON parsing must not return');assert.equal(JSON.stringify([d,r]),before);
});
test('base and variant must preserve strict parent identity',()=>{
 const d=doc();d.f2.assets[0].variants=[{key:'V0'}];const r=rows(d);
 assert.equal(check(d,r),true);r[1].parentId='other';assert.equal(check(d,r),false);
});
for(const field of ['documentRevision','sourceVersion','sourceContextVersion'])test('stale '+field+' remains closed',()=>{
 const d=doc(),r=rows(d),m=JSON.parse(r[0].metadata);m.foundation[field]='stale';r[0].metadata=JSON.stringify(m);assert.equal(check(d,r),false);
});
test('duplicate identity remains closed even if one row is current',()=>{
 const d=doc(),r=rows(d);r.push({...r[0],id:'duplicate'});assert.equal(check(d,r),false);
});
test('a row claiming both base and variant never passes',()=>{
 const d=doc(),r=rows(d);edit(r[0],{foundationVariantKey:'K0'});assert.equal(check(d,r),false);
});
test('malformed or null metadata remains closed',()=>{
 for(const value of ['{bad','null','[]',null]){const d=doc(),r=rows(d);r[0].metadata=value;assert.equal(check(d,r),false);}
});
test('missing registry row and not-current row remain closed',()=>{
 const d=doc(),r=rows(d);assert.equal(check(d,r.slice(1)),false);edit(r[0],{foundationCurrent:false});assert.equal(check(d,r),false);
});
test('metadata changes are visible on the next read, no settled cache',()=>{
 const d=doc(),r=rows(d);assert.equal(check(d,r),true);edit(r[0],{foundationCurrent:false});assert.equal(check(d,r),false);edit(r[0],{foundationCurrent:true});assert.equal(check(d,r),true);
});
test('missing catalogue performs no speculative metadata parse',()=>{
 parses=0;assert.equal(check({f2:null},[{metadata:'{bad'}]),false);assert.equal(parses,0);
});
test('unrelated rows do not become dependencies or mutate input',()=>{
 const d=doc(),r=rows(d);r.push({id:'unrelated',parentId:null,metadata:'{bad'});const before=JSON.stringify(r);assert.equal(check(d,r),true);assert.equal(JSON.stringify(r),before);
});
test('duplicate variant remains closed',()=>{
 const d=doc();d.f2.assets[0].variants=[{key:'V0'}];const r=rows(d);assert.equal(check(d,r),true);
 r.push({...r[1],id:'duplicate-variant'});assert.equal(check(d,r),false);
});
test('wrong declared variant parent remains closed',()=>{
 const d=doc();d.f2.assets[0].variants=[{key:'V0'}];const r=rows(d);edit(r[1],{foundationParentKey:'other'});assert.equal(check(d,r),false);
});
test('empty catalogue retains its prior every semantics',()=>{
 const d=doc(),r=rows(d);d.f2.assets=[];const before=JSON.stringify([d,r]);assert.equal(check(d,r),true);assert.equal(JSON.stringify([d,r]),before);
});
