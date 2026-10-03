import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDraft,validateDraft,renderDraft} from './quality.mjs';

const source={key:'clash',title:'火焰',context:'夜/内',sourceRows:[
 {id:'clash:P0080',line:80,sourceId:'P0080',sourceFileLine:80,text:'火焰沿手背亮起。'},
 {id:'clash:P0081',line:81,sourceId:'P0081',sourceFileLine:113,text:'甲：别怕，'},
 {id:'clash:P0082',line:82,sourceId:'P0082',sourceFileLine:114,text:'我在。'},
 {id:'clash:P0083',line:83,sourceId:'P0083',sourceFileLine:115,text:'兽：吼！'}],contextRows:[],
 dialogue:[{id:'D1',speaker:'甲',quote:'别怕，我在。',channel:'现场对白',kind:'speech',rowId:'clash:P0081'},
 {id:'D2',speaker:'兽',quote:'吼！',channel:'现场对白',kind:'roar',cue:'画外咆哮',rowId:'clash:P0083'}],entryFacts:[],assets:[]};
const settings={model:'gpt-6-sol',reasoning:'medium',maxUnitSeconds:15,maxUnits:null,visualStyle:'国漫',fantasyMode:'off',fantasyEnabled:false};
const shot=(id,refs,parts,picture='甲看向火焰，兽在画外咆哮。')=>({id,duration:4,camera:'甲的侧面近景，镜头静止。',picture,lighting:'火光照亮甲的手背。',sound:'环境声与兽吼。',dialogueParts:parts,transition:'动作接下镜。',sourceRefs:refs});
const part=(lineId,text,presentation='画内',delivery='压住恐惧、短促出声')=>({lineId,text,presentation,delivery,voiceStart:0,voiceEnd:2});
const unit=(id,shots)=>({id,title:`单元${id}`,intent:{subject:'甲',change:'惊惧转为镇定',landing:'甲接住眼前火光',retain:['火焰已出现']},scene:'室内，夜',props:['火焰'],participants:['甲','兽'],lighting:'火光为主',initialState:'甲背对门。',exitState:'甲转身。',shots});
const draft=()=>({schemaVersion:'performance-core-v4',units:[unit('U1',[shot('S1',['clash:P0080','clash:P0081'],[part('D1','别怕，')])]),unit('U2',[shot('S2',['clash:P0082','clash:P0083'],[part('D1','我在。','画外转画内'),{...part('D2','吼！','画外','低沉兽吼'),voiceStart:2,voiceEnd:4}])])],fantasyRealization:[]});
const check=d=>validateDraft({draft:d,source,settings,selection:{selectedIds:[]},plan:{fantasyCandidates:[]}});

