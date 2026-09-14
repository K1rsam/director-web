import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createSource,proposePlan,validatePlan,normalize} from './fidelity.mjs';
import {normalize as normalizeV2} from '../../../../lib/fidelity-v2.mjs';
const copy=o=>JSON.parse(JSON.stringify(o));

test('同集连续未归场正文只报一个区间，保留每行正文及说话者',()=>{
 const text='第一集\r\n'+'甲乙：原文 é😀。  \r\n'.repeat(120),result=normalize(text);
 const issues=result.validation.issues.filter(issue=>issue.code==='SCENE_BOUNDARY_UNCONFIRMED');
 assert.equal(issues.length,1);assert.equal(issues[0].start,'第一集\r\n'.length);assert.equal(issues[0].end,text.length);
 assert.equal(result.segments.length,121);assert.equal(result.segments.map(segment=>segment.text).join(''),text);
 assert(result.segments.slice(1).every(segment=>segment.kind==='body'&&segment.sceneId===null&&segment.speakerLabels.includes('甲乙')));
 assert.equal(result.episodes[0].scenes.length,0,'诊断合并不能猜造整集一场');
 for(const segment of result.segments)assert.equal(segment.text,text.slice(segment.start,segment.end));
});

test('无所属集的连续正文也合并诊断，不猜集场且不跨资料或不同错误',()=>{
 const text='匿名正文甲\r\n匿名正文乙😀\r\n\r\n孤立正文\n作者资料\n背景\n第一集\n未归场甲\n未归场乙\n',source=createSource(text),result=normalize(source);
 assert.deepEqual(result.validation.issues.map(issue=>[issue.code,text.slice(issue.start,issue.end)]),[['BOUNDARY_UNCONFIRMED','匿名正文甲\r\n匿名正文乙😀\r\n'],['BOUNDARY_UNCONFIRMED','孤立正文\n'],['SCENE_BOUNDARY_UNCONFIRMED','未归场甲\n未归场乙\n']]);
 assert.equal(result.segments[0].episodeId,null);assert.equal(result.segments[0].sceneId,null);
 const legacy=copy(result.plan);legacy.issues=legacy.issues.flatMap(issue=>legacy.segments.filter(segment=>segment.start>=issue.start&&segment.end<=issue.end).map(segment=>({...issue,start:segment.start,end:segment.end})));
 assert.equal(validatePlan(source,legacy).ok,true);assert.deepEqual(normalize(source,{plan:legacy}).plan.issues,result.plan.issues);
 assert.equal(result.segments.map(segment=>segment.text).join(''),text);
});

test('诊断范围不跨集、明确场、资料、格式空行或其它错误',()=>{
 const text='无集正文\n第一集\n甲段\n乙段\n\n丙段\n丁段\n1-1 日 外 门口\n已归场正文\n第二集\n戊段\n己段\n作者资料\n背景原文\n第三集\n庚段\n辛段\n第一集\n壬段\n癸段\n';
 const result=normalize(text),issues=result.validation.issues.filter(issue=>issue.code==='SCENE_BOUNDARY_UNCONFIRMED');
 assert.deepEqual(issues.map(issue=>text.slice(issue.start,issue.end)),['甲段\n乙段\n','丙段\n丁段\n','戊段\n己段\n','庚段\n辛段\n','壬段\n癸段\n']);
 assert.equal(result.validation.issues.filter(issue=>issue.code==='BOUNDARY_UNCONFIRMED').length,1);
 assert.equal(result.validation.issues.filter(issue=>issue.code==='DUPLICATE_EPISODE_NUMBER').length,1);
 assert.equal(result.segments.map(segment=>segment.text).join(''),text);
 for(const issue of issues){const covered=result.segments.filter(segment=>segment.start>=issue.start&&segment.end<=issue.end);assert(covered.every(segment=>segment.kind==='body'&&segment.episodeId===covered[0].episodeId&&segment.sceneId===null));}
});

