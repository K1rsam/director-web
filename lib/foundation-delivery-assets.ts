/** Stable working identities only. This registry never creates approval snapshots or transfers images by name. */
import { isDeepStrictEqual } from 'node:util';
import type { Asset, Prisma, PrismaClient } from '@prisma/client';
import { foundationJson, loadFoundationInputs } from './foundation-state';
import { loadFoundationDocument, type FoundationDocument } from './foundation-document';
import { loadFoundationChoices, type FoundationChoiceView } from './foundation-choice-store';
import { requireProductionCatalog, unresolvedOwner, unresolvedEpisodeScope, type Preparation } from './foundation-production-contracts';
import { isRecord } from './project-foundation-contracts';

type Readiness = { readiness: 'READY' | 'PENDING' | 'NO_IMAGE'; readyForImages: boolean; requiredChoiceIds: string[]; pendingReasons: string[] };
type Entry = { key: string; parentKey?: string; episodes: number[]; preparation?: Preparation };
const overlaps = (episodes: number[], scope?: number[]) => !scope?.length || episodes.some(number => scope.includes(number));

export function workingReadiness(document: FoundationDocument, choices: FoundationChoiceView[], contextPending: boolean, scope?: number[]): Map<string, Readiness> {
  const catalog = document.f2!;
  const entries: Entry[] = catalog.assets.flatMap(asset => [
    { key: asset.key, episodes: asset.usageEpisodes, preparation: asset.preparation },
    ...asset.variants.map(variant => ({ key: variant.key, parentKey: asset.key, episodes: variant.episodes, preparation: variant.preparation }))
  ]);
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const result = new Map<string, Readiness>();
  const dependencies = new Map<string, string>();
  for (const entry of entries) {
    // Current appearances use this episode's edit receipt; external material sources keep their own scope.
    const episodes = scope && overlaps(entry.episodes, scope) ? entry.episodes.filter(number => scope.includes(number)) : entry.episodes;
    const requiredChoiceIds = choices.filter(choice => overlaps(episodes, choice.episodes)).map(choice => choice.id);
    const pendingReasons: string[] = [];
    if (requiredChoiceIds.length) pendingReasons.push('必要选择尚未采用，待完善。');
    if (!entry.preparation || entry.preparation.mode === 'UNRESOLVED') pendingReasons.push(entry.preparation?.note || '制作方式尚待完善。');
    if (!episodes.length) pendingReasons.push('适用范围尚未定位，不默认出图。');
    if (episodes.some(number => !document.editorialCoverage.includes(number) || (document.workflow !== 'LIGHT_STAGE1_V1' && !document.f1?.coverage.includes(number)))) pendingReasons.push('有关集的资料编辑尚未完成。');
    if (contextPending) pendingReasons.push('当前原文背景或制作条件尚待核对。');
    for (const todo of document.editorialTodos) {
      if (unresolvedOwner(todo) === 'STAGE2') continue;
      if (scope && !overlaps(episodes, unresolvedEpisodeScope(todo))) continue;
      if (todo.key ? todo.key === entry.key || todo.key === entry.parentKey : overlaps(episodes, todo.episodes)) pendingReasons.push(todo.note);
    }
    if (catalog.repairItems?.some(item => (!scope || overlaps(episodes, item.episodes)) && (item.assetKey === entry.key || item.variantKey === entry.key))) pendingReasons.push('父子形象原始适用范围仍待核对。');
    if (entry.preparation?.mode === 'DERIVE') {
      const sourceKey = entry.preparation.fromKey ?? entry.parentKey;
      if (!sourceKey || !byKey.has(sourceKey)) pendingReasons.push('明确派生来源尚未在当前工作稿中定位。');
      else dependencies.set(entry.key, sourceKey);
    }
    result.set(entry.key, { readiness: pendingReasons.length ? 'PENDING' : ['INLINE', 'AUDIO'].includes(entry.preparation?.mode ?? '') ? 'NO_IMAGE' : 'READY', readyForImages: false, requiredChoiceIds: [...new Set(requiredChoiceIds)], pendingReasons: [...new Set(pendingReasons)] });
  }
  // Follow only explicit identities (plus the contract-defined parent of a variant).
  for (const entry of entries) {
    const seen = new Set<string>(); let key: string | undefined = entry.key;
    while (key && dependencies.has(key)) {
      if (seen.has(key)) { result.get(entry.key)!.pendingReasons.push('派生来源存在循环，待完善。'); break; }
      seen.add(key); key = dependencies.get(key);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, sourceKey] of dependencies) {
      const item = result.get(key)!, source = result.get(sourceKey)!;
      if ((source.pendingReasons.length || source.readiness === 'NO_IMAGE') && !item.pendingReasons.includes('派生来源尚未具备制图条件。')) {
        item.pendingReasons.push('派生来源尚未具备制图条件。'); changed = true;
      }
    }
  }
  for (const value of result.values()) { if (value.pendingReasons.length) value.readiness = 'PENDING'; value.readyForImages = value.readiness === 'READY'; }
  return result;
}

