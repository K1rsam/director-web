import {createHash, randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import type {Prisma} from '@prisma/client';
import {prisma, isSqliteBusyError} from './prisma';
import {loadAssetPromptWorkspace} from './asset-prompt-service';
import {promptNeedsReview, type PromptAsset, type PromptWorkspace} from './asset-prompt-contract';
import type {AssetReferenceImage} from './asset-image-options';

const HISTORY_KEY = 'ASSET_DESIGN_ADOPTION_V1';
const POINTER_KEY = 'ASSET_DESIGN_CURRENT_V1';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pointerId = (projectId: string, key: string) => `adopt_${digest([projectId, key]).slice(0, 40)}`;
const promptId = (projectId: string, key: string) => `ap15_${digest([projectId, key]).slice(0, 40)}`;
const optionsId = (projectId: string, key: string) => `ai15_${digest([projectId, key]).slice(0, 40)}`;
const referenceIdPattern = /^[-a-f0-9]{36}$/i;
type Actor = {id: string; name: string};
type Dependency = {assetKey: string; sourceFingerprint: string; promptRevision: number; promptFingerprint: string; adoptionVersion: number | null};
type Material = {sourceFingerprint: string; factsFingerprint: string; promptRevision: number; promptFingerprint: string; styleRevision: number; styleFingerprint: string; referenceDependencies: Dependency[]};
export type AssetDesignRecord = Material & {
  schema: 'ASSET_DESIGN_ADOPTION_V1'; action: 'ADOPT'; assetKey: string; version: number; actor: Actor; createdAt: string;
  brief: string; freeDesignScope?: string; referenceIds: string[]; references: AssetReferenceImage[]; previousVersion: number | null; restoredFromVersion?: number;
};
type Revocation = {schema: 'ASSET_DESIGN_ADOPTION_V1'; action: 'REVOKE'; assetKey: string; version: number; actor: Actor; createdAt: string; previousVersion: number | null};
type Pointer = {schema: 'ASSET_DESIGN_CURRENT_V1'; assetKey: string; revision: number; currentVersion: number | null};
export type AssetDesignStatus = 'UNADOPTED' | 'TEXT_ADOPTED' | 'REFERENCE_ADOPTED' | 'STALE';
export type AssetDesignAdoptionView = {
  assetKey: string; revision: number; materialToken: string; status: AssetDesignStatus; canAdopt: boolean; reason: string;
  current: AssetDesignRecord | null; references: AssetReferenceImage[];
  history: {action: 'ADOPT' | 'REVOKE'; version: number; actor: Actor; createdAt: string; brief?: string; freeDesignScope?: string; referenceIds?: string[]; restoredFromVersion?: number}[];
};
export type AssetDesignAdoptionWorkspace = {projectId: string; canAdopt: boolean; assets: Record<string, AssetDesignAdoptionView>};
export type AdoptAssetDesignInput = {assetKey: string; expectedRevision: number; expectedMaterialToken: string; brief: string; freeDesignScope?: string; referenceIds: string[]};
export class AssetDesignAdoptionError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

async function membership(projectId: string, actorId: string, writing = false, db: Pick<Prisma.TransactionClient, 'user'> = prisma) {
  const actor = typeof actorId === 'string' && actorId ? await db.user.findUnique({where: {id: actorId}, select: {id: true, name: true, username: true, roles: {where: {projectId}, select: {role: true}}}}) : null;
  if (!actor?.roles.length) throw new AssetDesignAdoptionError('无权访问此项目。', 403);
  const canAdopt = actor.roles.some(item => item.role === 'ADMIN' || item.role === 'REVIEWER');
  if (writing && !canAdopt) throw new AssetDesignAdoptionError('仅管理员和审查员具有设计采用权限。', 403);
  return {actor: {id: actor.id, name: actor.name || actor.username}, canAdopt};
}
function validateIdentity(input: {assetKey: string; expectedRevision: number}) {
  if (typeof input?.assetKey !== 'string' || !input.assetKey.trim() || input.assetKey.length > 200) throw new AssetDesignAdoptionError('请选择有效资产。', 400);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new AssetDesignAdoptionError('无效的采用版本。', 400);
}
const dependencyKey = (asset: PromptAsset) => asset.fromKey ?? (asset.variant ? asset.baseKey : undefined);
function dependencyKeys(workspace: PromptWorkspace, key: string, seen = new Set<string>()): string[] {
  if (seen.has(key)) return [];
  seen.add(key);
  const asset = workspace.assets.find(item => item.key === key), dependency = asset && dependencyKey(asset);
  return dependency ? [dependency, ...dependencyKeys(workspace, dependency, seen)] : [];
}
function promptFingerprint(workspace: PromptWorkspace, key: string) {
  const record = workspace.records[key];
  return digest(record ? [record.status, record.body, record.fingerprint, record.referenceKey, record.referenceRevision] : null);
}
function materialFor(workspace: PromptWorkspace, asset: PromptAsset, pointers: Map<string, Pointer>): Material {
  return {
    sourceFingerprint: asset.fingerprint, factsFingerprint: digest([asset.visualFacts ?? [], asset.evidence]),
    promptRevision: workspace.records[asset.key]?.revision ?? 0, promptFingerprint: promptFingerprint(workspace, asset.key),
    styleRevision: workspace.styleRevision, styleFingerprint: digest([workspace.style, workspace.stylePrefix]),
    referenceDependencies: [...new Set(dependencyKeys(workspace, asset.key))].map(key => ({
      assetKey: key, sourceFingerprint: workspace.assets.find(item => item.key === key)?.fingerprint ?? '',
      promptRevision: workspace.records[key]?.revision ?? 0, promptFingerprint: promptFingerprint(workspace, key),
      adoptionVersion: pointers.get(key)?.currentVersion ?? null,
    })),
  };
}
function readyReason(workspace: PromptWorkspace, asset?: PromptAsset) {
  if (!asset) return '资产已不在当前目录中，请刷新。';
  if (workspace.busy) return '第一阶段仍在整理，请完成后再采用。';
  const record = workspace.records[asset.key];
  if (record?.status !== 'READY' || !record.body.trim()) return '请先保存当前资产的完整提示词，再核对采用。';
  if (promptNeedsReview(asset, workspace.records, workspace.assets)) return '提示词来源或基础形象已更新，请先核对并保存当前提示词。';
  return '';
}
async function readState(projectId: string, suppliedWorkspace?: PromptWorkspace) {
  const workspace = suppliedWorkspace ?? await loadAssetPromptWorkspace(projectId);
  if (workspace.projectId !== projectId) throw new AssetDesignAdoptionError('资产工作区与项目不匹配。', 400);
  const rows = await prisma.sceneSnapshot.findMany({where: {projectId, sceneKey: {in: [HISTORY_KEY, POINTER_KEY]}}, orderBy: {createdAt: 'asc'}});
  const pointers = new Map<string, Pointer>(), histories = new Map<string, (AssetDesignRecord | Revocation)[]>();
  for (const row of rows) {
    const value = JSON.parse(row.content) as Pointer | AssetDesignRecord | Revocation;
    if (value.schema === POINTER_KEY) pointers.set(value.assetKey, value);
    else if (value.schema === HISTORY_KEY) histories.set(value.assetKey, [...histories.get(value.assetKey) ?? [], value]);
  }
  const assets: Record<string, AssetDesignAdoptionView> = {};
  for (const key of new Set([...workspace.assets.map(asset => asset.key), ...pointers.keys()])) {
    const asset = workspace.assets.find(item => item.key === key), pointer = pointers.get(key), history = (histories.get(key) ?? []).sort((a, b) => a.version - b.version);
    const current = history.find((item): item is AssetDesignRecord => item.action === 'ADOPT' && item.version === pointer?.currentVersion) ?? null;
    const references = workspace.imageOptions?.[key]?.references ?? [], reason = readyReason(workspace, asset), material = asset ? materialFor(workspace, asset, pointers) : null;
    const stale = current && (!material || (asset && promptNeedsReview(asset, workspace.records, workspace.assets)) || Object.entries(material).some(([field, value]) => digest(value) !== digest(current[field as keyof Material])) || current.references.some(reference => !references.some(item => item.id === reference.id && digest(item) === digest(reference))));
    assets[key] = {assetKey: key, revision: pointer?.revision ?? 0, materialToken: digest([material, references]), status: current ? stale ? 'STALE' : current.referenceIds.length ? 'REFERENCE_ADOPTED' : 'TEXT_ADOPTED' : 'UNADOPTED', current,
      canAdopt: !reason, reason: reason || (stale ? '采用后来源、提示词、画风或依赖已变化；旧记录保留，核对简述后重新采用。' : ''), references,
      history: history.map(item => ({action: item.action, version: item.version, actor: item.actor, createdAt: item.createdAt, ...(item.action === 'ADOPT' ? {brief: item.brief, freeDesignScope: item.freeDesignScope, referenceIds: item.referenceIds, restoredFromVersion: item.restoredFromVersion} : {})})),
    };
  }
  const checked = new Set<string>();
  function checkAdoptedDependencies(key: string, visiting = new Set<string>()) {
    if (checked.has(key) || visiting.has(key) || !assets[key]) return;
    visiting.add(key);
    const dependencies = dependencyKeys(workspace, key);
    dependencies.forEach(dependency => checkAdoptedDependencies(dependency, visiting));
    if (dependencies.some(dependency => pointers.get(dependency)?.currentVersion != null && assets[dependency]?.status === 'STALE')) {
      if (assets[key].current) assets[key].status = 'STALE';
      assets[key].canAdopt = false;
      assets[key].reason = '来源形象的采用已待更新，请先核对或撤销来源采用，再采用此形象。';
    }
    visiting.delete(key); checked.add(key);
  }
  Object.keys(assets).forEach(key => checkAdoptedDependencies(key));
  return {workspace, pointers, histories, assets};
}
export async function readAssetDesignAdoptions(projectId: string, actorId: string, workspace?: PromptWorkspace): Promise<AssetDesignAdoptionWorkspace> {
  const permission = await membership(projectId, actorId), state = await readState(projectId, workspace);
  return {projectId, canAdopt: permission.canAdopt, assets: state.assets};
}

async function writeEvent(projectId: string, actorId: string, input: {assetKey: string; expectedRevision: number}, event: AssetDesignRecord | Revocation, workspace?: PromptWorkspace) {
  const id = pointerId(projectId, input.assetKey);
  try {
    await prisma.$transaction(async tx => {
      await membership(projectId, actorId, true, tx);
      const row = await tx.sceneSnapshot.findUnique({where: {id}}), pointer = row ? JSON.parse(row.content) as Pointer : null;
      if ((pointer?.revision ?? 0) !== input.expectedRevision) throw new AssetDesignAdoptionError('另一窗口已更新采用记录；请刷新后重试，你的简述会保留。');
      if (event.action === 'ADOPT' && workspace) {
        // Recheck stored prompt/style/reference versions inside the same CAS transaction.
        const keys = [event.assetKey, ...event.referenceDependencies.map(item => item.assetKey)];
        const rows = await tx.sceneSnapshot.findMany({where: {projectId, id: {in: [...keys.map(key => promptId(projectId, key)), promptId(projectId, '$style'), optionsId(projectId, event.assetKey), ...event.referenceDependencies.map(item => pointerId(projectId, item.assetKey))]}}});
        for (const key of keys) {
          const stored = rows.find(item => item.id === promptId(projectId, key));
          const record = stored && JSON.parse(stored.content);
          if (!record || record.revision !== workspace.records[key]?.revision || digest([record.status, record.body, record.fingerprint, record.referenceKey, record.referenceRevision]) !== promptFingerprint(workspace, key)) throw new AssetDesignAdoptionError('提示词刚被更新，请刷新后核对采用。');
        }
        const styleRow = rows.find(item => item.id === promptId(projectId, '$style')), style = styleRow && JSON.parse(styleRow.content);
        const project = await tx.project.findUnique({where: {id: projectId}, select: {style: true}});
        if ((style?.revision ?? 0) !== workspace.styleRevision || (style && style.prefix !== workspace.stylePrefix) || (project?.style ?? '') !== workspace.style) throw new AssetDesignAdoptionError('项目画风刚被更新，请刷新后核对采用。');
        for (const dependency of event.referenceDependencies) {
          const row = rows.find(item => item.id === pointerId(projectId, dependency.assetKey));
          if ((row ? JSON.parse(row.content).currentVersion : null) !== dependency.adoptionVersion) throw new AssetDesignAdoptionError('来源形象的采用版本刚被更新，请刷新。');
        }
        const imageRow = rows.find(item => item.id === optionsId(projectId, event.assetKey)), references: AssetReferenceImage[] = imageRow ? JSON.parse(imageRow.content).references ?? [] : [];
        if (event.references.some(reference => !references.some(item => item.id === reference.id && digest(item) === digest(reference)))) throw new AssetDesignAdoptionError('参考图刚被更新，请刷新。');
      }
      const next: Pointer = {schema: POINTER_KEY, assetKey: input.assetKey, revision: input.expectedRevision + 1, currentVersion: event.action === 'ADOPT' ? event.version : null};
      if (row) {
        const result = await tx.sceneSnapshot.updateMany({where: {id, content: row.content}, data: {content: JSON.stringify(next)}});
        if (result.count !== 1) throw new AssetDesignAdoptionError('另一窗口已更新采用记录，请刷新。');
      } else await tx.sceneSnapshot.create({data: {id, projectId, sceneKey: POINTER_KEY, title: input.assetKey, content: JSON.stringify(next)}});
      await tx.sceneSnapshot.create({data: {id: `adopt_event_${randomUUID()}`, projectId, sceneKey: HISTORY_KEY, title: input.assetKey, content: JSON.stringify(event)}});
    });
  } catch (error) {
    if (isSqliteBusyError(error) || (error as {code?: string}).code === 'P2002') throw new AssetDesignAdoptionError('另一窗口正在更新采用记录，请刷新后重试；你的简述会保留。');
    throw error;
  }
}
async function adopt(projectId: string, actorId: string, input: AdoptAssetDesignInput, restoreVersion?: number) {
  validateIdentity(input);
  const {actor} = await membership(projectId, actorId, true);
  if (typeof input.brief !== 'string' || !input.brief.trim() || [...input.brief.trim()].length > 600) throw new AssetDesignAdoptionError('请先核对并填写1–600字的分镜简述，不会自动截断完整提示词。', 400);
  if (input.freeDesignScope !== undefined && (typeof input.freeDesignScope !== 'string' || [...input.freeDesignScope].length > 300)) throw new AssetDesignAdoptionError('自由设计范围请控制在300字以内。', 400);
  if (!Array.isArray(input.referenceIds) || input.referenceIds.length > 6 || input.referenceIds.some(id => typeof id !== 'string' || !referenceIdPattern.test(id)) || new Set(input.referenceIds).size !== input.referenceIds.length) throw new AssetDesignAdoptionError('请选择本资产已有的参考图。', 400);
  const state = await readState(projectId), view = state.assets[input.assetKey], asset = state.workspace.assets.find(item => item.key === input.assetKey);
  if (!asset || !view) throw new AssetDesignAdoptionError('资产已不在当前目录中，请刷新。');
  if (view.revision !== input.expectedRevision) throw new AssetDesignAdoptionError('另一窗口已更新采用记录，请刷新后重试；你的简述会保留。');
  if (typeof input.expectedMaterialToken !== 'string' || view.materialToken !== input.expectedMaterialToken) throw new AssetDesignAdoptionError('来源、提示词、画风或参考图已更新，请刷新并核对后采用；你的简述会保留。');
  if (!view.canAdopt) throw new AssetDesignAdoptionError(view.reason);
  const references = input.referenceIds.map(id => view.references.find(reference => reference.id === id));
  if (references.some(reference => !reference)) throw new AssetDesignAdoptionError('参考图不属于此资产或已移除，请刷新后重新选择。', 400);
  if (restoreVersion !== undefined && (!Number.isSafeInteger(restoreVersion) || !state.histories.get(input.assetKey)?.some(item => item.action === 'ADOPT' && item.version === restoreVersion))) throw new AssetDesignAdoptionError('未找到此资产的历史采用版本。', 400);
  const event: AssetDesignRecord = {...materialFor(state.workspace, asset, state.pointers), schema: HISTORY_KEY, action: 'ADOPT', assetKey: input.assetKey, version: view.revision + 1, actor, createdAt: new Date().toISOString(),
    brief: input.brief.trim(), ...(input.freeDesignScope?.trim() ? {freeDesignScope: input.freeDesignScope.trim()} : {}), referenceIds: [...input.referenceIds], references: references as AssetReferenceImage[], previousVersion: view.current?.version ?? null, ...(restoreVersion === undefined ? {} : {restoredFromVersion: restoreVersion})};
  await writeEvent(projectId, actorId, input, event, state.workspace);
  return readAssetDesignAdoptions(projectId, actorId);
}
export function adoptAssetDesign(projectId: string, actorId: string, input: AdoptAssetDesignInput) { return adopt(projectId, actorId, input); }
export function restoreAssetDesign(projectId: string, actorId: string, input: AdoptAssetDesignInput & {version: number}) { return adopt(projectId, actorId, input, input.version); }
export async function revokeAssetDesign(projectId: string, actorId: string, input: {assetKey: string; expectedRevision: number}) {
  validateIdentity(input);
  const {actor} = await membership(projectId, actorId, true), state = await readState(projectId), view = state.assets[input.assetKey];
  if (!view?.current) throw new AssetDesignAdoptionError('此资产当前没有采用中的设计。');
  const event: Revocation = {schema: HISTORY_KEY, action: 'REVOKE', assetKey: input.assetKey, version: input.expectedRevision + 1, actor, createdAt: new Date().toISOString(), previousVersion: view.current.version};
  await writeEvent(projectId, actorId, input, event);
  return readAssetDesignAdoptions(projectId, actorId);
}

export type AssetDesignHandoff = {
  assetKey: string; status: AssetDesignStatus; materialAvailability: 'TEXT_ONLY' | 'REFERENCE_AVAILABLE';
  adoptionVersion?: number; promptRevision?: number; styleRevision?: number; sourceFingerprint?: string; factsFingerprint?: string; referenceDependencies?: Dependency[]; brief?: string;
  freeDesignScope?: string; visualFacts?: NonNullable<PromptAsset['visualFacts']>;
  references: {id: string; source: 'USER_UPLOADED_REFERENCE'; description: string; available: boolean}[];
};
/** Internal server helper. Callers supply only this episode's keys; no prompt body, raw URLs or filesystem paths leave it. */
export async function readAssetDesignHandoff(projectId: string, assetKeys: string[], workspace?: PromptWorkspace): Promise<AssetDesignHandoff[]> {
  const state = await readState(projectId, workspace), keys = [...new Set(assetKeys.flatMap(key => [key, ...dependencyKeys(state.workspace, key)]))];
  return Promise.all(keys.map(async assetKey => {
    const view = state.assets[assetKey], current = view?.current, visualFacts = state.workspace.assets.find(asset => asset.key === assetKey)?.visualFacts ?? [];
    if (!current || view.status === 'STALE') return {assetKey, status: view?.status ?? 'UNADOPTED', materialAvailability: 'TEXT_ONLY', visualFacts, references: []};
    const references = await Promise.all(current.references.map(async (reference, index) => {
      let available = false;
      if (referenceIdPattern.test(reference.id)) {
        // Private runtime uploads are not application deployment assets.
        try {const file = await stat(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ path.resolve(/*turbopackIgnore: true*/ process.env.DIRECTOR_ASSET_REFERENCE_DIR || 'outputs/asset-references'), reference.id)); available = file.isFile() && file.size === reference.size; } catch {}
      }
      return {id: reference.id, source: 'USER_UPLOADED_REFERENCE' as const, description: `用户上传参考图 ${index + 1}（${reference.width}×${reference.height}）；非自动生成结果，未代表图像质量验收`, available};
    }));
    return {assetKey, status: view.status, materialAvailability: references.some(reference => reference.available) ? 'REFERENCE_AVAILABLE' : 'TEXT_ONLY',
      adoptionVersion: current.version, promptRevision: current.promptRevision, styleRevision: current.styleRevision, sourceFingerprint: current.sourceFingerprint, factsFingerprint: current.factsFingerprint,
      referenceDependencies: current.referenceDependencies, brief: current.brief, ...(current.freeDesignScope ? {freeDesignScope: current.freeDesignScope} : {}), visualFacts, references};
  }));
}
