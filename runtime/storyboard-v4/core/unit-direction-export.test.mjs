import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDraft,validateDraft,renderDraft} from './quality.mjs';
import {applyDelta,baseDraftHash,DELTA_VERSION} from './delta.mjs';
import {VERSION} from './shared.mjs';
import {UNIT_PACKING_POLICY} from './event-unit-packing.mjs';
import {buildOutputSchema} from './output-schema.mjs';

const directionVersion='unit-direction-v1';
const comic='克制喜感：笑先藏在嘴角，肩背轻颤后收住；固定中近景留出停顿，衣袖随掸灰动作回落，不额外加入幻想。';
const tense='紧张压迫：乙的视线先钉住手，甲的呼吸与指尖随短促喝止停住；用前景遮挡收窄空间，保留未落下的手势。';
const source={key:'direction',sourceRows:[{id:'r1',kind:'action',text:'甲低头掸灰，忍住笑。'},{id:'r2',kind:'dialogue',text:'乙：别动。'},{id:'r3',kind:'action',text:'甲的手停在半空。'}],contextRows:[],dialogue:[{id:'q1',speaker:'乙',quote:'别动。',channel:'现场对白',kind:'speech'}],entryFacts:[]};
const settings={visualStyle:'三渲二，赛璐璐明暗色块，16:9；衣发道具保持连续。',fantasyMode:'off',maxUnitSeconds:30};
const shot=(id,ref,picture,dialogueParts=[])=>({id,duration:3,camera:'侧面固定中近景。',picture,lighting:'窗边柔光照清手势。',sound:'衣料声与室内底噪。',dialogueParts,transition:'以视线承接下一镜。',sourceRefs:[ref],contextRefs:[]});
const unit=(id,unitDirection,shots,first=false)=>({id,eventId:'e1',boundaryBefore:{kind:first?'episode_start':'continuous',reason:first?'本事件开始':'同场动作连续'},title:first?'闷笑':'停手',unitDirection,intent:{subject:'甲',change:first?'发笑到收住':'松弛到警觉',landing:first?'忍住笑':'手势悬停',retain:['完整动作与对白']},scene:'内 陋室 日',props:['灰袖','木椅'],participants:['甲','乙'],lighting:first?'窗光柔和，眼神清楚。':'窗光不变，前景加深压迫。',initialState:first?'甲垂手，乙在门旁。':'甲抬手，乙盯住指尖。',exitState:first?'甲手背抬至腰间。':'甲的手停在半空。',shots});
function fixture(){return {schemaVersion:VERSION,units:[unit('u1',comic,[shot('s1','r1','甲掸去灰尘。'),shot('s2','r1','甲嘴角将起，肩背随即收住。')],true),unit('u2',tense,[shot('s3','r2','乙目光钉住甲的手。',[{lineId:'q1',text:'别动。',presentation:'画内',delivery:'短促而压低',voiceStart:0.5,voiceEnd:1.5}]),shot('s4','r3','甲屏住呼吸，手停在半空。')])],fantasyRealization:[]};}
const plan={unitPackingPolicy:UNIT_PACKING_POLICY,events:[{id:'e1',sourceRefs:['r1','r2','r3']}],fantasyCandidates:[]};
const packing={plan,settings,unitPackingPolicy:UNIT_PACKING_POLICY};
const validate=(draft,unitDirectionVersion)=>validateDraft({draft,source,settings,plan,selection:{selectedIds:[]},unitDirectionVersion});
const body=text=>text.replace(/\[通用提示词\][\s\S]*?(?=\n\[场景\])/g,'[通用提示词]');

test('old drafts without unitDirection keep their exact rendered bytes',()=>{
 const old={schemaVersion:VERSION,units:[{id:'old',title:'旧稿',scene:'室内，日',props:['钥匙'],participants:['甲'],lighting:'窗光',initialState:'甲在门边。',shots:[{id:'old-shot',duration:4,camera:'固定近景',picture:'甲握住钥匙。',lighting:'窗光照亮指尖',sound:'轻微金属声',dialogueParts:[{lineId:'q1',text:'别动。',presentation:'画外',delivery:'平静',voiceStart:1,voiceEnd:2}],transition:'停住'}]}],fantasyRealization:[]};
 const expected='# 旧稿｜4s\n[通用提示词] 旧风格；本单元不加入额外幻想段落，源剧情的法术与特效照常表现。\n[场景] 室内，日\n[本单元道具] 钥匙\n[本单元出场人物] 甲\n[本单元光影] 窗光\n[人物状态与站位前提] 甲在门边。\n分镜1｜0-4s｜4s\n机位/运镜：固定近景\n画面：甲握住钥匙。\n光影：窗光照亮指尖\n声音：轻微金属声\n台词：乙，画外，本镜1-2s，演法：平静：“别动。”\n转场：停住\n';
 assert.equal(renderDraft({draft:old,source,settings:{visualStyle:'旧风格',fantasyMode:'off'}}),expected);
 assert.equal(renderDraft({draft:old,source,settings:{visualStyle:'旧风格',fantasyMode:'recommended',fantasyEnabled:true}}),expected.replace('本单元不加入额外幻想段落，源剧情的法术与特效照常表现。','已选幻想只按本单元画面正文呈现。'));
});