test('跨单元拼接原话、现场声画外转画内、兽吼均合法；off保留源火焰',()=>{
 const d=draft(),r=check(d);assert.deepEqual(r.errors,[]);assert.equal(r.stats.units,2);
 const md=renderDraft({draft:d,source,settings});assert.match(md,/火焰沿手背|甲看向火焰/);assert.match(md,/压住恐惧、短促出声/);assert.match(md,/声事件/);assert.match(md,/画外转画内/);assert.doesNotMatch(md,/幻想关闭/);
});
test('只归一唯一源别名、展示同义项和已兑现状态，不改原稿',()=>{
 const raw=draft(),before=structuredClone(raw);raw.units[0].shots[0].sourceRefs=['P0080','L0113'];raw.units[1].shots[0].dialogueParts[0].presentation='画外→画内';raw.fantasyRealization=[{candidateId:'F1',status:'已兑现'}];const original=structuredClone(raw);
 const {draft:d,changes}=normalizeDraft(raw,source);assert.deepEqual(raw,original);assert.equal(d.units[0].shots[0].sourceRefs[0],'clash:P0080');assert.equal(d.units[0].shots[0].sourceRefs[1],'clash:P0081');assert.equal(d.units[1].shots[0].dialogueParts[0].presentation,'画外转画内');assert.equal(d.fantasyRealization[0].status,'realized');assert.ok(changes.length>=4);assert.deepEqual(before.units[0].shots[0].sourceRefs,['clash:P0080','clash:P0081']);
});
test('改词、漏句、顺序倒置和声道篡改逐项报错',()=>{
 const d=draft();d.units[0].shots[0].dialogueParts[0].text='不要怕，';d.units[1].shots[0].dialogueParts.reverse();d.units[1].shots[0].dialogueParts[0].presentation='VO';
 const codes=check(d).errors.map(x=>x.code);for(const code of ['DIALOGUE_CONTENT','DIALOGUE_ORDER','CHANNEL'])assert.ok(codes.includes(code),code);
 const missing=draft();missing.units[1].shots[0].dialogueParts.pop();assert.ok(check(missing).errors.some(x=>x.code==='DIALOGUE_CONTENT'));
});
test('超时、重ID、漏字段、非法声窗和未知源引用均报错',()=>{
 const d=draft();d.units[1].id='U1';d.units[1].shots[0].id='S1';d.units[0].shots[0].duration=16;d.units[0].shots[0].camera='';d.units[0].shots[0].dialogueParts[0].voiceEnd=17;d.units[0].shots[0].sourceRefs=['unknown'];
 const codes=check(d).errors.map(x=>x.code);for(const code of ['UNIT_ID','SHOT_ID','UNIT_DURATION','FIELD','VOICE_WINDOW','SOURCE_REF'])assert.ok(codes.includes(code),code);
});
test('已选幻想必须映射有效归属与有正文的镜；off不能额外实施未选候选',()=>{
 const plan={fantasyCandidates:[{id:'F1',anchorRefs:['clash:P0080']}]};const selected={selectedIds:['F1']};const d=draft();let r=validateDraft({draft:d,source,settings,selection:selected,plan});assert.ok(r.errors.some(x=>x.code==='FANTASY_MISSING'));
 d.fantasyRealization=[{candidateId:'F1',unitIds:['U1'],shotIds:['S404'],screenSeconds:2,entry:'火光进入',exit:'返回现实',domain:'主观',preservedFunction:'承接惊惧',status:'realized'}];r=validateDraft({draft:d,source,settings,selection:selected,plan});assert.ok(r.errors.some(x=>x.code==='FANTASY_SHOT'));
 d.fantasyRealization[0].shotIds=['S1'];r=validateDraft({draft:d,source,settings,selection:selected,plan});assert.ok(!r.errors.some(x=>x.code.startsWith('FANTASY')));
 r=validateDraft({draft:d,source,settings,selection:{selectedIds:[]},plan});assert.ok(r.errors.some(x=>x.code==='FANTASY_UNSELECTED'));
});
test('明确同镜硬切矛盾给定位警报，但普通切点不全禁',()=>{
 const d=draft();d.units[0].shots[0].camera='先眼部近景再切成全身';d.units[1].shots[0].camera='随即切同一镜内连续摇焦';
 const r=check(d);assert.ok(r.warnings.filter(x=>x.code==='CAMERA_CUT').length>=2);assert.ok(r.warnings.some(x=>x.coordinate==='S1'));assert.ok(r.warnings.some(x=>x.coordinate==='S2'));
});
test('同一别名若落到不同源行，不自动归一；场次元信息不需独占镜头',()=>{
 const src=structuredClone(source);src.sourceRows.unshift({id:'clash:SCENE',line:1,sourceId:'SCENE',kind:'metadata',text:'△ 学校大厅，日/内'});src.sourceRows.push({id:'clash:L0080',line:80,sourceId:'L0080',text:'第二条同数码源行'});
 const d=draft();d.units[0].shots[0].sourceRefs=['L0080'];const {draft:n}=normalizeDraft(d,src);assert.equal(n.units[0].shots[0].sourceRefs[0],'L0080');
 const errors=validateDraft({draft:n,source:src,settings,selection:{selectedIds:[]},plan:{fantasyCandidates:[]}}).errors;
 assert.ok(errors.some(x=>x.code==='SOURCE_REF'&&x.coordinate==='S1'));assert.ok(!errors.some(x=>x.code==='SOURCE_COVERAGE'&&x.coordinate==='clash:SCENE'));
});
test('P段号不能猜成同数值物理L行号',()=>{
 const d=draft();d.units[0].shots[0].sourceRefs=['L0081'];const {draft:n,changes}=normalizeDraft(d,source);
 assert.equal(n.units[0].shots[0].sourceRefs[0],'L0081');assert.ok(!changes.some(x=>x.field==='sourceRefs[0]'));
 assert.ok(check(n).errors.some(x=>x.code==='SOURCE_REF'&&x.coordinate==='S1'));
});
test('源VO只准VO，现场混合可见性不改变声道',()=>{
 const src=structuredClone(source),d=draft();src.dialogue[0].channel='VO';
 assert.ok(validateDraft({draft:d,source:src,settings}).errors.some(x=>x.code==='CHANNEL'));
 d.units[0].shots[0].dialogueParts[0].presentation='VO';d.units[1].shots[0].dialogueParts[0].presentation='VO';
 assert.ok(!validateDraft({draft:d,source:src,settings}).errors.some(x=>x.code==='CHANNEL'));
});
test('台词完整仍须覆盖唯一的△动作行，metadata行可不单独关联',()=>{
 const src=structuredClone(source);src.sourceRows.push({id:'clash:P0084',sourceId:'P0084',line:84,sourceFileLine:116,kind:'action',text:'△ 甲把钥匙藏进袖口。'});
 src.sourceRows.push({id:'clash:P0085',sourceId:'P0085',line:85,sourceFileLine:117,kind:'metadata',text:'第1集 1-2 夜/内'});
 const errors=validateDraft({draft:draft(),source:src,settings}).errors;
 assert.ok(errors.some(x=>x.code==='SOURCE_COVERAGE'&&x.coordinate==='clash:P0084'));
 assert.ok(!errors.some(x=>x.code==='SOURCE_COVERAGE'&&x.coordinate==='clash:P0085'));
});
test('导出每单元独立从零计时，只有执行正文与六栏',()=>{
 const d=draft(),md=renderDraft({draft:d,source,settings:{...settings,visualStyle:'3D国漫，16:9',fantasyMode:'recommended',fantasyEnabled:true},selection:{selectedIds:['F1']}});
 assert.equal((md.match(/\[通用提示词\]/g)||[]).length,2);
 assert.equal((md.match(/分镜1｜0-4s/g)||[]).length,2);
 for(const head of ['[场景]','[本单元道具]','[本单元出场人物]','[本单元光影]','[人物状态与站位前提]'])assert.equal((md.match(new RegExp(head.replace(/[\[\]]/g,'\\$&'),'g'))||[]).length,2,head);
 for(const field of ['机位/运镜：','画面：','光影：','声音：','台词：','转场：'])assert.ok(md.includes(field),field);
 assert.doesNotMatch(md,/gpt-6-sol|medium|F1|情绪意图|制作设置|schemaVersion/);
 assert.equal((md.match(/已选幻想只按本单元画面正文呈现/g)||[]).length,2);
});
test('否定念字说明不误报，系统音呈现为画外合法',()=>{
 const src=structuredClone(source),d=draft();d.units[1].shots[0].dialogueParts[1].delivery='保持兽吼，不由人声念字';
 assert.ok(!validateDraft({draft:d,source:src,settings}).warnings.some(x=>x.code==='NONVERBAL_DELIVERY'));
 src.dialogue[1].channel='系统音';d.units[1].shots[0].dialogueParts[1].presentation='画外';
 assert.ok(!validateDraft({draft:d,source:src,settings}).errors.some(x=>x.code==='DIALOGUE_PRESENTATION'||x.code==='CHANNEL'));
 d.units[1].shots[0].dialogueParts[1].presentation='系统音';
 assert.ok(!validateDraft({draft:d,source:src,settings}).errors.some(x=>x.code==='DIALOGUE_PRESENTATION'||x.code==='CHANNEL'));
});
test('坏形状归一原样交还校验，缺失时长上限默认30且非法上限报错',()=>{
 for(const raw of [null,{schemaVersion:'performance-core-v4',units:{}},{schemaVersion:'performance-core-v4',units:[null]}, {schemaVersion:'performance-core-v4',units:[{shots:[null]}]}, {schemaVersion:'performance-core-v4',units:[],fantasyRealization:[null]}]){
  const result=normalizeDraft(raw,source);assert.deepEqual(result.draft,raw);assert.ok(validateDraft({draft:result.draft,source,settings}).errors.length);
 }
 const d=draft();d.units[0].shots[0].duration=31;
 assert.ok(validateDraft({draft:d,source,settings:{}}).errors.some(x=>x.code==='UNIT_DURATION'));
 assert.ok(validateDraft({draft:d,source,settings:{maxUnitSeconds:900}}).errors.some(x=>x.code==='SETTINGS'));
});
test('null幻想记录返回具体坐标错误，不抛异常',()=>{
 const d=draft();d.fantasyRealization=[null];
 const r=check(d);assert.ok(r.errors.some(x=>x.code==='FANTASY_FIELD'&&x.coordinate==='fantasyRealization[0]'));
});
test('幻想屏幕时长不能超过关联镜头合计镜长',()=>{
 const d=draft();d.fantasyRealization=[{candidateId:'F1',unitIds:['U1'],shotIds:['S1'],screenSeconds:4.001,entry:'进入',exit:'退出',domain:'主观',preservedFunction:'承接恐惧',status:'realized'}];
 const args={draft:d,source,settings,selection:{selectedIds:['F1']},plan:{fantasyCandidates:[{id:'F1'}]}};
 assert.ok(validateDraft(args).errors.some(x=>x.code==='FANTASY_DURATION'&&x.coordinate==='F1'));
 d.fantasyRealization[0].screenSeconds=4.0000001;
 assert.ok(!validateDraft(args).errors.some(x=>x.code==='FANTASY_DURATION'));
});
test('幻想单元和镜号不得重复，且镜头归属必须匹配',()=>{
 const d=draft();d.fantasyRealization=[{candidateId:'F1',unitIds:['U1','U1'],shotIds:['S1','S1'],screenSeconds:2,entry:'进入',exit:'退出',domain:'主观',preservedFunction:'承接恐惧',status:'realized'}];
 const args={draft:d,source,settings,selection:{selectedIds:['F1']},plan:{fantasyCandidates:[{id:'F1'}]}};
 assert.ok(validateDraft(args).errors.some(x=>x.code==='FANTASY_UNIT'&&x.coordinate==='F1'));
 assert.ok(validateDraft(args).errors.some(x=>x.code==='FANTASY_SHOT'&&x.coordinate==='F1'));
 d.fantasyRealization[0].unitIds=['U2'];d.fantasyRealization[0].shotIds=['S1'];
 assert.ok(validateDraft(args).errors.some(x=>x.code==='FANTASY_SHOT'&&x.coordinate==='F1'));
});
test('整编声明仍有未解决问题时不能当可交稿',()=>{
 const d=draft();d.unresolved=[{coordinate:'S1',problem:'手部运动尚未确定'}];
 assert.ok(check(d).errors.some(x=>x.code==='UNRESOLVED'));
 d.unresolved=[];assert.ok(!check(d).errors.some(x=>x.code==='UNRESOLVED'));
});
test('真实前情引用从制作sourceRefs移到contextRefs，保留坐标和原稿',()=>{
 const src=structuredClone(source);src.contextRows=[{id:'clash:L0558',sourceId:'L0558',line:558,sourceFileLine:558,text:'甲此前已见过火光。'}];
 const raw=draft();raw.units[0].shots[0].sourceRefs.push('clash:L0558');raw.units[1].shots[0].sourceRefs.push('clash:L0558');const original=structuredClone(raw);
 const {draft:d,changes}=normalizeDraft(raw,src);assert.deepEqual(raw,original);
 for(const u of d.units){const s=u.shots[0];assert.ok(!s.sourceRefs.includes('clash:L0558'));assert.deepEqual(s.contextRefs,['clash:L0558']);}
 assert.equal(changes.filter(x=>x.to==='clash:L0558').length,2);
 assert.deepEqual(validateDraft({draft:d,source:src,settings}).errors,[]);
 assert.equal(validateDraft({draft:d,source:src,settings}).stats.sourceRowsCovered,4);
});
test('未知前情引用仍报错，不从sourceRefs搬走',()=>{
 const src=structuredClone(source);src.contextRows=[{id:'clash:L0558',sourceId:'L0558',line:558,text:'前情'}];
 const d=draft();d.units[0].shots[0].sourceRefs.push('unknown');
 const normalized=normalizeDraft(d,src).draft;assert.ok(normalized.units[0].shots[0].sourceRefs.includes('unknown'));
 assert.ok(validateDraft({draft:normalized,source:src,settings}).errors.some(x=>x.code==='SOURCE_REF'));
 normalized.units[0].shots[0].contextRefs=['unknown'];
 assert.ok(validateDraft({draft:normalized,source:src,settings}).errors.some(x=>x.code==='CONTEXT_REF'));
});
test('推荐模式按单元兑现记录写幻想头，不依赖fantasyEnabled参数',()=>{
 const d=draft();d.fantasyRealization=[{candidateId:'F1',unitIds:['U1'],shotIds:['S1'],screenSeconds:2,entry:'进入',exit:'退出',domain:'主观',preservedFunction:'承接恐惧',status:'realized'}];
 const md=renderDraft({draft:d,source,settings:{...settings,fantasyMode:'recommended',fantasyEnabled:undefined}});
 const [first,second]=md.split('\n\n---\n\n');
 assert.match(first,/已选幻想只按本单元画面正文呈现/);
 assert.doesNotMatch(first,/不加入额外幻想段落/);
 assert.match(second,/不加入额外幻想段落/);
});
test('空白和独立标点不要求单独镜头，△动作仍须覆盖',()=>{
 const src=structuredClone(source);src.sourceRows.push(
  {id:'clash:L0200',line:200,kind:'blank',text:''},
  {id:'clash:L0201',line:201,text:'  '},
  {id:'clash:L0202',line:202,kind:'punctuation',text:'！'},
  {id:'clash:L0203',line:203,text:'。'},
  {id:'clash:L0204',line:204,kind:'action',text:'△ 甲熄灭火光。'});
 const coverage=validateDraft({draft:draft(),source:src,settings}).errors.filter(x=>x.code==='SOURCE_COVERAGE').map(x=>x.coordinate);
 assert.deepEqual(coverage,['clash:L0204']);
});
test('off模式即使坏稿带已兑现记录，导出头也不鼓励额外幻想',()=>{
 const d=draft();d.fantasyRealization=[{candidateId:'F1',unitIds:['U1'],shotIds:['S1'],screenSeconds:2,entry:'进入',exit:'退出',domain:'主观',preservedFunction:'承接恐惧',status:'realized'}];
 const md=renderDraft({draft:d,source,settings});
 assert.match(md,/不加入额外幻想段落，源剧情的法术与特效照常表现/);
 assert.doesNotMatch(md,/已选幻想只按本单元画面正文呈现/);
 assert.ok(validateDraft({draft:d,source,settings,selection:{selectedIds:[]},plan:{fantasyCandidates:[{id:'F1'}]}}).errors.some(x=>x.code==='FANTASY_UNSELECTED'));
});
test('小包前情成为整集制作源后，contextRefs仍是有效依据且不替代制作覆盖',()=>{
 const context={id:'clash:L0350',sourceId:'L0350',line:350,text:'甲此前遗失了钥匙。'};
 const small=structuredClone(source);small.contextRows=[context];
 const raw=draft();raw.units[0].shots[0].sourceRefs.push('L0350');
 const smallDraft=normalizeDraft(raw,small).draft;
 assert.deepEqual(smallDraft.units[0].shots[0].contextRefs,['clash:L0350']);
 const full=structuredClone(source);full.sourceRows.push({...context,kind:'action'});
 const {draft:expanded,changes}=normalizeDraft(smallDraft,full);
 assert.deepEqual(expanded.units[0].shots[0].contextRefs,['clash:L0350']);
 assert.deepEqual(validateDraft({draft:expanded,source:full,settings}).errors.filter(x=>x.code==='CONTEXT_REF'),[]);
 assert.ok(validateDraft({draft:expanded,source:full,settings}).errors.some(x=>x.code==='SOURCE_COVERAGE'&&x.coordinate==='clash:L0350'));
 expanded.units[0].shots[0].contextRefs=['L0350'];
 const normalized=normalizeDraft(expanded,full);
 assert.deepEqual(normalized.draft.units[0].shots[0].contextRefs,['clash:L0350']);
 assert.ok(normalized.changes.some(x=>x.field==='contextRefs[0]'));
 expanded.units[0].shots[0].contextRefs=['unknown'];
 assert.ok(validateDraft({draft:expanded,source:full,settings}).errors.some(x=>x.code==='CONTEXT_REF'));
});
