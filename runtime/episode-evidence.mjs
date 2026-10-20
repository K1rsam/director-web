/** Retrieval only. Signals select candidates; they never establish identity, truth or persistence. */
import {digest,fail} from './storyboard-v4/core/shared.mjs';
export const EPISODE_EVIDENCE_VERSION='episode-evidence-v1';
export const EPISODE_HISTORY_POLICY_VERSION='episode-history-focused-v2';
// A broad recall gate for state, identity, knowledge, relationships and their counterevidence.
// Keep every matching occurrence, not just the latest: a release, lie or flashback can reverse it.
const signal=/受伤|伤口|绷带|骨折|固定|纱|石膏|疤|残缺|断臂|吊臂|拆掉|痊愈|治好|恢复|换上|换下|脱下|穿着|交给|递给|归还|拿回|收回|持有|藏起|钥匙|身份|真实|冒充|其实是|原来是|监察员|父亲|母亲|姐姐|哥哥|弟弟|妹妹|兄弟|姐妹|夫妻|师父|师徒|父子|母子|恋人|婚约|分手|背叛|知道|不知|得知|知情|发现|识破|记忆|忘记|秘密|真相|密码|隐瞒|揭示|告知|告诉|进化|觉醒|解锁|融合|变成|形态|获得|失去|绑定|主人|契约|只能|无法|不能|解除|死亡|复活|消失|复原|不再|仍然|仍旧|已经|(?:identity|injur|heal|recover|reveal|secret|remember|forget)/iu;
// Ordinary genre words and generic verbs are not a state ledger. Specific
// persistent-state/release clues remain candidates, never automatic current facts.
const focusedSignal=/受伤|伤口|绷带|骨折|石膏|疤|残缺|断臂|吊臂|拆掉|痊愈|治好|换上|换下|脱下|穿着|交给|递给|归还|拿回|收回|持有|藏起|钥匙|身份|冒充|其实是|原来是|监察员|父亲|母亲|姐姐|哥哥|弟弟|妹妹|夫妻|师父|师徒|父子|母子|恋人|婚约|分手|背叛|知情|失忆|忘记|秘密|真相|密码|隐瞒|进化(?:为|成)|变成|融合(?:为|成)|绑定|主人|契约|死亡|复活|宿主可通过|蓝星灵气.*复苏|永久|(?:identity|injur|heal|reveal|secret|forget)/iu;
const baseKeys=new Set(['id','subjects','kind','statement','evidence','claim','applicability','validity','contextUse','contextRef','contextRefs','contextEvidence','candidateUse','currentApplicability','retrieval']);
const overlap=(a,b)=>a.start<b.end&&b.start<a.end;
/** Return IDs only; keep source text, claims, chronology and validity unchanged. */
export function selectEpisodeEvidence(facts,{scope,relevant=()=>true,requestedEvidence=[],historyPolicy=null}={}){
 const recall=historyPolicy===EPISODE_HISTORY_POLICY_VERSION?focusedSignal:signal;
 const first=Math.min(...scope),past=facts.filter(f=>f.evidence?.domain==='EPISODE'&&f.evidence.episode<first&&f.kind!=='FORMAT');
 const previous=past.reduce((n,f)=>Math.max(n,f.evidence.episode),-1),anchors=new Set();
 for(const f of past){
  const requested=requestedEvidence.some(e=>e.domain==='EPISODE'&&e.episode===f.evidence.episode&&overlap(e,f.evidence));
  const opaque=Object.keys(f).some(k=>!baseKeys.has(k));
  const sourceCandidate=f.claim==='SOURCE'&&f.kind!=='UTTERANCE';
  // Ordinary actions/headings are not a useful long-term state ledger. This is
  // candidate recall, not semantic proof of irrelevance: omitted events remain
  // available through free targeted reads, and known/opaque state data stays.
  if(requested||opaque||sourceCandidate&&!f.subjects.length&&recall.test(f.statement??'')||relevant(f)&&(f.evidence.episode===previous||f.validity?.status==='EXPLICIT'
   ||['STATE','IDENTITY','RELATION'].includes(f.kind)||recall.test(f.statement??'')))anchors.add(f.id);
 }
 // Include neighbouring complete source lines, not character-count clips. Sort coordinates
 // only for lookup; output stays in the original order and neighbours do not acquire authority.
 const ordered=[...facts].filter(f=>f.evidence?.domain==='EPISODE'&&f.evidence.episode<first)
  .sort((a,b)=>a.evidence.episode-b.evidence.episode||a.evidence.start-b.evidence.start);
 const neighbours=new Map();
 for(const [at,f] of ordered.entries())if(anchors.has(f.id))for(const n of [ordered[at-1],ordered[at+1]]){
  if(n&&n.evidence.episode===f.evidence.episode&&n.kind!=='FORMAT')neighbours.set(n.id,[...(neighbours.get(n.id)||[]),f.id]);
 }
 return {anchors,neighbours,kept:new Set([...anchors,...neighbours.keys()])};
}