test('each unit exports its own performance direction plus project style without changing the execution body',()=>{
 const draft=fixture(),before=structuredClone(draft),sourceBefore=structuredClone(source),old=structuredClone(draft);for(const u of old.units)delete u.unitDirection;
 const text=renderDraft({draft,source,settings}),sections=text.split('\n\n---\n\n');
 for(const [i,direction] of [comic,tense].entries()){
  const common=sections[i].slice(0,sections[i].indexOf('\n[场景]'));
  assert.ok(common.includes(settings.visualStyle));assert.ok(common.includes(direction));assert.ok(!common.includes(i?comic:tense));
  assert.ok(common.includes(`[通用提示词] ${settings.visualStyle}\n`));assert.doesNotMatch(common,/。；/);
 }
 assert.equal(body(text),body(renderDraft({draft:old,source,settings})));
 for(const header of ['[场景]','[本单元道具]','[本单元出场人物]','[本单元光影]','[人物状态与站位前提]'])assert.equal(text.split(header).length-1,2);
 for(const column of ['机位/运镜：','画面：','光影：','声音：','台词：','转场：'])assert.equal(text.split(column).length-1,4);
 assert.ok(text.includes('本镜0.5-1.5s，演法：短促而压低：“别动。”'));
 assert.deepEqual(draft,before);assert.deepEqual(source,sourceBefore);
});

test('new fantasy guidance preserves source Q-form, dreams and shared magic even when extra fantasy is off',()=>{
 const draft=fixture();draft.units[0].unitDirection='源文中的共享幻术由甲乙共同看到；Q版形态只在正文标明的梦境边界内伸缩，醒后回到原定姿态。';
 const text=renderDraft({draft,source,settings});
 assert.match(text,/本单元不加入额外幻想段落/);assert.match(text,/源剧情明确的Q版、梦境、法术与特效照常表现/);
 assert.match(text,/主观形变.*正文声明的主观边界/);assert.match(text,/角色知情范围.*原文/);
 assert.doesNotMatch(text,/不Q|禁止Q|所有幻想.*主角|仅主角心理|所有人不可知/);assert.ok(text.includes(draft.units[0].unitDirection));
});

test('new fantasy guidance remains specific to units with a realized selection',()=>{
 const draft=fixture();draft.fantasyRealization=[{candidateId:'f1',unitIds:['u1'],status:'realized'}];
 const [first,second]=renderDraft({draft,source,settings:{...settings,fantasyMode:'recommended'}}).split('\n\n---\n\n');
 assert.match(first,/已选幻想只按本单元画面正文呈现/);assert.doesNotMatch(first,/不加入额外幻想段落/);
 assert.match(second,/不加入额外幻想段落/);assert.doesNotMatch(second,/已选幻想只按/);
});

test('event packing scopes distinct directions to visible shot ranges without adding cuts or changing time',()=>{
 const raw=fixture(),before=structuredClone(raw),sourceBefore=structuredClone(source),{draft}=normalizeDraft(raw,source,packing),merged=draft.units[0];
 assert.equal(draft.units.length,1);assert.equal(merged.unitDirection,`【s1—s2】${comic}\n【s3—s4】${tense}`);
 assert.deepEqual(merged.segments.map(s=>s.unitDirection),[comic,tense]);assert.deepEqual(merged.shots,before.units.flatMap(u=>u.shots));
 assert.equal(merged.shots.reduce((sum,s)=>sum+s.duration,0),12);
 const text=renderDraft({draft,source,settings});assert.ok(text.includes(`【分镜1—分镜2】${comic}`));assert.ok(text.includes(`【分镜3—分镜4】${tense}`));assert.doesNotMatch(text,/【s[1-4]/);
 assert.equal((text.match(/^分镜\d+｜/gm)||[]).length,4);assert.match(text,/\[光影承接｜分镜3—4\]/);assert.match(text,/\[人物状态｜分镜3起\] 甲抬手，乙盯住指尖。/);
 const old=structuredClone(draft);delete old.units[0].unitDirection;assert.equal(body(text),body(renderDraft({draft:old,source,settings})));
 assert.deepEqual(raw,before);assert.deepEqual(source,sourceBefore);assert.deepEqual(validate(draft,directionVersion).errors,[]);
});

test('subsequent packing retains all original scoped directions including a return to an earlier tone',()=>{
 const first=normalizeDraft(fixture(),source,packing).draft;
 first.units.push(unit('u3',comic,[shot('s5','r3','甲缓慢放下手。'),shot('s6','r3','甲重新忍住笑。')]));
 const {draft}=normalizeDraft(first,source,packing),merged=draft.units[0];
 assert.equal(draft.units.length,1);assert.deepEqual(merged.segments.map(s=>s.unitDirection),[comic,tense,comic]);
 assert.equal(merged.unitDirection,`【s1—s2】${comic}\n【s3—s4】${tense}\n【s5—s6】${comic}`);
 assert.match(renderDraft({draft,source,settings}),/【分镜5—分镜6】克制喜感/);
 assert.deepEqual(normalizeDraft(draft,source,packing).draft,draft);
});