test('同契约逐行诊断精确验真，输出规范化为区间，提交计划不被改写',()=>{
 const source=createSource('第一集\n甲段\n乙段\n\n丙段\n丁段\n第二集\n戊段\n己段\n');
 const fresh=proposePlan(source),legacy=copy(fresh);
 legacy.issues=legacy.issues.flatMap(issue=>issue.code==='SCENE_BOUNDARY_UNCONFIRMED'?legacy.segments.filter(segment=>segment.start>=issue.start&&segment.end<=issue.end).map(segment=>({...issue,start:segment.start,end:segment.end})):[issue]);
 const before=copy(legacy);
 assert.equal(legacy.issues.length,6);assert.equal(fresh.issues.length,3);
 assert.equal(validatePlan(source,legacy).ok,true);
 const normalized=normalize(source,{plan:legacy});
 assert.deepEqual(normalized.plan.issues,fresh.issues);assert.deepEqual(normalized.validation.issues,fresh.issues);
 assert.deepEqual(normalized.plan.segments,legacy.segments);assert.deepEqual(legacy,before);
 for(const mutate of [
  plan=>plan.issues.splice(1,1),
  plan=>plan.issues[0].message='已经解决',
  plan=>plan.issues[0].end=plan.issues.at(-1).end,
  plan=>plan.issues.reverse(),
  plan=>plan.issues.push(copy(plan.issues[0])),
  plan=>plan.issues[0].start++,
 ]){const bad=copy(legacy);mutate(bad);assert.equal(validatePlan(source,bad).ok,false);}
 const mixed=copy(legacy);mixed.issues.splice(0,2,copy(fresh.issues[0]));assert.equal(validatePlan(source,mixed).ok,false,'只接受完整旧或完整新规范，不允许任意拼接');
});

test('冻结v2仍保留旧场标题漏识别语义，不能以v3宽松验真',()=>{
 const text='第一集\n'+'场1-2 日 内 门口 甲乙：到了。\n\n'.repeat(4);
 const result=normalizeV2(text);
 assert.equal(result.validation.issues.filter(issue=>issue.code==='SCENE_BOUNDARY_UNCONFIRMED').length,4);
 assert.equal(result.episodes[0].scenes.length,0,'本修复不改现有场标题识别');
 assert.equal(result.segments.map(segment=>segment.text).join(''),text);
});

test('v3行首场N-M及同行集场正文不改行块，单行整场也可生产',()=>{
 const text='第1集 归来 场1-1 日 外 门口 人物：甲 △甲停步。甲：到了。\r\n场1-2 夜 内 大厅 人物：乙 乙：进来。\r\n第2集 后续 场2-1 日 外 街道 人物：甲 △甲离开。\n';
 const result=normalize(text),old=normalizeV2(text);
 assert.equal(result.contractVersion,'fidelity/3');assert.equal(result.episodes.length,2);
 assert.deepEqual(result.episodes.map(e=>e.scenes.length),[2,1]);assert.equal(result.validation.issues.length,0);
 assert(result.segments.every(s=>s.kind==='body'&&s.productionEligible&&s.sceneId));
 assert.deepEqual(result.segments.map(s=>[s.id,s.start,s.end,s.text,s.textHash,s.speakerLabels]),old.segments.map(s=>[s.id,s.start,s.end,s.text,s.textHash,s.speakerLabels]));
 assert.equal(result.segments.map(s=>s.text).join(''),text);assert.equal(result.source.sourceVersion,old.source.sourceVersion);
 assert(result.episodes.every(e=>e.productionEligible));
});

