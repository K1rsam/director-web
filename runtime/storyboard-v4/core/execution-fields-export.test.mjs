import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDraft,renderDraft} from './quality.mjs';
import {captureRules} from './core.mjs';
import {SEEDANCE_EXPORT_VERSION,SUPPORTED_SEEDANCE_EXPORT_VERSIONS} from './visual-style.mjs';

const version='seedance-execution-v4';
function fixture(){
 const source={key:'execution-fields',sourceRows:[{id:'r1',kind:'action',text:'乙将钥匙交给甲。'},{id:'r2',kind:'action',text:'甲举起钥匙。'}],contextRows:[],dialogue:[],entryFacts:[]};
 const settings={maxUnitSeconds:30,fantasyMode:'off',visualStyle:'水墨国漫，9:16；无配乐、无水印。'};
 const intent={subject:'甲与乙',change:'交接到决定',landing:'握牢钥匙',retain:['交接先后不变']};
 const unit=(id,n)=>({id,eventId:'e1',boundaryBefore:{kind:n?'continuous':'episode_start',reason:'同场交接'},title:n?'举起':'接住',unitDirection:n?'甲迎光举起钥匙，视线随金属亮点抬高。':'先看乙松指，再顺着钥匙下落读清甲的右手握紧。',intent,
  scene:'日 内 门厅',props:['钥匙'],participants:['甲','乙'],lighting:n?'暖反光落在钥匙边缘。':'窗边冷光。',initialState:n?'甲右手握牢钥匙，乙已松手。':'乙右手持钥匙，甲摊开右掌。',exitState:n?'甲把钥匙举到眼前，乙停在门边。':'甲右手握牢钥匙，乙已松手。',
  shots:[{id:'s'+n,duration:3,camera:n?'沿手臂上移':'侧面近景',picture:n?'甲抬起金属环，双眼追随亮点。':'乙松指后，甲五指收住金属环。',lighting:n?'金属边缘暖亮':'窗边冷光照清手指',sound:'轻微金属碰响',dialogueParts:[],transition:n?'视线落定':'跟随手臂',sourceRefs:['r'+(n+1)],contextRefs:[]}]});
 const draft={units:[unit('u1',0),unit('u2',1)],fantasyRealization:[],revisionNotes:[{change:'内部审核记录，不进入执行文本'}],unresolved:[]};
 const plan={unitPackingPolicy:'event-first-v1',events:[{id:'e1',sourceRefs:['r1','r2']}],workPackages:[{id:'p1',sourceRefs:['r1','r2']} ]};
 return {source,settings,draft,plan};
}
const render=f=>renderDraft({...f,seedanceExportVersion:version});

test('new execution export freezes v4 while all historical versions remain readable',()=>{
 assert.equal(SEEDANCE_EXPORT_VERSION,version);assert.equal(captureRules().seedanceExportVersion,version);
 assert.deepEqual(SUPPORTED_SEEDANCE_EXPORT_VERSIONS,['seedance-execution-v1','seedance-execution-v2','seedance-execution-v3',version]);
});

test('standalone units retain their own full exit, adopted style and performance without leaking internal notes',()=>{
 const f=fixture(),before=structuredClone(f),text=render(f);
 for(const u of f.draft.units){assert.ok(text.includes('[结束状态] '+u.exitState));assert.ok(text.includes(u.unitDirection));}
 assert.equal(text.split(f.settings.visualStyle).length-1,2);
 assert.doesNotMatch(text,/内部审核记录|sourceRefs|seedance-execution|fantasyMode/);
 assert.equal((text.match(/^分镜1｜0-3s｜3s$/gm)||[]).length,2);
 assert.deepEqual(f,before);
});

test('real event packing exports every segment title, direction, entry and exit at its own shot boundary',()=>{
 const f=fixture(),original=structuredClone(f),packed=normalizeDraft(f.draft,f.source,{plan:f.plan,settings:f.settings,unitPackingPolicy:'event-first-v1'}).draft;
 assert.equal(packed.units.length,1);assert.equal(packed.units[0].segments.length,2);
 const text=render({...f,draft:packed}),first=text.indexOf('分镜1｜'),second=text.indexOf('分镜2｜');
 for(const [i,segment]of packed.units[0].segments.entries()){
  assert.ok(text.includes(`[分段标题｜分镜${i+1}—${i+1}] ${segment.title}`));
  assert.ok(text.includes(`[分段演出｜分镜${i+1}—${i+1}] ${segment.unitDirection}`));
  const end=text.indexOf(`[分段结束状态｜分镜${i+1}—${i+1}] ${segment.exitState}`);
  assert.ok(end>(i?second:first));if(!i)assert.ok(end<second);
 }
 assert.ok(text.includes('[单元光影] '));assert.ok(text.includes('[单元起始状态] '));
 assert.ok(text.endsWith('[结束状态] '+packed.units[0].exitState+'\n'));
 assert.deepEqual(f,original);
});

test('frozen v3 keeps its exact old standalone bytes and does not silently acquire v4 fields',()=>{
 const f=fixture();f.draft.units=f.draft.units.slice(0,1);
 const text=renderDraft({...f,seedanceExportVersion:'seedance-execution-v3'});
 assert.equal(text,`# 接住｜3s\n[通用提示词] 水墨国漫，9:16；无配乐、无水印。\n先看乙松指，再顺着钥匙下落读清甲的右手握紧。\n[场景] 日 内 门厅\n[本单元道具] 钥匙\n[本单元出场人物] 甲、乙\n[本单元光影] 窗边冷光。\n[人物状态与站位前提] 乙右手持钥匙，甲摊开右掌。\n分镜1｜0-3s｜3s\n机位/运镜：侧面近景\n画面：乙松指后，甲五指收住金属环。\n光影：窗边冷光照清手指\n声音：轻微金属碰响\n台词：无\n转场：跟随手臂\n`);
 assert.doesNotMatch(text,/\[结束状态\]|\[分段标题/);
});

test('v4 preserves the existing v3 sound windows and quote handling without changing the draft',()=>{
 const f=fixture();f.draft.units=f.draft.units.slice(0,1);f.source.dialogue=[{id:'q',speaker:'甲',quote:'“别动。”',channel:'OS',kind:'speech'}];
 f.draft.units[0].shots[0].dialogueParts=[{lineId:'q',text:'“别动。”',presentation:'OS',delivery:'压住气息',voiceStart:0.25,voiceEnd:1.75}];
 const before=structuredClone(f),old=renderDraft({...f,seedanceExportVersion:'seedance-execution-v3'}),next=render(f);
 assert.deepEqual(next.split('\n').filter(s=>s.startsWith('台词：')),old.split('\n').filter(s=>s.startsWith('台词：')));
 assert.deepEqual(f,before);
});
