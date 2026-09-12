import { createHash } from 'node:crypto';
export const CONTRACT_VERSION = 'fidelity/1';
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function createSource(text) {
  if (typeof text !== 'string') throw new TypeError('读取文本必须是字符串');
  if (text.isWellFormed && !text.isWellFormed()) throw new Error('读取文本含孤立 UTF-16 代理码');
  return Object.freeze({text,sourceVersion:hash(text),coordinateSystem:'utf16',length:text.length});
}
function lines(text) {
  return [...text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)].map(m=>({start:m.index,end:m.index+m[0].length,text:m[0]}));
}
const id = (source,start,end) => `${source.sourceVersion}:${start}:${end}`;
function labels(text) {
  // A lexical label is not a semantic character identity. Never interpret a clock's colon as dialogue.
  return [...text.matchAll(/(?:^|[\s；;])([\p{L}·・]{1,24}(?:[（(][^\r\n()（）:：]{1,24}[）)])?)\s*[：:]/gu)]
    .map(m=>m[1]).filter(label=>!['时间','时刻','场景','地点','人物','道具'].includes(label));
}
function canonical(source, options={}) {
  const decisions = options.decisions ?? [];
  if (!Array.isArray(decisions)) throw new Error('decisions 必须为数组');
  const decisionsCopy = decisions.map(d=>{
    if (!d || !Number.isInteger(d.start) || !Number.isInteger(d.end) || d.start<0 || d.end>source.length || d.end<=d.start || !['body','context'].includes(d.kind) || typeof d.note!=='string' || !d.note.trim()) throw new Error('无效边界决定');
    if(d.episodeNumber!==undefined && (d.kind!=='body'|| !Number.isInteger(d.episodeNumber)||d.episodeNumber<0))throw new Error('episodeNumber 必须为非负整数且用于正文');
    if(d.sceneNumber!==undefined && (!Number.isInteger(d.sceneNumber)||d.sceneNumber<1||d.episodeNumber===undefined))throw new Error('sceneNumber 需要episodeNumber及正整数场号');
    return {start:d.start,end:d.end,kind:d.kind,note:d.note,...(d.episodeNumber===undefined?{}:{episodeNumber:d.episodeNumber}),...(d.sceneNumber===undefined?{}:{sceneNumber:d.sceneNumber})};
  });
  const rows=lines(source.text); const boundaries=new Set([0,source.length,...rows.flatMap(r=>[r.start,r.end])]);
  decisionsCopy.forEach((d,i)=>{if(!boundaries.has(d.start)||!boundaries.has(d.end)||decisionsCopy.slice(0,i).some(p=>d.start<p.end&&p.start<d.end))throw new Error('决定必须使用完整行边界且不得重叠');});
  let episodeId=null,sceneId=null,sourceNumber=null,context=false;
  const issues=[],segments=[],seen=new Set();
  for (const row of rows) {
    const t=row.text.replace(/[\r\n]+$/,'').trim();
    const ep=t.match(/^(?:#{1,6}\s*)?第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*集(?:\s|[：:｜|—-]|$)(.*)$/);
    const ctx=/^(?:#{1,6}\s*)?(?:【)?(?:作者资料|人物小传|人物设定|世界观设定|背景资料|附录)(?:】)?(?:\s|[：:｜|]|$)/.test(t) || !!(ep && /作者资料|人物小传|背景资料|前言/.test(ep[2]));
    const prologue=/^(?:#{1,6}\s*)?(?:序章|序幕)(?:\s|[：:｜|]|$)/.test(t);
    const dottedScene=/^(?:#{1,6}\s*)?\d+\s*[.．]\s*\d+(?:\s+|[：:｜|])(?=[^\r\n]*(?:日|夜|昼|晨|黄昏|内景|外景|\bINT\b|\bEXT\b|(?:^|\s)[内外](?:\s|$)))/i.test(t);
    const scene=dottedScene || t.match(/^(?:#{1,6}\s*)?(?:(\d+)\s*[-－]\s*(\d+)(?![\d.])(?:\s|[：:｜|]|$)|第\s*([零〇一二三四五六七八九十百\d]+)\s*场(?:\s|[：:｜|]|$)|([零〇一二三四五六七八九十百\d]+)[.．、]\s+(?!\d)\S)/);
    let kind='body',reason='locked_source_line';
    if (ep || prologue) {
      episodeId=`episode:${source.sourceVersion}:${row.start}`;sceneId=null;sourceNumber=ep?ep[1]:'序章';context=ctx;
      if(seen.has(sourceNumber))issues.push({code:'DUPLICATE_EPISODE_NUMBER',start:row.start,end:row.end,message:'原集号重复，保留两处来源，需核对页眉或异稿'});
      seen.add(sourceNumber);kind='format';reason='explicit_episode_heading';
    }
    if(ctx){context=true;episodeId=null;sceneId=null;sourceNumber=null;kind='context';reason='explicit_context_heading';}
    else if(context){kind='context';reason='context_section';}
    else if(scene){sceneId=`scene:${source.sourceVersion}:${row.start}`;kind='format';reason='explicit_scene_heading';}
    if(!t&&!context){kind='format';reason='source_whitespace';}
    const decision=decisionsCopy.find(d=>d.start<=row.start&&d.end>=row.end);
    if(decision){kind=decision.kind;reason='user_boundary_decision';}
    const effectiveEpisode=decision?.episodeNumber!==undefined?`episode:${source.sourceVersion}:decision:${decisionsCopy.find(d=>d.episodeNumber===decision.episodeNumber).start}`:episodeId;
    const effectiveScene=decision?.sceneNumber!==undefined?`scene:${source.sourceVersion}:decision:${decision.start}`:sceneId;
    if(kind==='body'&&!effectiveEpisode) issues.push({code:'BOUNDARY_UNCONFIRMED',start:row.start,end:row.end,message:'正文已保留；所属集场待确认'});
    if(kind==='body'&&effectiveEpisode&&!effectiveScene) issues.push({code:'SCENE_BOUNDARY_UNCONFIRMED',start:row.start,end:row.end,message:'正文已保留并属于当前集；尚无明确场界，请确认场范围或采用整集一场'});
    if(ep&&/^[0零〇]+$/.test(ep[1])&&!ctx&&!ep[2].trim()&&!decision)issues.push({code:'ZERO_EPISODE_UNCONFIRMED',start:row.start,end:row.end,message:'第0集无类型说明，暂保留正文，需确认资料或序章剧情'});
    segments.push({id:id(source,row.start,row.end),start:row.start,end:row.end,kind,episodeId:kind==='context'?null:effectiveEpisode,sceneId:kind==='context'?null:effectiveScene,sourceNumber:decision?.episodeNumber===undefined?sourceNumber:String(decision.episodeNumber),productionEligible:kind==='body',reason,speakerLabels:labels(row.text)});
  }
  return {contractVersion:CONTRACT_VERSION,sourceVersion:source.sourceVersion,decisionVersion:hash(JSON.stringify(decisionsCopy)),decisions:decisionsCopy,segments,issues};
}
export function proposePlan(source,options={}) { return canonical(createSource(source.text),options); }
export function validatePlan(source,plan,options={}) {
  const errors=[]; const fail=(code,message,index)=>errors.push({code,message,...(index===undefined?{}:{index})});
  let fresh;try{fresh=createSource(source.text);}catch(e){return {ok:false,errors:[{code:'INVALID_SOURCE',message:e.message}],issues:[],coverage:{length:0,covered:0}};}
  if(source.sourceVersion!==fresh.sourceVersion || source.length!==fresh.length || source.coordinateSystem!=='utf16')fail('SOURCE_CHANGED','读取文本或源元数据已变更');
  let expected;try{expected=canonical(fresh,options);}catch(e){fail('INVALID_DECISIONS',e.message);}
  if(!plan || typeof plan!=='object' || !expected) return {ok:false,errors:errors.length?errors:[{code:'INVALID_PLAN',message:'缺少计划'}],issues:[],coverage:{length:fresh.length,covered:0}};
  const allowed=new Set(Object.keys(expected));for(const k of Object.keys(plan))if(!allowed.has(k))fail('UNKNOWN_PLAN_FIELD',`不支持字段 ${k}`);
  for(const k of ['contractVersion','sourceVersion','decisionVersion','decisions'])if(!same(plan[k],expected[k]))fail('STALE_OR_CHANGED_PLAN',`${k} 与当前源/决定不一致`);
  const items=Array.isArray(plan.segments)?plan.segments:[];let cursor=0;
  items.forEach((s,i)=>{
    if(!s||!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start!==cursor||s.end<=s.start||s.end>fresh.length){fail('COVERAGE_ORDER','区间漏段、重复、错序或越界',i);return;}
    cursor=s.end;
    if(!same(s,expected.segments[i]))fail('SOURCE_BINDING_CHANGED','来源位置、分类、说话者或结构字段不符合当前固定解析/用户决定',i);
  });
  if(cursor!==fresh.length||items.length!==expected.segments.length)fail('INCOMPLETE_COVERAGE','必须完整覆盖源文到结尾，且每个来源行恰好一次');
  if(!same(plan.issues,expected.issues))fail('ISSUES_CHANGED','疑点不得删改，须通过新的用户决定解决');
  return {ok:errors.length===0,errors,issues:expected.issues,coverage:{length:fresh.length,covered:cursor}};
}
export function renderNormalized(source,plan,options={}) {
  const validation=validatePlan(source,plan,options);if(!validation.ok)throw Object.assign(new Error('保真校验失败'),{validation});
  let priorEpisode=null,priorScene=null,priorKind=null;
  const parts=[`# 保真规范化视图\n\n<!-- ${CONTRACT_VERSION}; sourceVersion=${source.sourceVersion}; 结构标记为新增视图，锁定文本在source-range标签内 -->\n`];
  for(const s of plan.segments){
    if(s.kind==='context'&&priorKind!=='context')parts.push('\n## 第0集｜作者资料（非生产）\n');
    if(s.episodeId&&s.episodeId!==priorEpisode)parts.push(`\n## 集 ${s.sourceNumber??'待确认'} <!-- id=${s.episodeId} -->\n`);
    if(s.sceneId&&s.sceneId!==priorScene)parts.push(`\n### 场 <!-- id=${s.sceneId} -->\n`);
    parts.push(`\n<!-- source-range:${s.start}:${s.end};kind=${s.kind};utf16 -->\n`,source.text.slice(s.start,s.end),'<!-- /source-range -->\n');
    priorEpisode=s.episodeId;priorScene=s.sceneId;priorKind=s.kind;
  }
  return parts.join('');
}
export function normalize(source,options={}) {
  if(typeof source==='string')source=createSource(source);
  const plan=options.plan??proposePlan(source,options);const validation=validatePlan(source,plan,options);
  if(!validation.ok)throw Object.assign(new Error('保真校验失败'),{validation});
  const segments=plan.segments.map(s=>({...s,text:source.text.slice(s.start,s.end),textHash:hash(source.text.slice(s.start,s.end))}));
  const episodes=[...new Set(segments.filter(s=>s.episodeId).map(s=>s.episodeId))].map((episodeId,index)=>{
    const selected=segments.filter(s=>s.episodeId===episodeId);const start=selected[0].start,end=selected.at(-1).end;
    const scenes=[...new Set(selected.filter(s=>s.sceneId).map(s=>s.sceneId))].map((sceneId,i)=>{
      const rows=selected.filter(s=>s.sceneId===sceneId);const a=rows[0].start,b=rows.at(-1).end;
      const decision=plan.decisions.find(d=>d.start<=a&&d.end>=b&&d.sceneNumber!==undefined);
      return {id:sceneId,number:i+1,sourceNumber:decision?String(decision.sceneNumber):rows[0].text.replace(/[\r\n]+$/,''),title:decision?`第${decision.sceneNumber}场`:rows[0].text.replace(/[\r\n]+$/,''),start:a,end:b,content:rows.map(s=>s.text).join(''),productionEligible:rows.some(s=>s.productionEligible)};
    });
    return {id:episodeId,number:index+1,sourceNumber:selected[0].sourceNumber,title:selected[0].text.replace(/[\r\n]+$/,''),start,end,content:selected.map(s=>s.text).join(''),productionEligible:selected.some(s=>s.productionEligible),segments:selected,scenes};
  });
  return {contractVersion:CONTRACT_VERSION,source,plan,validation,normalizedText:renderNormalized(source,plan,options),segments,episodes,contextText:segments.filter(s=>s.kind==='context').map(s=>s.text).join('')};
}