function workingMetadata(previous: string | null | undefined, document: FoundationDocument, readiness: Readiness, fields: Record<string, unknown>, foundation: Record<string, unknown>) {
  const meta = foundationJson(previous), old = isRecord(meta.foundation) ? meta.foundation : {};
  const { approvalId, inputVersion, f2SnapshotId, q1SnapshotId, ...retained } = old;
  const approval = typeof approvalId === 'string' ? { approvalId, sourceVersion: old.sourceVersion, inputVersion, f2SnapshotId, q1SnapshotId } : undefined;
  if (approval) {
    if (meta.foundationPreviousApproval === undefined) meta.foundationPreviousApproval = approval;
    else if (!isDeepStrictEqual(meta.foundationPreviousApproval, approval)) {
      const history = Array.isArray(meta.foundationApprovalHistory) ? meta.foundationApprovalHistory : [];
      if (!history.some(item => isRecord(item) && item.approvalId === approval.approvalId)) meta.foundationApprovalHistory = [...history, approval];
    }
  }
  return JSON.stringify({ ...meta, ...fields, foundationCurrent: true,
    foundation: { ...retained, ...foundation, status: 'WORKING', documentRevision: document.revision, sourceVersion: document.sourceVersion, sourceContextVersion: document.sourceContextVersion },
    foundationDelivery: { status: 'WORKING', documentRevision: document.revision, sourceVersion: document.sourceVersion, ...readiness }
  });
}

