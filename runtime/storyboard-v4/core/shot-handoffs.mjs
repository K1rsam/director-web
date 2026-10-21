import {digest,fail} from './shared.mjs';

export const SHOT_HANDOFF_VERSION='shot-handoffs-v1';
export const SHOT_HANDOFF_HINT='editingHandoffs是当前previousDraft的只读切点索引，不是合格判定或待填成品字段。按outgoing/incoming的unitIndex、shotIndex直接读previousDraft.units[unitIndex].shots[shotIndex]的picture/camera/transition及sound/dialogueParts；segmentIndexes指向该unit.segments的原分段头，[]时读原单元头。覆盖全部cutPairs，包括合并后的内部接点。先按源判断是同次动态连续、对白视线/落词/J-L声接、换场跳时、有据省略或主观回接，再判断是否需改。动态接点必须由前镜picture/transition与后镜picture/camera实际写出同一次动作的切断相位与继续相位，按风险读清方向、轨迹、接触或余势；出画还核离画边、稳定空间去向、下一入画/落点与未完过程。遮住initialState/exitState和动作顺接等口号仍须读得懂；不新增命中/伤势/能力，不补站稳或重演。缺口按现有issues/revisionNotes定位并联修两端完整单元；只填状态/备注不关闭。分组先按真实15/30秒容量联排同一完整对话/攻防/动作，不按10/15秒习惯截断，保留自然短尾与真实时空边界。原话声窗及主观域仍分别核对，不把所有切点硬做动作匹配。';

const headers=['title','unitDirection','scene','props','participants','visualSubjects','lighting','initialState','exitState','boundaryBefore'];
const segments=(unit,shot)=>Array.isArray(unit.segments)?unit.segments.flatMap((s,i)=>Array.isArray(s?.shotIds)&&s.shotIds.includes(shot.id)?[i]:[]):[];

// Only deterministic adjacency and locations: all semantic judgments stay with the existing editor/reviewer.
// The full work is already delivered once in previousDraft; never repeat it in the model input.
export function buildShotHandoffs(draft){
 // A malformed paid response still belongs to the existing format-repair route; it cannot prove adjacency.
 if(!Array.isArray(draft?.units)||draft.units.some(u=>!u||!Array.isArray(u.shots)||!u.shots.length||u.shots.some(s=>!s||typeof s!=='object'||Array.isArray(s))||u.segments!==undefined&&(!Array.isArray(u.segments)||u.segments.some(s=>!s||!Array.isArray(s.shotIds))||u.segments.length&&u.shots.some(s=>u.segments.filter(part=>part.shotIds.includes(s.id)).length!==1))))return null;
 const shots=(draft?.units||[]).flatMap((u,unitIndex)=>(u.shots||[]).map((s,shotIndex)=>({unitIndex,shotIndex,unitId:u.id,shotId:s.id,segmentIndexes:segments(u,s)})));
 return {version:SHOT_HANDOFF_VERSION,inputSha256:digest(draft),advisoryOnly:true,cutPairs:shots.slice(1).map((incoming,i)=>{
  const outgoing=shots[i],crossUnit=outgoing.unitIndex!==incoming.unitIndex;
  return {outgoing,incoming,boundary:crossUnit?'unit':digest(outgoing.segmentIndexes)!==digest(incoming.segmentIndexes)?'segment':'shot',...(crossUnit?{boundaryBefore:structuredClone(draft.units[incoming.unitIndex].boundaryBefore??null)}:{})};
 })};
}

// Resolve against the exact saved work; changed text, headers, ordering or tampered locations invalidate the evidence.
export function resolveShotHandoffs(draft,evidence){
 if(!evidence||digest(evidence)!==digest(buildShotHandoffs(draft)))fail('SHOT_HANDOFF_STALE','切点取证与当前镜文或坐标不一致，请按当前稿重新取证');
 const endpoint=location=>{
  const unit=draft.units[location.unitIndex],shot=unit.shots[location.shotIndex];
  return {...location,shot:structuredClone(shot),segmentHeaders:(location.segmentIndexes.length?location.segmentIndexes.map(i=>unit.segments[i]):[unit]).map(part=>structuredClone(Object.fromEntries(headers.filter(k=>Object.hasOwn(part,k)).map(k=>[k,part[k]]))))};
 };
 return evidence.cutPairs.map(pair=>({...pair,outgoing:endpoint(pair.outgoing),incoming:endpoint(pair.incoming)}));
}

export function renderShotHandoffs(draft){
 const evidence=buildShotHandoffs(draft);
 if(!evidence)return '当前稿件结构未完整，未生成切点取证；沿用既有格式返修，不判定语义连续。';
 const pairs=resolveShotHandoffs(draft,evidence);
 const body=pairs.map(pair=>{
  const show=(side,label)=>[`${label} ${side.unitId} / ${side.shotId}`,`机位/运镜：${side.shot.camera??''}`,`画面：${side.shot.picture??''}`,`声音：${side.shot.sound??''}`,`原话声窗：${JSON.stringify(side.shot.dialogueParts??[])}`,`转场：${side.shot.transition??''}`,`原分段头：${JSON.stringify(side.segmentHeaders)}`].join('\n');
  return [`### ${pair.outgoing.shotId} → ${pair.incoming.shotId}（${pair.boundary}）`,...(pair.boundaryBefore?[`原边界：${JSON.stringify(pair.boundaryBefore)}`]:[]),show(pair.outgoing,'切出'),show(pair.incoming,'切入')].join('\n\n');
 }).join('\n\n');
 return `只读切点取证；inputSha256=${evidence.inputSha256}。相邻不等于同次动作，结构齐全不等于语义连续。按实际两端镜文和源依据判断，缺陷交现有整编联修；换场、跳时、对白声接、省略与主观回接分别核对。\n\n${body}`;
}