test('identical directions may display once while raw segment directions remain intact',()=>{
 const raw=fixture();raw.units[1].unitDirection=comic;const {draft}=normalizeDraft(raw,source,packing);
 assert.equal(draft.units[0].unitDirection,comic);assert.deepEqual(draft.units[0].segments.map(s=>s.unitDirection),[comic,comic]);
 assert.equal(renderDraft({draft,source,settings}).split(comic).length-1,1);
});

test('old protocol packing preserves a later existing direction without applying it to earlier shots',()=>{
 const raw=fixture();delete raw.units[0].unitDirection;const {draft}=normalizeDraft(raw,source,packing);
 assert.equal(draft.units[0].unitDirection,`【s3—s4】${tense}`);assert.equal(draft.units[0].segments[0].unitDirection,undefined);assert.equal(draft.units[0].segments[1].unitDirection,tense);
 assert.deepEqual(validate(draft).errors,[]);
 const old=fixture();for(const u of old.units)delete u.unitDirection;
 assert.equal(Object.hasOwn(normalizeDraft(old,source,packing).draft.units[0],'unitDirection'),false);
});

test('only the new rule requires every unit direction, with no length or effect quota',()=>{
 for(const value of [undefined,'','  ',null,42,{}]){
  const draft=fixture();if(value===undefined)delete draft.units[1].unitDirection;else draft.units[1].unitDirection=value;
  assert.deepEqual(validate(draft).errors,[]);
  assert.ok(validate(draft,directionVersion).errors.some(e=>e.code==='UNIT_DIRECTION'&&e.coordinate==='u2'),String(value));
 }
 const draft=fixture();draft.units[0].unitDirection='静';draft.units[1].unitDirection='按正常比例表演，以完整动作起落和呼吸变化承载紧张，不加入任何幻想。';
 assert.deepEqual(validate(draft,directionVersion).errors,[]);
});

test('a merged header cannot hide a missing original segment direction under the new rule',()=>{
 const raw=fixture();delete raw.units[1].unitDirection;const {draft}=normalizeDraft(raw,source,packing);
 assert.ok(draft.units[0].unitDirection.includes(comic));
 assert.ok(validate(draft,directionVersion).errors.some(e=>e.code==='UNIT_DIRECTION'&&e.coordinate==='u1.segments[1]'));
 assert.deepEqual(validate(draft).errors,[]);
});

test('delta retains generated segments verbatim and accepts a schema-shaped full replacement with its own direction',()=>{
 const draft=normalizeDraft(fixture(),source,packing).draft;
 draft.units.push(unit('u3',tense,[shot('s5','r3','甲屏住呼吸，手势仍悬停。')]));
 const before=structuredClone(draft),replacement=structuredClone(draft.units[1]);replacement.id='u3-revised';replacement.unitDirection='保留正常比例；乙目光仍锁住手，甲压住吸气，以悬停和呼吸继续承载压迫。';
 replacement.shots=[{...shot('s6','r3','甲屏住呼吸，手仍停在半空。'),lighting:'仍守窗光方向，手背亮缘保持可见。'}];
 const delta={schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(draft),retainedUnitIds:['u1'],replacements:[{replaces:['u3'],units:[replacement],fantasyRealization:[]}],revisionNotes:[],unresolved:[]};
 const schema=buildOutputSchema({stage:'finish',finishMode:'delta',source,settings,selection:{selectedIds:[]},previousDraft:draft,baseDraftHash:delta.baseDraftHash,scenarioKeys:[],plan,outputSchemaVersion:'structured-v2',unitDirectionVersion:directionVersion});
 const replacementSchema=schema.properties.replacements.items.properties.units.items;
 assert.equal(replacementSchema.additionalProperties,false);assert.equal(replacementSchema.properties.segments,undefined);
 assert.deepEqual(Object.keys(replacement).sort(),[...replacementSchema.required].sort());
 assert.deepEqual(Object.keys(replacement.shots[0]).sort(),[...replacementSchema.properties.shots.items.required].sort());
 const out=applyDelta(draft,delta);
 assert.equal(out.units[0],draft.units[0]);assert.deepEqual(out.units[0],before.units[0]);assert.deepEqual(out.units[0].segments.map(s=>s.unitDirection),[comic,tense]);
 assert.equal(out.units[1],replacement);assert.equal(out.units[1].unitDirection,replacement.unitDirection);assert.equal(out.units[1].segments,undefined);
 assert.deepEqual(out.units[1].shots,replacement.shots);assert.equal(out.units[1].lighting,before.units[1].lighting);assert.equal(out.units[1].initialState,before.units[1].initialState);assert.equal(out.units[1].exitState,before.units[1].exitState);
 assert.deepEqual(validate(out,directionVersion).errors,[]);
 assert.deepEqual(draft,before);
});