export async function registerFoundationDocumentAssets(db: PrismaClient, projectId: string, document: FoundationDocument, requiredChoices: FoundationChoiceView[], beforeRegister?: (tx: Prisma.TransactionClient) => Promise<void>): Promise<unknown> {
  return db.$transaction(async tx => {
    await beforeRegister?.(tx);
    const input = await loadFoundationInputs(projectId, tx);
    if (input.sourceVersion !== document.sourceVersion) throw new Error('原文 source 已改变，未登记旧源资产。');
    const loaded = await loadFoundationDocument(tx, projectId, input);
    if (loaded.document.revision !== document.revision || !isDeepStrictEqual(loaded.document, document)) throw new Error('工作稿 revision 或内容已变化，未登记旧修订。');
    if (!document.f2) return { status: 'WORKING', documentRevision: document.revision, assets: [] };
    requireProductionCatalog(document.f2, input.sourceIndex, document.f2.coverage);
    const catalog = document.f2, keys = catalog.assets.flatMap(asset => [asset.key, ...asset.variants.map(variant => variant.key)]);
    if (new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !key.trim())) throw new Error('工作稿资产或变体身份key重复/无效，未覆盖素材。');
    const existing = await tx.asset.findMany({ where: { projectId } });
    const match = (key: string, field: 'foundationKey' | 'foundationVariantKey') => {
      const rows = existing.filter(row => { const meta = foundationJson(row.metadata); return meta.foundationKey === key || meta.foundationVariantKey === key; });
      if (rows.length > 1 || (rows[0] && (foundationJson(rows[0].metadata)[field] !== key || (typeof foundationJson(rows[0].metadata).foundationKey === 'string' && typeof foundationJson(rows[0].metadata).foundationVariantKey === 'string')))) throw new Error(`资产身份${key}重复或绑定冲突，未覆盖素材。`);
      return rows[0];
    };
    // Validate every binding before changing any identity, even though the transaction also rolls back.
    for (const asset of catalog.assets) {
      const parent = match(asset.key, 'foundationKey');
      if (parent?.parentId) throw new Error(`基础身份${asset.key}已绑定为子形象，未覆盖素材。`);
      for (const variant of asset.variants) {
        const child = match(variant.key, 'foundationVariantKey'), declaredParent = foundationJson(child?.metadata).foundationParentKey;
        if (child && (!parent || child.parentId !== parent.id || (typeof declaredParent === 'string' && declaredParent !== asset.key))) throw new Error(`资产变体${variant.key}既有父级绑定冲突，未覆盖素材。`);
      }
    }
    const choices = await loadFoundationChoices(tx, projectId, input.sourceVersion);
    const relevantChoices = new Map(requiredChoices.map(choice => [choice.id, choice]));
    for (const choice of [...choices.pending.filter(choice => document.requiredDecisionIds.includes(choice.id)), ...choices.confirmed.filter(choice => document.appliedDecisions[choice.id] !== choice.revision)]) relevantChoices.set(choice.id, choice);
    const contextPending = loaded.needsContextEdit || Boolean(input.sourceContext.issues.length || input.sourceContext.unresolved.length) || input.sourceContext.notices.some(notice => notice.code === 'CURRENT_SOURCE_IMPORT_METADATA_UNREADABLE');
    const readiness = workingReadiness(document, [...relevantChoices.values()], contextPending);
    const currentKeys = new Set(keys), usedCodes = new Set(existing.map(row => row.code));
    const nextCode = (type: Asset['type']) => {
      let number = Math.max(0, ...existing.filter(row => row.type === type).map(row => Number(row.code.match(/^[A-Z]+-(\d+)/)?.[1] ?? 0))) + 1;
      let code: string; do { code = `${type}-${String(number++).padStart(3, '0')}`; } while (usedCodes.has(code)); usedCodes.add(code); return code;
    };
    for (const row of existing) {
      const meta = foundationJson(row.metadata), key = meta.foundationKey ?? meta.foundationVariantKey;
      if (typeof key === 'string' && !currentKeys.has(key) && meta.foundationCurrent !== false) await tx.asset.update({ where: { id: row.id }, data: { metadata: JSON.stringify({ ...meta, foundationCurrent: false }) } });
    }
    const mappings: { key: string; id: string; code: string; readiness: Readiness['readiness'] }[] = [];
    for (const asset of catalog.assets) {
      const previous = match(asset.key, 'foundationKey'), ready = readiness.get(asset.key)!;
      const data = { name: asset.name, type: asset.type, metadata: workingMetadata(previous?.metadata, document, ready,
        { foundationKey: asset.key, aliases: asset.aliases }, { schema: 'FOUNDATION_ASSET_WORKING_V1', ...asset }) };
      const row = previous ? await tx.asset.update({ where: { id: previous.id }, data }) : await tx.asset.create({ data: { ...data, projectId, code: nextCode(asset.type), sourceText: asset.name, status: 'needs_confirmation' } });
      mappings.push({ key: asset.key, id: row.id, code: row.code, readiness: ready.readiness });
      for (const variant of asset.variants) {
        const previous = match(variant.key, 'foundationVariantKey'), ready = readiness.get(variant.key)!;
        let code = previous?.code;
        if (!code) { let ordinal = 1; do { code = `${row.code}-${ordinal++}`; } while (usedCodes.has(code)); usedCodes.add(code); }
        const data = { name: `${asset.name}｜${variant.name}`, type: asset.type, parentId: row.id, metadata: workingMetadata(previous?.metadata, document, ready,
          { foundationVariantKey: variant.key, foundationParentKey: asset.key }, { schema: 'FOUNDATION_ASSET_VARIANT_WORKING_V1', ...variant }) };
        const child = previous ? await tx.asset.update({ where: { id: previous.id }, data }) : await tx.asset.create({ data: { ...data, projectId, code, sourceText: [variant.name, variant.note].filter(Boolean).join('：'), status: 'needs_confirmation' } });
        mappings.push({ key: variant.key, id: child.id, code: child.code, readiness: ready.readiness });
      }
    }
    return { status: 'WORKING', documentRevision: document.revision, sourceVersion: document.sourceVersion, assets: mappings };
  }, { maxWait: 10_000, timeout: 20_000 });
}
