import {digest,fail} from './core/shared.mjs';
import {isDirectorRefinement} from './core/director-refinement.mjs';
import {getRefinementBase,getRefinementComparison} from './core/refinement-comparison.mjs';
import {refinementScope} from './core/refinement-scope.mjs';
import {resolveSelection} from './core/selection.mjs';

// Local export only: no model scoring, external upload or request replay.
export function buildReviewPacket(d,{candidateId}={}){
 let base=d.assembly,candidate=null,op=null,comparison=null;
 if(candidateId){
  candidate=d.candidates.find(c=>c.id===candidateId&&isDirectorRefinement(c));
  op=candidate&&d.operations.find(o=>o.attemptId===candidate.attemptId&&isDirectorRefinement(o));
  const adopted=candidate?.adoptedRefinement,text=adopted?.text??candidate?.previewText,validation=adopted?.validation??candidate?.validation;
  if(!candidate||!op||!['refinement_ready','refinement_no_change','adopted'].includes(candidate.status)||typeof text!=='string'||!text||validation?.errors?.length)
   fail('REFINEMENT_CANDIDATE','未找到可对照的完整精修候选，基稿与原始记录仍保留。');
  base=getRefinementBase(d,candidate);
  if(!base)fail('REFINEMENT_STALE','当前基稿已变化，不能把无关稿件组装成审稿对照。');
  comparison=getRefinementComparison(d,candidate);
 }
 if(typeof base?.text!=='string'||!base.text||base.validation?.errors?.length!==0)fail('REFINEMENT_BASE_REQUIRED','尚无完整有效的对照基稿。');
 const unchanged=comparison?.status==='unchanged';
 const drafts=[{origin:'base',text:base.text},...(candidate&&!unchanged?[{origin:'candidate',text:candidate.adoptedRefinement?.text??candidate.previewText}]:[])];
 // Stable assignment avoids changing letters on repeat download; origin mapping
 // is returned to the authenticated caller but deliberately absent from the file.
 if(drafts.length===2&&parseInt(digest(candidate.id).slice(0,2),16)%2)drafts.reverse();
 const labels=drafts.map((draft,i)=>({label:String.fromCharCode(65+i),origin:draft.origin}));
 const paired=drafts.length===2,brief=d.source.context?.seriesDirection?.brief;
 const conditions=[['画风',d.settings.visualStyle],['单元容量',`${d.settings.maxUnitSeconds}秒（自然短尾不补齐）`],['幻想选择',d.choice?.mode||d.settings.fantasyMode],['用户创作要求',d.source.context?.directorNotes],['全剧采用方向',typeof brief==='string'&&brief.trim()?brief:'本任务未采用已确认全剧方向，冻结输入为空']];
 const source=d.source.sourceRows.map(row=>`${row.id} · ${row.text}`).join('\n');
 const selection=d.plan&&d.choice?resolveSelection(d.plan,d.choice):null;
 const selected=(d.plan?.fantasyCandidates||[]).filter(c=>selection?.selectedIds.includes(c.id)).map(c=>`${c.id} · ${c.subject} · ${c.emotionPurpose} · 原文锚：${(c.anchorRefs||[]).join('、')}`);
 const scope=candidate?refinementScope(d,{eventIds:op.refinement.eventIds,unitIds:op.refinement.unitIds,draft:base.draft}):null;
 const anchor=row=>row?`${row.id} · ${row.text}`:'冻结稿未提供可定位源锚';
 const scopeText=scope?[
  `范围：${scope.wholeEpisode?'全集':scope.unitCount?'局部':'无法定位冻结范围'}；${scope.unitCount} 单元 / ${scope.shotCount} 镜。`,
  `事件：${scope.events.map(e=>e.id).join('、')||'未定位'}；单元：${scope.unitIds.join('、')||'未定位'}。`,
  `原文首锚：${anchor(scope.sourceStart)}`,
  `原文尾锚：${anchor(scope.sourceEnd)}`,
 ].join('\n'):null;
 const differenceText=comparison?unchanged?'无（正文逐字符相同）。':comparison.changedUnitIds.length||comparison.changedShotIds.length
  ?`单元：${comparison.changedUnitIds.join('、')||'未定位'}；镜：${comparison.changedShotIds.join('、')||'未定位'}。`
  :'正文有差异，无法从已保存稿件定位具体坐标。':null;
 const text=[
  paired?'# 分镜脚本文本盲审材料':'# 分镜脚本文本审阅材料',
  '本材料供独立文本审阅，不是正式连续稿交付。未生成视频、未验证配音和实际画面；结构校验不等于创作质量。请按相同标准独立评估，不因项目目标或稿件顺序抬分。',
  ...(unchanged?['本次精修无改动/保留原稿，导出仅含一份原稿。']:[]),
  ...(candidate?.adoptedRefinement?.partial?['本次仅采用用户选中的完整关联修改组；对照稿包含实际采用内容，其余沿用冻结基稿。局部结构校验不证明表演收益或语义接缝，仍须人工审看。']:[]),
 ...(candidate?.adoptionBlocked||d.production?.boundaryCheck?.status==='PRELIMINARY'||d.web?.binding?.productionChain?.mode==='CHAIN'?['本次对照尚未完成实际跨集承接核对，不能把局部文字收益当成连续成片已验收。']:[]),
 ...(d.web?.sourceStale?['这是任务冻结原文下的历史对照，当前项目来源已变更，不代表已匹配新原文。']:[]),
 '## 同一创作条件',conditions.filter(([,v])=>v).map(([key,value])=>`- ${key}：${typeof value==='string'?value:JSON.stringify(value)}`).join('\n'),
 ...(selection?['本任务实际选入的额外幻想机会（不是每单元强加幻想；源要求另行保留）：\n'+(selected.join('\n')||'无')]:[]),
 ...(scope?['## 本次允许修改范围',scopeText,'## 实际差异坐标（不代表提升）',differenceText]:[]),
 '## 本集冻结原文',source,
 ...drafts.flatMap((draft,i)=>[`## 稿件 ${labels[i].label}`,draft.text]),
 '## 独立评价表（审阅人填写）',
  (paired?'先逐稿独立评阅，再比较。':'独立评阅本稿。')+'每个结论必须标单元/镜号、引用实际片段并说明对观众体验的影响；不以术语数量、文字长度、镜头数量或抽象夸张标签代替有效画面。未验证的视听效果记为待实测。',
  [
   `| 维度 | 重点 | 稿件 A（0–10） | ${paired?'稿件 B（0–10） | ':''}具体坐标与依据 |`,
   paired?'| --- | --- | --- | --- | --- |':'| --- | --- | --- | --- |',
   ...[
   ['原文保真与因果','原话、说者、行动结果、知情边界；不得用人物说法冒充事实'],
   ['情绪与爽感','压迫—反差—反击或关系变化是否可见；原有强峰有没有被削弱'],
   ['幻想与表演','具体、不同机制、有触发与退出；Q版不是套模版，幻想不越成现实'],
   ['关键变化与节奏','蓄势—骤变—命中—反应的速度分配；非逐镜2–5秒或强凑30秒'],
   ['语速与气口','整句自然连贯，快慢因内容而变；停顿有戏剧作用、不摊慢发声'],
   ['镜内动态与视听','身体/空间/摄影/声画确实带来信息变化，揭示音与画面命中'],
   ['执行性与连续性','画面能拍/能生成，状态与承接清楚；不以重复确认稀释推进'],
   ].map(([dimension,focus])=>`| ${dimension} | ${focus} | ${paired?'| ':''}| |`),
  ].join('\n'),
  paired?'请另填：整体文本质量（独立判断，不机械平均）：A ___ /10；B ___ /10。偏好 ___；不能接受的硬伤 ___；较弱稿仍更好的片段 ___；仍需实测项 ___。':'请另填：整体文本质量（独立判断，不机械平均）：A ___ /10；不能接受的硬伤 ___；仍需实测项 ___。',
 '各档评分须有实际片段依据，不依据系统内评、结构PASS或版本先后来判断质量。删改原话/因果、削弱关键强峰、制造新连续性冲突应单独列为退步，不能用其他项高分抵消。',
 ].join('\n\n')+'\n';
 return {text,labels};
}