test('v3错集场标题不继承前场，不将对白或无元数据数字当场',()=>{
 const wrong=normalize('第一集\n场1-1 日 内 大厅\n甲：原场。\n场2-2 日 外 门口 人物：乙 △乙停步。\n');
 assert.equal(wrong.episodes[0].scenes.length,1);assert.equal(wrong.segments.at(-1).sceneId,null);
 assert(wrong.validation.issues.some(i=>i.code==='SCENE_EPISODE_MISMATCH'));
 for(const line of ['甲：场1-1 日 外 门口','△甲念出场1-1 日 内 大厅','场1-1','场1-1 价格1.5万元','第1集 甲说：场1-1 日 外 门口','第1集 标题 场2-1 日 外 门口 人物：甲']) {
  const result=normalize(`第一集\n${line}\n甲：继续。\n`);assert.equal(result.episodes.reduce((n,e)=>n+e.scenes.length,0),0,line);
 }
});

test('v3同集双行场头跨空行绑定，元数据格式行不被当作正文',()=>{
 const text='第21集\r\n21-1\r\n\r\n林家卧房 夜 / 内\r\n\r\n人物：甲\r\n△甲坐下。\r\n场21-2\r\n门外 日／外\r\n甲：走。\r\n第22集\n22-1\n走廊 日 内\n乙：来。\n';
 const result=normalize(text),old=normalizeV2(text);
 assert.deepEqual(result.episodes.map(e=>e.scenes.length),[2,1]);assert.equal(result.validation.issues.length,0);
 assert.equal(result.episodes[0].scenes[0].start,text.indexOf('21-1'));
 const header=result.segments.find(s=>s.text.includes('林家卧房'));
 assert.equal(header.kind,'format');assert.equal(header.sceneId,result.episodes[0].scenes[0].id);
 assert.deepEqual(result.segments.map(s=>[s.id,s.start,s.end,s.text]),old.segments.map(s=>[s.id,s.start,s.end,s.text]));
 assert.equal(normalize('第21集\n21-1\n卧房 夜 / 内\n').episodes[0].productionEligible,false);
 for(const [number,metadata] of [['21-1','甲：夜 / 内'],['21-1','△甲在夜 / 内行动'],['21-1','卧房 夜'],['21-1','卧房 内'],['21-1','比分 夜 / 内！'],['3.14','卧房 夜 / 内'],['22-1','卧房 夜 / 内']]) {
  const rejected=normalize(`第21集\n${number}\n\n${metadata}\n甲：原文。\n`);
  assert.equal(rejected.episodes[0].scenes.length,0,number+' '+metadata);
 }
});
test('完整覆盖含CRLF emoji组合字 空格和假完成词',()=>{
 const text='第一集\r\n1-1\r\n张三（OS）：  é😀\r\n字幕：完\n【步骤1输出完毕】\n尾段 ';const r=normalize(text);
 assert.equal(r.segments.map(s=>s.text).join(''),text);assert.equal(r.validation.ok,true);
});
test('10段漏第5段拒绝，即使每段内容hash未改',()=>{const s=createSource(Array.from({length:10},(_,i)=>`段${i+1}\n`).join(''));const p=proposePlan(s);p.segments.splice(4,1);assert.equal(validatePlan(s,p).ok,false);});
test('张三台词绑定李四拒绝',()=>{const s=createSource('第一集\n张三：回来。\n');const p=proposePlan(s);p.segments[1].speakerLabels=['李四'];assert.equal(validatePlan(s,p).ok,false);});
test('重复第一处同句而遗漏第二处拒绝',()=>{const s=createSource('第一集\n他转身离开。\n他转身离开。\n');const p=proposePlan(s);p.segments[2]=copy(p.segments[1]);assert.equal(validatePlan(s,p).ok,false);});
test('过期来源与决定拒绝',()=>{const s=createSource('无标题\n内容\n');const p=proposePlan(s);assert.equal(validatePlan(createSource(s.text+'尾'),p).ok,false);const decisions=[{start:0,end:s.length,kind:'context',note:'用户明确为资料'}];const q=proposePlan(s,{decisions});assert.equal(validatePlan(s,q).ok,false);assert.equal(validatePlan(s,q,{decisions}).ok,true);assert.equal(validatePlan(s,p,{decisions}).ok,false);});
test('资料第0集排除、真实第0集保留、附录保留',()=>{const r=normalize('第0集｜作者资料\n秘密\n第0集\n张三：走。\n第一集\n行动\n附录\n小传\n');assert.equal(r.episodes.length,2);assert.equal(r.episodes[0].sourceNumber,'0');assert.equal(r.episodes[0].productionEligible,true);assert.match(r.contextText,/秘密/);assert.match(r.contextText,/小传/);assert.ok(!r.episodes.map(e=>e.content).join('').includes('小传'));});
test('无标题完整保留并待确认，序章仍为剧情',()=>{const r=normalize('张三：开门\n尾段');assert.equal(r.episodes.length,0);assert.ok(r.validation.issues.length);assert.equal(normalize('序章\n开门').episodes[0].productionEligible,true);});
test('小数和点号不误拆，中文混合标题识别',()=>{const r=normalize('第十二集\n3.14\n1.1\n第2场 夜\n台词\n第13集 后续\n完');assert.equal(r.episodes.length,2);assert.equal(r.episodes[0].scenes.length,1);});
test('重复标题不去重，来源身份不同，疑点保留',()=>{const r=normalize('第一集\n甲\n第一集\n乙\n');assert.equal(r.episodes.length,2);assert.notEqual(r.episodes[0].id,r.episodes[1].id);assert.ok(r.validation.issues.some(i=>i.code==='DUPLICATE_EPISODE_NUMBER'));});
test('标签多人同一行不改，禁止replacementText',()=>{const s=createSource('第一集\n张三（VO）：一；李四：二；系统声：三\n');const r=normalize(s);assert.equal(r.segments[1].text,s.text.slice(s.text.indexOf('\n')+1));const p=copy(r.plan);p.segments[1].replacementText='错';assert.equal(validatePlan(s,p).ok,false);});
test('非法CRLF与emoji内部切分拒绝',()=>{for(const text of ['a\r\nb','😀\n末']){const s=createSource(text),p=proposePlan(s);p.segments[0].end=1;assert.equal(validatePlan(s,p).ok,false);}});
test('长背景超长集不截断',()=>{const text='作者资料\n'+'资料'.repeat(30000)+'\n第一集\n'+'正文'.repeat(120000);const r=normalize(text);assert.equal(r.segments.map(s=>s.text).join(''),text);assert.equal(r.validation.coverage.covered,text.length);});
test('空文本有效空覆盖，无生产集',()=>{const r=normalize('');assert.equal(r.validation.ok,true);assert.equal(r.episodes.length,0);});
test('点号数字对含场景元数据识别，金额小数不识别',()=>{for(const heading of ['1.1 日 内 门厅','1．1 日 内 门厅','1. 1 日 内 门厅']){const r=normalize(`第一集 回家\n${heading}\n张三：我回来了；李四：哥哥！`);assert.equal(r.episodes[0].scenes.length,1);assert.equal(r.validation.issues.length,0);}const r=normalize('第一集\n1.5万元\n他拿出1.5万元。');assert.equal(r.episodes[0].scenes.length,0);assert.ok(r.validation.issues.some(i=>i.code==='SCENE_BOUNDARY_UNCONFIRMED'));});
test('有集无场正文保留且待确认，受信整集一场可解决',()=>{const source=createSource('第一集 回家\n张三：到家。');const r=normalize(source);assert.ok(r.validation.issues.some(i=>i.code==='SCENE_BOUNDARY_UNCONFIRMED'));const fixed=normalize(source,{decisions:[{start:0,end:source.length,kind:'body',note:'采用整集一场',episodeNumber:1,sceneNumber:1}]});assert.equal(fixed.validation.issues.length,0);assert.equal(fixed.episodes[0].content,source.text);});
test('空格间隔多人同一行标签识别且动作时间冒号不识别',()=>{const r=normalize('第一集\n1-1\n张三：甲 李四：乙\n他看了一眼时间12:30，离开。\n12:30，他走了。');assert.deepEqual(r.segments[2].speakerLabels,['张三','李四']);assert.deepEqual(r.segments[3].speakerLabels,[]);assert.deepEqual(r.segments[4].speakerLabels,[]);});
test('DOCX读取明确拒绝而非假称提取全保真',()=>{const r=spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'missing.docx','unused-output'],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/DOCX/);});
test('上下文空白保留、裸0集可见待确认、点号标题解析',()=>{const r=normalize('作者资料\n\n设定\n第0集\n一． 修表铺\n动作\n2. 街道\n末');assert.equal(r.contextText,'作者资料\n\n设定\n');assert.ok(r.validation.issues.some(i=>i.code==='ZERO_EPISODE_UNCONFIRMED'));assert.equal(r.episodes[0].scenes.length,2);assert.match(r.normalizedText,/source-range/);});
test('无标题可信用户指定第0集场号可生产，旧决定拒绝',()=>{const s=createSource('张三：开门\n动作\n');const decisions=[{start:0,end:s.length,kind:'body',note:'用户指定序章',episodeNumber:0,sceneNumber:1}];const r=normalize(s,{decisions});assert.equal(r.episodes[0].sourceNumber,'0');assert.equal(r.episodes[0].scenes.length,1);assert.equal(r.validation.issues.length,0);assert.equal(validatePlan(s,r.plan).ok,false);});
test('局部资料决定不会清空后续所属集，生产内容排除资料',()=>{const s=createSource('第一集\n资料\n剧情\n');const decisions=[{start:4,end:7,kind:'context',note:'用户明确'}];const r=normalize(s,{decisions});assert.equal(r.episodes.length,1);assert.equal(r.episodes[0].content,'第一集\n剧情\n');assert.equal(r.contextText,'资料\n');});
test('删疑点、重排、伪造源版本均拒绝',()=>{const s=createSource('一\n二\n');for(const fn of [p=>p.issues=[],p=>p.segments.reverse(),p=>p.sourceVersion='bad']){const p=proposePlan(s);fn(p);assert.equal(validatePlan(s,p).ok,false);}});

