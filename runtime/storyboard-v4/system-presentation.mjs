import {fail} from './core/shared.mjs';

export const SYSTEM_PRESENTATION_VERSION='SYSTEM_PRESENTATION_V1';
export const SYSTEM_PRESENTATION_HINT='systemPresentation为同版已确认的逐系统呈现决定，不是世界事实或额外幻想开关。分别核身份、真实源载体、出现/提示/反应/退出与可见听触；原文明示实体和外观优先，sourceCarrier未登记不证明不存在，冲突只提最小待定，不私改设定。系统必要提示与原有载体不因fantasy off消失；选择精灵不把系统音变为画内嘴部对白，不新增台词、声源voiceBindings、能力或他人互动。纯观众/主观化身不得当现实participants，实际主观主体沿visualSubjects；屏幕内容只取源中当拍有效信息，额外字幕仍需独立许可。设计偏好不是逐镜兑现，主创和整编须写清实际载体、提示、人物反应与进退，不只重复模式标签；原系统声道、逐字台词、揭示与源事实不动。';
const modes=['HUD','SPRITE','VOICE_ONLY','SYMBOLIC','MIXED','CUSTOM','PRESERVE_SOURCE'];
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=(x,max=240,quote=false)=>typeof x==='string'&&x.trim()===x&&x.length>0&&[...x].length<=max&&!(quote?/[\u0000-\u0009\u000b\u000c\u000e-\u001f]/:/[\r\n\u0000-\u001f]/).test(x);
const reject=()=>fail('UPSTREAM_SYSTEM_PRESENTATION','系统呈现的版本、身份、源引文或权限投影无效，未以缺省载体继续');

/** Transport validation, not a semantic classifier of whether the source defines an entity. */
export function readSystemPresentationProjection(value,direction,episode){
 if(!record(value)||value.schemaVersion!==SYSTEM_PRESENTATION_VERSION||!Array.isArray(value.systems)||value.systems.length>8||!text(value.policy,2000))reject();
 if(!value.systems.length)return null;
 if(!text(direction?.id,200)||!Number.isSafeInteger(direction.revision)||direction.revision<1||!text(direction.sourceVersion,200)||!/^[a-f0-9]{64}$/.test(direction.cardHash))reject();
 const seen=new Set(),identities=new Set();
 const evidence=ref=>{
  if(!record(ref)||!text(ref.evidenceId,200)||!text(ref.quote,240,true)||!text(ref.episodeId,200)||!['CURRENT_EPISODE_EVIDENCE','PRIOR_EVIDENCE'].includes(ref.timing)
   ||(ref.timing==='CURRENT_EPISODE_EVIDENCE')!==(ref.episodeId===episode.id)||ref.timing==='CURRENT_EPISODE_EVIDENCE'&&!episode.content.includes(ref.quote))reject();
  return {evidenceId:ref.evidenceId,quote:ref.quote,episodeId:ref.episodeId,timing:ref.timing};
 };
 const systems=value.systems.map(s=>{
  if(!record(s)||!text(s.id,80)||seen.has(s.id)||!text(s.identity,80)||identities.has(s.identity)||!modes.includes(s.mode)
   ||s.carrierNotes!==null&&!text(s.carrierNotes,180)||!Array.isArray(s.sourceEvidence)||!s.sourceEvidence.length||s.sourceEvidence.length>4
   ||!['SOURCE_ONLY','AUDIENCE_ONLY','UNRESOLVED'].includes(s.visibility)||!['SOURCE_ONLY','NO_ADDED_SOUND','UNRESOLVED'].includes(s.audibility)
   ||!['SOURCE_ONLY','NO_ADDED_CONTACT','UNRESOLVED'].includes(s.contact)||s.originalVoice!=='PRESERVE_SOURCE'||!['SOURCE_ONLY','NO_ADDED_TEXT'].includes(s.screenText))reject();
  seen.add(s.id);identities.add(s.identity);const sourceEvidence=s.sourceEvidence.map(evidence);
  if(new Set(sourceEvidence.map(x=>JSON.stringify(x))).size!==sourceEvidence.length)reject();
  const sourceCarrier=s.sourceCarrier===null?null:{...evidence(s.sourceCarrier),mode:s.sourceCarrier.mode};
  if(sourceCarrier&&(!modes.includes(sourceCarrier.mode)||sourceCarrier.mode==='PRESERVE_SOURCE'||s.mode!=='PRESERVE_SOURCE'&&s.mode!==sourceCarrier.mode))reject();
  return {id:s.id,identity:s.identity,mode:s.mode,carrierNotes:s.carrierNotes,sourceEvidence,sourceCarrier,sourceCarrierStatus:sourceCarrier?'EXPLICIT_SOURCE_QUOTE':'UNRESOLVED_SOURCE_FIRST',visibility:s.visibility,audibility:s.audibility,contact:s.contact,originalVoice:s.originalVoice,screenText:s.screenText};
 });
 return {schemaVersion:SYSTEM_PRESENTATION_VERSION,decision:{id:direction.id,revision:direction.revision,sourceVersion:direction.sourceVersion,cardHash:direction.cardHash},systems,policy:SYSTEM_PRESENTATION_HINT};
}
