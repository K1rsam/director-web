import { createHash } from 'node:crypto';
export const CONTRACT_VERSION = 'fidelity/5';
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
const separatedTime=/(?:^|[\s,，、/／|｜])(?:日|夜|昼|晨|黄昏|清晨|凌晨|傍晚|白天|夜晚)(?=$|[\s,，、/／|｜])/;
const separatedInterior=/(?:^|[\s,，、/／|｜])(?:内|外|内景|外景|INT\.?|EXT\.?)(?=$|[\s,，、/／|｜])/i;
const metadataOnly=text=>text.length<=160&&!/[：:△▲。！？!?“”「」]/.test(text)&&separatedTime.test(text)&&separatedInterior.test(text);
function hasSceneMetadata(text) {
  // Retain the existing whitespace grammar. The new punctuation grammar is
  // narrower: an explicit separator, time AND interior/exterior, no prose.
  return /(?:^|\s)(?:日|夜|昼|晨|黄昏|清晨|凌晨|傍晚|白天|夜晚|内|外|内景|外景|INT\.?|EXT\.?)(?=\s|$)/i.test(text)
    || /^[\s,，、/／|｜]/.test(text)&&/[,，、/／|｜]/.test(text)&&metadataOnly(text);
}
function canonical(source, options={}, groupBoundaryIssues=true) {
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
  const episodePattern=/^(?:#{1,6}\s*)?第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*集(?:\s|[：:｜|—-]|$)(.*)$/;
  const contextPattern=/^(?:#{1,6}\s*)?(?:【)?(?:作者资料|故事大纲|人物小传|人物设定|世界观设定|背景资料|附录)(?:】)?(?:\s|[：:｜|]|$)/;
  const nonempty=rows.filter(r=>r.text.trim());
  const firstText=nonempty[0]?.text.trim()??'';
  let afterZeroHeadings=1;
  while(afterZeroHeadings<nonempty.length){
    const heading=nonempty[afterZeroHeadings].text.trim().match(episodePattern);
    if(!heading || !/^[零〇0]+$/.test(heading[1]) || heading[2].trim())break;
    afterZeroHeadings++;
  }
  const contextStart=nonempty[1],contextField=nonempty[afterZeroHeadings];
  const confirmedContext=!!(contextStart && contextField && decisionsCopy.some(d=>d.kind==='context' && d.start<=contextStart.start && d.end>=contextField.end));
  const titleBeforeContext=firstText.length<=60 && !/[。！？!?“”「」△]/.test(firstText) && !episodePattern.test(firstText) && !contextPattern.test(firstText) && afterZeroHeadings>1 && (contextPattern.test(contextField?.text.trim()??'') || confirmedContext);
  const numberValue=value=>{if(/^\d+$/.test(value))return Number(value);let total=0,digit=0;for(const c of value){const n='零一二三四五六七八九'.indexOf(c);if(n>=0)digit=n;else if(c==='〇')digit=0;else if(c==='两')digit=2;else if(c==='十'||c==='百'||c==='千'){total+=(digit||1)*({十:10,百:100,千:1000}[c]);digit=0;}else return NaN;}return total+digit;};
  const headings=rows.flatMap(row=>{const ep=row.text.trim().match(episodePattern);return ep?[{start:row.start,number:numberValue(ep[1])}]:[];});
  const decisionEpisode=d=>{
    const heading=headings.find((h,i)=>h.number===d.episodeNumber && d.start<(headings[i+1]?.start??source.length) && d.end>h.start);
    if(heading)return `episode:${source.sourceVersion}:${heading.start}`;
    return `episode:${source.sourceVersion}:decision:${decisionsCopy.find(p=>p.episodeNumber===d.episodeNumber).start}`;
  };
  let episodeId=null,sceneId=null,sourceNumber=null,context=false;
  const issues=[],segments=[],seen=new Set(),decisionScenes=new Map(),continuedSceneHeaders=new Set();
  let openBoundaryIssue=null;
  for (const [rowIndex,row] of rows.entries()) {
    const t=row.text.replace(/[\r\n]+$/,'').trim();
    const ep=t.match(/^(?:#{1,6}\s*)?第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*集(?:\s|[：:｜|—-]|$)(.*)$/);
    const nextText=ep && numberValue(ep[1])===0 ? rows.slice(rowIndex+1).find(r=>r.text.trim())?.text.trim()??'' : '';
    const zeroContext=!!(ep && numberValue(ep[1])===0 && !ep[2].trim() && contextPattern.test(nextText));
    const ctx=contextPattern.test(t) || !!(ep && /作者资料|故事大纲|人物小传|人物设定|世界观设定|背景资料|前言/.test(ep[2])) || zeroContext;
    const prologue=/^(?:#{1,6}\s*)?(?:序章|序幕)(?:\s|[：:｜|]|$)/.test(t);
    // Numeric pairs require scene metadata; bare scores and prices remain body text.
    const pair=t.match(/^(?:#{1,6}\s*)?\d+\s*[-－.．]\s*\d+(?![\d.．])(.*)$/);
    const sceneMetadata=pair && hasSceneMetadata(pair[1]);
    // A combined episode/scene declaration still owns one complete source line.
    // Search only a short, non-dialogue episode title prefix, never arbitrary body text.
    const combined=ep?.[2].match(/^(.*?)\s*场\s*(\d+)\s*[-－.．]\s*(\d+)(?![\d.．])(.*)$/);
    const inlineTagged=combined&&combined[1].length<=80&&!/[。！？!?“”「」△:：]/.test(combined[1])?[combined[0],combined[2],combined[3],combined[4]]:null;
    const tagged=ep?inlineTagged:t.match(/^(?:#{1,6}\s*)?场\s*(\d+)\s*[-－.．]\s*(\d+)(?![\d.．])(.*)$/);
    const taggedMetadata=tagged&&Number(tagged[2])>0&&hasSceneMetadata(tagged[3]);
    const currentNumber=ep?numberValue(ep[1]):sourceNumber===null?NaN:numberValue(sourceNumber);
    // Some scripts repeat only the episode number before explicit time / side /
    // location fields. This declares an unnumbered scene, not a fabricated N.1.
    const episodeMetadata=t.match(/^(?:#{1,6}\s*)?(\d+)(?:\s+|[,，、]\s*)(.+)$/);
    const fields=episodeMetadata?.[2].trim().split(/[\s,，、/／|｜]+/)??[];
    const timeField=value=>/^(?:日|夜|昼|晨|黄昏|清晨|凌晨|傍晚|白天|夜晚)$/.test(value);
    const interiorField=value=>/^(?:内|外|内景|外景|INT\.?|EXT\.?)$/i.test(value);
    const episodeMetadataOnly=episodeMetadata&&metadataOnly(episodeMetadata[2])&&fields.length>=3
      &&(timeField(fields[0])&&interiorField(fields[1])||interiorField(fields[0])&&timeField(fields[1]));
    const unnumberedScene=episodeMetadataOnly&&Number.isFinite(currentNumber)&&Number(episodeMetadata[1])===currentNumber;
    // Bare hyphen scene numbers require a separate, explicit metadata-only line.
    // Keep both complete source lines intact; decimals/scores and dialogue are not evidence.
    const bare=t.match(/^(?:#{1,6}\s*)?(?:场\s*)?(\d+)\s*[-－]\s*(\d+)\s*[:：]?$/);
    const following=bare?rows.slice(rowIndex+1).find(r=>r.text.trim()):null;
    const followingText=following?.text.trim()??'';
    const separateMetadata=bare&&Number(bare[2])>0&&!episodePattern.test(followingText)&&metadataOnly(followingText);
    const separateScene=separateMetadata&&Number(bare[1])===currentNumber;
    if(separateScene)continuedSceneHeaders.add(following.start);
    const taggedMismatch=(taggedMetadata&&Number.isFinite(currentNumber)&&Number(tagged[1])!==currentNumber)||(separateMetadata&&Number.isFinite(currentNumber)&&Number(bare[1])!==currentNumber)||(episodeMetadataOnly&&Number.isFinite(currentNumber)&&Number(episodeMetadata[1])!==currentNumber);
    const taggedScene=taggedMetadata&&Number(tagged[1])===currentNumber;
    const inlineBody=taggedScene&&(/(?:人物|出场人物)\s*[:：]|[△▲]/.test(tagged[3])||labels(tagged[3]).length>0);
    const scene=separateScene || taggedScene || sceneMetadata || unnumberedScene || t.match(/^(?:#{1,6}\s*)?(?:第\s*([零〇一二三四五六七八九十百\d]+)\s*场(?:\s|[：:｜|]|$)|([零〇一二三四五六七八九十百\d]+)[.．、]\s+(?!\d)\S)/);
    // An explicit location label is a scene boundary without an authored number.
    // Keep its exact label in the source slice; normalized scene ordinals are view data.
    const locationLabel=t.match(/^(?:#{1,6}\s*)?场景(?:\s*[:：]\s*|\s+)(\S.*)$/);
    const labeledScene=!!(locationLabel && locationLabel[1].length<=160 && !/[：:△▲。！？!?“”「」]/.test(locationLabel[1]));
    let kind='body',reason='locked_source_line';
    if (ep || prologue) {
      episodeId=`episode:${source.sourceVersion}:${row.start}`;sceneId=null;sourceNumber=ep?ep[1]:'序章';context=ctx;
      if(seen.has(sourceNumber))issues.push({code:'DUPLICATE_EPISODE_NUMBER',start:row.start,end:row.end,message:'原集号重复，保留两处来源，需核对页眉或异稿'});
      seen.add(sourceNumber);kind='format';reason='explicit_episode_heading';
    }
    if(ctx){context=true;episodeId=null;sceneId=null;sourceNumber=null;kind='context';reason='explicit_context_heading';}
    else if(context){kind='context';reason='context_section';}
    else if(scene||labeledScene){sceneId=`scene:${source.sourceVersion}:${row.start}`;kind=inlineBody?'body':'format';reason=inlineBody?'inline_scene_body':'explicit_scene_heading';}
    if(taggedMismatch&&!context){sceneId=null;kind='body';reason='scene_episode_mismatch';issues.push({code:'SCENE_EPISODE_MISMATCH',start:row.start,end:row.end,message:'场号所属集与当前集标题不一致；原文保留，未将错集场号自动归入当前集'});}
    if(!t&&!context){kind='format';reason='source_whitespace';}
    if(continuedSceneHeaders.has(row.start)&&!context){kind='format';reason='continued_scene_metadata';}
    if(titleBeforeContext && row.start===nonempty[0].start){kind='context';reason='document_title_before_context';}
    const decision=decisionsCopy.find(d=>d.start<=row.start&&d.end>=row.end);
    if(decision?.sceneNumber!==undefined && scene && row.start===decision.start && sceneId)decisionScenes.set(decision.start,sceneId);
    if(decision){kind=decision.kind;reason='user_boundary_decision';}
    const effectiveEpisode=decision?.episodeNumber!==undefined?decisionEpisode(decision):episodeId;
    const effectiveScene=decision?.sceneNumber!==undefined?(decisionScenes.get(decision.start)??`scene:${source.sourceVersion}:decision:${decision.start}`):sceneId;
    if(kind==='body'&&(!effectiveEpisode||!effectiveScene)) {
      // Report one continuous unassigned body range, not one identical error per
      // source line. Any non-body row, episode change or different issue breaks it.
      const code=effectiveEpisode?'SCENE_BOUNDARY_UNCONFIRMED':'BOUNDARY_UNCONFIRMED';
      if(groupBoundaryIssues&&openBoundaryIssue?.episodeId===effectiveEpisode&&openBoundaryIssue.issue.code===code&&openBoundaryIssue.issue.end===row.start&&issues.at(-1)===openBoundaryIssue.issue)openBoundaryIssue.issue.end=row.end;
      else {
        const issue={code,start:row.start,end:row.end,message:effectiveEpisode?'正文已保留并属于当前集；尚无明确场界，请确认场范围或采用整集一场':'正文已保留；所属集场待确认'};
        issues.push(issue);openBoundaryIssue={episodeId:effectiveEpisode,issue};
      }
    } else openBoundaryIssue=null;
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
  // For this contract's exact source bindings, accept only the fully recomputed
  // grouped or per-line diagnostic representation. Older contracts are verified
  // by frozen validators before upgrade; segment semantics never use this fallback.
  if(!same(plan.issues,expected.issues)&&!same(plan.issues,canonical(fresh,options,false).issues))fail('ISSUES_CHANGED','疑点不得删改，须通过新的用户决定解决');
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
  const submitted=options.plan??proposePlan(source,options);const validation=validatePlan(source,submitted,options);
  if(!validation.ok)throw Object.assign(new Error('保真校验失败'),{validation});
  const plan=same(submitted.issues,validation.issues)?submitted:{...submitted,issues:validation.issues};
  const segments=plan.segments.map(s=>({...s,text:source.text.slice(s.start,s.end),textHash:hash(source.text.slice(s.start,s.end))}));
  let productionNumber=0;
  const episodes=[...new Set(segments.filter(s=>s.episodeId).map(s=>s.episodeId))].map((episodeId,index)=>{
    const selected=segments.filter(s=>s.episodeId===episodeId);const start=selected[0].start,end=selected.at(-1).end;
    const scenes=[...new Set(selected.filter(s=>s.sceneId).map(s=>s.sceneId))].map((sceneId,i)=>{
      const rows=selected.filter(s=>s.sceneId===sceneId);const a=rows[0].start,b=rows.at(-1).end;
      const decision=plan.decisions.find(d=>d.start<=a&&d.end>=b&&d.sceneNumber!==undefined);
      return {id:sceneId,number:i+1,sourceNumber:decision?String(decision.sceneNumber):rows[0].text.replace(/[\r\n]+$/,''),title:decision?`第${decision.sceneNumber}场`:rows[0].text.replace(/[\r\n]+$/,''),start:a,end:b,content:rows.map(s=>s.text).join(''),productionEligible:rows.some(s=>s.productionEligible)};
    });
    return {id:episodeId,number:selected.some(s=>s.productionEligible)?++productionNumber:0,sourceNumber:selected[0].sourceNumber,title:selected[0].text.replace(/[\r\n]+$/,''),start,end,content:selected.map(s=>s.text).join(''),productionEligible:selected.some(s=>s.productionEligible),segments:selected,scenes};
  });
  return {contractVersion:CONTRACT_VERSION,source,plan,validation,normalizedText:renderNormalized(source,plan,options),segments,episodes,contextText:segments.filter(s=>s.kind==='context').map(s=>s.text).join('')};
}