test('无空格场头需独立场元数据，比分金额与无元数据不能误判',()=>{
 for(const heading of ['1-1收容所 夜 内','70-3日 内 收容所','1.1门厅 日 内']){const r=normalize(`第一集\n${heading}\n张三：走。`);assert.equal(r.episodes[0].scenes.length,1);assert.equal(r.validation.issues.length,0);}
 for(const heading of ['1-1','70-3比分','1-1收容所','1.5万元','1-1昨日获胜']){assert.equal(normalize(`第一集\n${heading}\n张三：走。`).episodes[0].scenes.length,0);}
});
test('零集下一行明确资料连同标题归资料，真实剧情零集保留',()=>{
 for(const label of ['故事大纲：','人物设定：']){const text=`第零集\r\n\r\n${label}\r\n资料\r\n第一集\r\n1-1门厅 夜 内\r\n张三：走。`;const r=normalize(text);assert.equal(r.episodes.length,1);assert.equal(r.episodes[0].number,1);assert.match(r.contextText,/第零集/);assert.equal(r.segments.map(s=>s.text).join(''),text);assert.equal(r.validation.issues.length,0);}
 const r=normalize('第零集\n0-1门厅 夜 内\n张三：走。');assert.equal(r.episodes[0].sourceNumber,'零');assert.equal(r.episodes[0].productionEligible,true);
});
test('场决定复用同源集场，不将标题与尾空白制造额外集场',()=>{
 const source=createSource('第一集\n1-1门厅 夜 内\n张三：走。\n\n第二集\n2-1走廊 日 内\n李四：来。\n');
 const start=source.text.indexOf('1-1'),end=source.text.indexOf('\n\n')+1;
 const decisions=[{start,end,kind:'body',note:'用户确认',episodeNumber:1,sceneNumber:1}];
 const r=normalize(source,{decisions});assert.equal(r.episodes.length,2);assert.deepEqual(r.episodes.map(e=>e.number),[1,2]);assert.deepEqual(r.episodes.map(e=>e.scenes.length),[1,1]);assert.equal(r.segments.map(s=>s.text).join(''),source.text);
 const changed=[{...decisions[0],note:'新的用户确认'}];assert.notEqual(proposePlan(source,{decisions:changed}).decisionVersion,r.plan.decisionVersion);assert.equal(validatePlan(source,r.plan,{decisions:changed}).ok,false);
 const old=copy(r.plan);old.contractVersion='fidelity/1';assert.equal(validatePlan(source,old,{decisions}).ok,false);
});
test('非生产标题不占生产编号',()=>{
 const s=createSource('第零集\n资料\n第一集\n1-1门厅 夜 内\n张三：走。');
 const r=normalize(s,{decisions:[{start:4,end:7,kind:'context',note:'资料'}]});
 assert.equal(r.episodes[0].productionEligible,false);assert.equal(r.episodes[0].number,0);assert.equal(r.episodes[1].number,1);
});

