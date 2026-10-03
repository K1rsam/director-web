import type {VisualFact,VisualIssue} from './asset-visual-facts-contract';
import type {ApplicationScope} from './foundation-application-scope';
import type {AssetImageOptions} from './asset-image-options';
import type {AssetPromptAutomation} from './asset-prompt-automation';
export type PromptEvidence = { label: string; text: string };
/** Historical output only: never supplied as current source facts or referenceDesign. */
export type PreviousDesignAudit = {revision:number;body:string;facts:string;suggestions:string;rawOutput?:string;origin:'AI'|'MANUAL';updatedAt:string};
export type PromptAsset = {
  key: string; baseKey: string; name: string; baseName: string; type: 'CH' | 'GROUP' | 'BEAST' | 'LOC' | 'PROP';
  variant: boolean; episodes: number[]; mode: string; fromKey?: string; description: string; note: string;
  visualFacts?:VisualFact[]; visualIssues?:VisualIssue[]; evidence: PromptEvidence[]; reasons: string[]; eligible: boolean; fingerprint: string; sceneRefs?: {episode:number;sceneKey:string}[];
};
export type PromptRecord = {
  schema: 'ASSET_PROMPT_V1'; key: string; revision: number; status: 'EMPTY' | 'RUNNING' | 'READY' | 'FAILED';
  body: string; facts: string; suggestions: string; error: string; fingerprint: string;
  updatedAt: string; origin: 'AI' | 'MANUAL'; requestId?: string; rawOutput?: string; referenceKey?: string; referenceRevision?: number; workerPid?: number;
  previousDesignAudit?: PreviousDesignAudit[];
};
export type PromptWorkspace = {
  projectId: string; title: string; style: string; stylePrefix: string; styleRevision: number;
  seriesDirection?: {status:'CONFIRMED'|'UNCONFIRMED'|'STALE'; brief:string|null; cardHash?:string};
  visualFactsStatus?:'MISSING'|'READY'|'REVIEW'; visualFactIssues?:VisualIssue[]; assets: PromptAsset[]; records: Record<string, PromptRecord>; busy: boolean; imageOptions?:Record<string,AssetImageOptions>;automation?:AssetPromptAutomation;
};
export function composeAssetPrompt(prefix: string, body: string) {
  return [prefix.trim(), body.trim()].filter(Boolean).join('，\n');
}
export function selectAssetPromptDecisions<T extends {applicationScope:ApplicationScope}>(conditions:T[],asset:Pick<PromptAsset,'episodes'|'sceneRefs'>):T[] {
 return conditions.filter(({applicationScope:s})=>s.kind==='GLOBAL'||s.kind==='EPISODES'&&s.episodes.some(n=>asset.episodes.includes(n))||s.kind==='SCENES'&&s.scenes.some(ref=>asset.sceneRefs?.some(a=>a.episode===ref.episode&&a.sceneKey===ref.sceneKey)));
}
export function defaultStylePrefix(style: string) {
  return /3D|三维/i.test(style) ? '3D国漫风格，国风三维动画渲染，清晰细腻的材质，统一美术设计' : style === '未选择' || !style.trim() ? '' : style.trim();
}
export function promptNeedsReview(asset: PromptAsset, records: Record<string, PromptRecord>, assets: PromptAsset[], seen = new Set<string>()): boolean {
  const record=records[asset.key];if(!record?.body)return false;
  if(record.status!=='READY')return true;
  if(seen.has(asset.key))return true;seen.add(asset.key);
  if(record.fingerprint!==asset.fingerprint)return true;
  if(!record.referenceKey)return false;
  const source=assets.find(a=>a.key===record.referenceKey), sourceRecord=records[record.referenceKey];
  return !source||!sourceRecord?.body||sourceRecord.status!=='READY'||sourceRecord.revision!==record.referenceRevision||promptNeedsReview(source,records,assets,seen);
}
export function emptyPrompt(key: string): PromptRecord {
  return { schema: 'ASSET_PROMPT_V1', key, revision: 0, status: 'EMPTY', body: '', facts: '', suggestions: '', error: '', fingerprint: '', updatedAt: '', origin: 'MANUAL' };
}
export function validatePromptOutput(value: Record<string, unknown>, expectedKey: string) {
  if (value.key !== expectedKey) throw new Error('返回的资产编号不匹配，已保留原始结果。');
  for (const field of ['body', 'suggestions']) if (typeof value[field] !== 'string' || (value[field] as string).length > 14000) throw new Error(`返回的 ${field} 字段无效，已保留原始结果。`);
  if (value.facts !== undefined && (typeof value.facts !== 'string' || value.facts.length > 14000)) throw new Error('返回的 facts 字段无效，已保留原始结果。');
  if (!(value.body as string).trim()) throw new Error('模型没有返回外观提示词，已保留原始结果。');
  return { body: (value.body as string).trim(), facts: typeof value.facts === 'string' ? value.facts.trim() : '', suggestions: (value.suggestions as string).trim() };
}