export function historicalSourceRequest(target,currentEpisode){
 if(typeof target!=='string'||!target.startsWith('HISTORY_SOURCE:'))return null;
 const match=/^HISTORY_SOURCE:([1-9]\d*)(?::(0|[1-9]\d*):(0|[1-9]\d*))?$/.exec(target);
 const episode=Number(match?.[1]),start=match?.[2]===undefined?null:Number(match[2]),end=match?.[3]===undefined?null:Number(match[3]);
 if(!match||!Number.isSafeInteger(currentEpisode)||!Number.isSafeInteger(episode)||episode>=currentEpisode)
  fail('HISTORY_SOURCE_TARGET','历史补读只能指定本集之前的实际集号，不能读取未来集或文件路径。');
 if(start!==null&&(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start))fail('HISTORY_SOURCE_RANGE','历史补读范围无效。');
 return {episode,start,end};
}

/** Free, exact source retrieval. Never summarize, infer a state, or manufacture a rule. */
export function buildHistoricalSourceMaterial(target,episode,currentEpisode){
 const request=historicalSourceRequest(target,currentEpisode);
 if(!request||episode?.number!==request.episode||typeof episode.content!=='string'||!episode.content.trim())
  fail('HISTORY_SOURCE_TARGET','历史补读来源不存在或集号不匹配。');
 let start=0,end=episode.content.length;
 if(request.start!==null){
  if(request.end>end)fail('HISTORY_SOURCE_RANGE','历史补读范围超出原文。');
  const lines=[...episode.content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(m=>m[0].length)
   .filter(m=>m.index<request.end&&m.index+m[0].length>request.start);
  if(!lines.length)fail('HISTORY_SOURCE_RANGE','历史补读范围未命中原文。');
  start=lines[0].index;end=lines.at(-1).index+lines.at(-1)[0].length;
 }
 const sourceRange={start,end},text=episode.content.slice(start,end);
 const value={schema:'HISTORICAL_SOURCE_V1',target,episode:episode.number,sourceVersion:digest({episode:episode.number,sourceRange,text}),offsetUnit:'UTF16',
  sourceRange,text,selectionKind:request.start===null?'FULL_EPISODE':'WHOLE_SOURCE_LINES',
  applicability:'UNVERIFIED_HISTORY',authorityRule:'历史原文证据，不是本集状态或设计；对白保留为角色主张，闪回、幻想及未解除状态须核对本集适用性。不补演或重念前情。'};
 return {id:`history:${target}`,kind:'SOURCE_EVIDENCE',value,version:digest(value)};
}

/** Reuse the material/version ledger. Read only explicitly requested or previously supplied episodes. */
export async function loadHistoricalSourceMaterials({version,currentEpisode,needs=[],materials=[],existing=[],readEpisode}){
 if(version!==EPISODE_EVIDENCE_VERSION)return materials;
 const targets=new Set([...existing.filter(m=>m.kind==='SOURCE_EVIDENCE'&&m.value?.schema==='HISTORICAL_SOURCE_V1').map(m=>m.value.target),
  ...needs.filter(n=>n.stage===1&&!n.resolved&&typeof n.target==='string'&&n.target.startsWith('HISTORY_SOURCE:')).map(n=>n.target)]);
 const episodes=new Map(),result=new Map(materials.map(m=>[m.id,m]));
 for(const target of targets){
  const request=historicalSourceRequest(target,currentEpisode);
  if(!episodes.has(request.episode))episodes.set(request.episode,await readEpisode(request.episode));
  const packageIds=[...new Set([...existing.filter(m=>m.kind==='SOURCE_EVIDENCE'&&m.value?.target===target).flatMap(m=>m.packageIds??[]),
    ...needs.filter(n=>n.stage===1&&n.target===target).flatMap(n=>n.packageIds??[])])];
  const material=buildHistoricalSourceMaterial(target,episodes.get(request.episode),currentEpisode);
  result.set(material.id,{...material,packageIds});
 }
 return [...result.values()];
}