test('资料前短文档标题归资料，动作对白长稿不能整体吞掉',()=>{
 const r=normalize('山海图鉴：收容所开局\n\n第零集\n故事大纲：\n资料\n第一集\n1-1门厅 夜 内\n甲：走。');assert.equal(r.validation.issues.length,0);assert.match(r.contextText,/山海图鉴/);
 for(const opening of ['△他推门而入。','张三：走！','正文'.repeat(80)]){const text=`${opening}\n第零集\n故事大纲：\n资料\n`;const x=normalize(text);assert.equal(x.segments[0].kind,'body');assert.equal(x.segments.map(s=>s.text).join(''),text);assert.ok(x.validation.issues.length);}
});

test('短标题跨连续等价零集只在明确资料证据前归资料',()=>{
 for(const headings of ['第 0 集\n\n第零集','第零集\n第〇集\n第0集']){
  const text=`山海图鉴\n\n${headings}\n故事大纲：\n资料\n第一集\n1-1门厅 夜 内\n甲：走。`;
  const r=normalize(text);assert.equal(r.segments[0].kind,'context');assert.equal(r.segments.map(s=>s.text).join(''),text);
 }
 for(const heading of ['第零集\n第0集','第零集\n第一集','第零集\n第0集 序章']){
  const text=`山海图鉴\n${heading}\n0-1门厅 夜 内\n甲：走。`;
  const r=normalize(text);assert.equal(r.segments[0].kind,'body');assert.ok(r.segments.some(s=>s.kind==='body'&&s.text.includes('甲：走。')));assert.equal(r.segments.map(s=>s.text).join(''),text);
 }
});

test('已采纳资料决定须完整覆盖连续零集和下一字段才能识别标题',()=>{
 const text='山海图鉴\n\n第 0 集\n\n第零集\n\n剧本类型（题材）：\n都市\n第一集\n1-1门厅 夜 内\n甲：走。';
 const start=text.indexOf('第 0 集'),field=text.indexOf('剧本类型'),fieldEnd=text.indexOf('\n',field)+1,end=text.indexOf('第一集');
 for(const [a,b,expected] of [[start,end,'context'],[start,fieldEnd,'context'],[text.indexOf('第零集'),end,'body'],[start,field,'body']]){
  const r=normalize(text,{decisions:[{start:a,end:b,kind:'context',note:'已采纳资料归属'}]});
  assert.equal(r.segments[0].kind,expected);assert.equal(r.segments.map(s=>s.text).join(''),text);
 }
 const r=normalize(text,{decisions:[{start,end,kind:'body',episodeNumber:0,note:'真实序章'}]});assert.equal(r.segments[0].kind,'body');
});
