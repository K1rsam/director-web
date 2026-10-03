import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVisualStyle} from './visual-style.mjs';

test('style defaults match the guoman preset, and caller data is not changed',()=>{
 const project={style:'3D国漫',aspectRatio:'16:9'},before=structuredClone(project);
 assert.equal(buildVisualStyle(),buildVisualStyle(project));
 assert.deepEqual(project,before);
 assert.equal(buildVisualStyle({style:'  ',aspectRatio:' '}),buildVisualStyle());
});
test('detailed custom directions and non-landscape aspect ratios are preserved without a preset override',()=>{
 const style='黑白木刻风，粗黑线与纸纹，无彩色光晕';
 for(const aspectRatio of ['9:16','4:3','3:4','1:1']){
  const result=buildVisualStyle({style,aspectRatio});
  assert.ok(result.includes(style));assert.ok(result.includes(`画幅${aspectRatio}`));
  assert.doesNotMatch(result,/C4D|Octane|PBR|三渲二|16:9/);
 }
});
test('all supported project families retain source-audio and continuity requirements without a face or fantasy quota',()=>{
 for(const style of ['3D国漫','2D动漫','真人电影写实','古装电影写实','赛博科幻','其他风格']){
  const result=buildVisualStyle({style});
  assert.ok(result.includes(style));assert.match(result,/OS\/VO\/系统音/);
  assert.match(result,/必要屏幕信息保留/);assert.match(result,/身份/);
  assert.doesNotMatch(result,/40[%％]|不变Q版|最多.{0,4}张|每镜.{0,3}必须运动/);
 }
});
test('each style uses concrete visual language without unused carriers or policy examples',()=>{
 for(const style of ['3D国漫','3D三渲二国漫','2D动漫','真人电影写实','古装电影写实','赛博科幻']){
  const result=buildVisualStyle({style});
  assert.doesNotMatch(result,/Q版|二维载体|超常五官|不无故|不擅定|不让泛光|不把全员|不以全场变暗|未指定|源剧情|源明确|下文为准|后期添加/);
 }
});
