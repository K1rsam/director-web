import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource,normalize,validatePlan} from './fidelity.mjs';

test('explicit numbered scene metadata accepts comma/full-width separators without changing source coordinates',()=>{
 for(const heading of ['1.1 日，内，道观','1．1　日，内，道观','1. 1 日,内,道观','1-1 道观，日，内','1.1 日、内、道观','1.1 日／内／道观','场1-1 日，内，道观']){
  const text=`第一集\r\n${heading}\r\n甲：逐字保留 é😀。  \r\n`,source=createSource(text),result=normalize(source);
  assert.equal(result.episodes[0].scenes.length,1,heading);assert.equal(result.validation.issues.length,0,heading);
  assert.equal(result.episodes[0].scenes[0].start,text.indexOf(heading));
  assert.equal(result.episodes[0].scenes[0].sourceNumber,heading);assert.equal(result.source.sourceVersion,source.sourceVersion);
  assert.equal(result.segments.map(s=>s.text).join(''),text);
  for(const segment of result.segments)assert.equal(segment.text,text.slice(segment.start,segment.end));
 }
});
test('separate and combined explicit headers share metadata rules but preserve complete source lines',()=>{
 for(const text of ['第1集\n1-1\n\n日，内，道观\n甲：原话。\n','第1集 起行 场1-1 日，内，道观\n甲：原话。\n']){
  const result=normalize(text);assert.equal(result.episodes[0].scenes.length,1);assert.equal(result.validation.issues.length,0);
  assert.equal(result.segments.map(s=>s.text).join(''),text);
 }
 const mismatch=normalize('第一集\n场2-1 日，内，道观\n甲：仍待归场。\n');
 assert.equal(mismatch.episodes[0].scenes.length,0);assert(mismatch.validation.issues.some(i=>i.code==='SCENE_EPISODE_MISMATCH'));
});
test('comma transport does not turn dialogue, annotations, decimal prices or missing headers into scenes',()=>{
 for(const line of ['甲：1.1 日，内，道观','△甲念出1.1 日，内，道观','1.1 注：日，内，道观','1.1 甲：日，内，道观','1.1 “日，内，道观”','1.1 日，内，道观。','1.5万元，日，内，道观','1.1 日，增长','1.1 内，道观','1.1','没有场头的原话']){
  const text=`第一集\n${line}\n甲：继续。\n`,result=normalize(text);
  assert.equal(result.episodes[0].scenes.length,0,line);assert(result.validation.issues.length>0,line);
  assert.equal(result.segments.map(s=>s.text).join(''),text);
 }
});
test('comma recognition leaves repeated real source episode declarations distinct and rejects stale source plans',()=>{
 const source=createSource('第16集\n16.1 夜，内，医院走廊\n甲：原话。\n第16集\n16.1 日，外，医院\n乙：后文。\n'),result=normalize(source);
 assert.equal(result.episodes.length,2);assert.deepEqual(result.episodes.map(e=>e.sourceNumber),['16','16']);
 assert.notEqual(result.episodes[0].id,result.episodes[1].id);assert.deepEqual(result.episodes.map(e=>e.scenes.length),[1,1]);
 assert(result.validation.issues.some(i=>i.code==='DUPLICATE_EPISODE_NUMBER'));
 assert.equal(validatePlan(createSource(source.text+'尾'),result.plan).ok,false);
});
test('same-episode metadata-only header without a scene number gets an internal index, never an invented source number',()=>{
 for(const heading of ['21 夜，内，奔驰大G车内','21　日,外,医院','21，内，夜，房间']){
  const text=`第21集\r\n${heading}\r\n甲：原话。\r\n`,result=normalize(text),scene=result.episodes[0].scenes[0];
  assert.ok(scene,heading);assert.equal(scene.number,1);assert.equal(scene.sourceNumber,heading);
  assert.equal(scene.start,text.indexOf(heading));assert.equal(result.validation.issues.length,0);assert.equal(result.segments.map(s=>s.text).join(''),text);
 }
 for(const line of ['22 夜，内，奔驰大G车内','21 夜，内','21 夜，奔驰大G车内','21 内，奔驰大G车内','21万元，夜，内，车内','21 元，夜，内，车内','21 备注，夜，内，车内','甲：21 夜，内，车内','21 夜，内，甲：上车。','21 夜，内，车内。']){
  const result=normalize(`第21集\n${line}\n甲：原话。\n`);assert.equal(result.episodes[0].scenes.length,0,line);assert(result.validation.issues.length>0);
 }
 assert.equal(normalize('21 夜，内，车内\n甲：原话。\n').episodes.length,0,'无本集锚点不得凭数字行伪建集场');
});
