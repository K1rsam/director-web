import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { FoundationChoiceView } from '@/lib/foundation-choice-store';
import type { FoundationDocument } from '@/lib/foundation-document';

// Disposable SQLite + synthetic source only. No .env load or model provider call.
async function main() {
  assert.ok(existsSync(path.resolve('lib/foundation-delivery-assets.ts')), 'working-document asset registry must exist');
  const directory = mkdtempSync(path.join(tmpdir(), 'foundation-delivery-assets-'));
  const url = `file:${path.join(directory, 'test.db')}`;
  copyFileSync(path.resolve('prisma/schema.prisma'), path.join(directory, 'schema.prisma'));
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--schema', path.join(directory, 'schema.prisma'), '--skip-generate'], { cwd: directory, env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  (globalThis as unknown as { prisma: PrismaClient }).prisma = db;
  const { registerFoundationDocumentAssets: register } = await import('@/lib/foundation-delivery-assets');
  const { loadFoundationInputs } = await import('@/lib/foundation-state');
  const { createEmptyDocument, mergeDocumentF1, mergeDocumentF2, saveFoundationDocument } = await import('@/lib/foundation-document');
  const { requireF1Output } = await import('@/lib/project-foundation-contracts');
  const { requireProductionCatalogAuthor } = await import('@/lib/foundation-production-contracts');
  const meta = (row: { metadata: string | null }) => JSON.parse(row.metadata ?? '{}');
  async function seed(title: string) {
    const project = await db.project.create({ data: { title, episodes: { create: [0, 1, 2].map(number => ({ number, title: `第${number}集`, content: `合成原文${number}：甲、神兽、城镇。` })) } } });
    const input = await loadFoundationInputs(project.id, db); let document = createEmptyDocument(input);
    document = mergeDocumentF1(document, requireF1Output({ coverage: [0, 1, 2], overview: '合成主线', episodes: [0, 1, 2].map(number => ({ number, summary: '合成导航' })) }, input.sourceIndex, [0, 1, 2]), input.sourceIndex);
    document = mergeDocumentF2(document, requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [0, 1, 2], assets: [
      { name: '甲', type: 'CH', episodes: [0], preparation: { mode: 'REFERENCE' }, variants: [{ name: '装甲', episodes: [0], preparation: { mode: 'DERIVE' } }] },
      { name: '神兽', type: 'BEAST', episodes: [1], preparation: { mode: 'REFERENCE' } },
      { name: '城镇', type: 'LOC', episodes: [2], preparation: { mode: 'REFERENCE' } },
      { name: '未定位物件', type: 'PROP', episodes: [], preparation: { mode: 'REFERENCE' } }
    ] }, input.sourceIndex, [0, 1, 2]), input.sourceIndex);
    document.editorialCoverage = [0, 1, 2];
    return { project, input, document: await saveFoundationDocument(db, project.id, createEmptyDocument(input).revision, document, 'synthetic test seed') };
  }
  let passed = 0;
  async function check(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }
  try {
    await check('valid V2 unresolved source sections block image readiness even when issues is empty', async () => {
      const seeded = await seed('unresolved source metadata');
      const sourceText = '尚未确定归属的背景片段，保留待完善。';
      const imported = await db.sceneSnapshot.create({ data: { projectId: seeded.project.id, sceneKey: 'SOURCE_IMPORT', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }),
        content: JSON.stringify({ sourceText, sourceStructure: { version: 'SOURCE_STRUCTURE_V1', sections: [{ key: 'unresolved-source', kind: 'UNRESOLVED', start: 0, end: sourceText.length }], issues: [] } }) } });
      const input = await loadFoundationInputs(seeded.project.id, db), fresh = createEmptyDocument(input);
      assert.deepEqual(input.sourceContext.issues, []); assert.equal(input.sourceContext.unresolved.length, 1);
      assert.equal(input.sourceContext.coverage, 'COMPLETE');
      const document = await saveFoundationDocument(db, seeded.project.id, seeded.document.revision, { ...seeded.document, sourceContextVersion: fresh.sourceContextVersion, settingsFingerprint: fresh.settingsFingerprint }, 'bind current unresolved source context');
      await register(db, seeded.project.id, document, []);
      const rows = await db.asset.findMany({ where: { projectId: seeded.project.id } });
      assert.ok(rows.length, 'pending source does not erase readable working identities');
      for (const row of rows) { assert.equal(meta(row).foundationDelivery.readyForImages, false); assert.equal(meta(row).foundationDelivery.readiness, 'PENDING'); }
      assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({ where: { id: imported.id } }), imported);
    });

    await check('stable explicit identities preserve id/code/design/notes/source/status through classification edits', async () => {
      const { project, document } = await seed('stable identity');
      const base = document.f2!.assets[0], variant = base.variants[0];
      const legacy = await db.asset.create({ data: { projectId: project.id, code: 'CH-001', type: 'CH', name: base.name, status: 'confirmed', sourceText: 'legacy source', notes: 'legacy note', metadata: JSON.stringify({ design: 'legacy independent image' }) } });
      const existing = await db.asset.create({ data: { projectId: project.id, code: 'CH-010', type: 'PROP', name: '旧分类名称', status: 'confirmed', sourceText: '手绘描述不得覆盖', notes: '手工备注', metadata: JSON.stringify({ foundationKey: base.key, design: { image: 'existing-image', seed: 31 }, foundation: { approvalId: 'historical-approval', handDrawn: true }, foundationPreviousApproval: { approvalId: 'older-proof' } }) } });
      const child = await db.asset.create({ data: { projectId: project.id, code: 'CH-010-2', type: 'PROP', name: '旧子形象', parentId: existing.id, status: 'approved', sourceText: '子形象手绘描述', notes: '子形象手工备注', metadata: JSON.stringify({ foundationVariantKey: variant.key, foundationParentKey: base.key, design: { image: 'variant-image' } }) } });
      await register(db, project.id, document, []);
      const changed = await db.asset.findUniqueOrThrow({ where: { id: existing.id } }), changedChild = await db.asset.findUniqueOrThrow({ where: { id: child.id } });
      assert.equal(changed.type, 'CH'); assert.equal(changed.code, existing.code); assert.equal(changed.name, base.name);
      for (const field of ['id', 'sourceText', 'notes', 'status'] as const) { assert.equal(changed[field], existing[field]); assert.equal(changedChild[field], child[field]); }
      assert.equal(changedChild.parentId, existing.id); assert.equal(changedChild.code, child.code);
      assert.deepEqual(meta(changed).design, meta(existing).design); assert.equal(meta(changed).foundation.handDrawn, true);
      assert.deepEqual(meta(changed).foundationPreviousApproval, { approvalId: 'older-proof' }, 'do not overwrite earlier historical approval provenance');
      assert.equal(meta(changed).foundation.status, 'WORKING'); assert.equal(meta(changed).foundation.documentRevision, document.revision);
      assert.equal(meta(changed).foundation.sourceVersion, document.sourceVersion); assert.equal(meta(changed).foundation.approvalId, undefined);
      assert.equal(meta(changed).foundationDelivery.readyForImages, true);
      assert.deepEqual(await db.asset.findUniqueOrThrow({ where: { id: legacy.id } }), legacy, 'same-name unkeyed material is not merged or rewritten');
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: 'FOUNDATION_APPROVED' } }), 0);
      const first = await db.asset.findMany({ where: { projectId: project.id }, orderBy: { code: 'asc' } });
      await register(db, project.id, document, []);
      assert.deepEqual((await db.asset.findMany({ where: { projectId: project.id }, orderBy: { code: 'asc' } })).map(row => [row.id, row.code, row.metadata]), first.map(row => [row.id, row.code, row.metadata]), 'idempotent identity mapping and metadata');
    });

    await check('only scoped pending choices, repair items and derive dependencies block image preparation', async () => {
      const seeded = await seed('partial pending'); let document = seeded.document;
      const [base, beast, town] = document.f2!.assets;
      document.editorialTodos = [{ id: 'todo-beast', key: beast.key, episodes: [1], note: '神兽素材来源待完善' }];
      town.preparation = { mode: 'DERIVE', fromKey: beast.key };
      document = await saveFoundationDocument(db, seeded.project.id, document.revision, document, 'pending test');
      const choice: FoundationChoiceView = { id: 'choice-0', category: 'PRODUCTION_CHOICE', question: '第0集用哪个方案？', options: ['甲', '乙'], evidence: null, userAnswer: null, episodes: [0], sourceStages: ['Q1'], reason: '需决定', recommended: '甲', recommendationReason: '建议', revision: 'choice-r1', round: 1, decidedAt: null };
      await register(db, seeded.project.id, document, [choice]);
      const rows = await db.asset.findMany({ where: { projectId: seeded.project.id } });
      const byKey = (key: string) => rows.find(row => meta(row).foundationKey === key || meta(row).foundationVariantKey === key)!;
      assert.equal(meta(byKey(base.key)).foundationDelivery.readyForImages, false);
      assert.deepEqual(meta(byKey(base.key)).foundationDelivery.requiredChoiceIds, ['choice-0']);
      assert.equal(meta(byKey(base.variants[0].key)).foundationDelivery.readiness, 'PENDING');
      assert.equal(meta(byKey(beast.key)).foundationDelivery.readiness, 'PENDING');
      assert.equal(meta(byKey(town.key)).foundationDelivery.readiness, 'PENDING', 'pending follows explicit source identity');
      assert.equal(meta(byKey(document.f2!.assets[3].key)).foundationDelivery.readyForImages, false, 'unlocated catalog entry must not become an image order');
      assert.equal(rows.length, 5, 'all identities stay readable despite local pending work');
    });

    await check('unresolved, inline and audio preparation never masquerade as ready image work', async () => {
      const seeded = await seed('non-image modes'); let document = seeded.document;
      document.f2!.assets[0].preparation = { mode: 'INLINE' };
      document.f2!.assets[1].preparation = { mode: 'AUDIO' };
      document.f2!.assets[2].preparation = { mode: 'UNRESOLVED' };
      document = await saveFoundationDocument(db, seeded.project.id, document.revision, document, 'mode test');
      await register(db, seeded.project.id, document, []);
      const rows = await db.asset.findMany({ where: { projectId: seeded.project.id } });
      for (const asset of document.f2!.assets.slice(0, 3)) assert.equal(meta(rows.find(row => meta(row).foundationKey === asset.key)!).foundationDelivery.readyForImages, false);
    });

    await check('an actual retained catalog repair blocks only affected identities, not the clean asset', async () => {
      const seeded = await seed('retained repair'); let document = seeded.document;
      document.f2 = requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [0, 1, 2], assets: [
        { name: '铜镜', type: 'PROP', episodes: [0], preparation: { mode: 'REFERENCE' }, variants: [{ name: '裂纹', episodes: [0, 1], preparation: { mode: 'DERIVE' } }] },
        { name: '独立广场', type: 'LOC', episodes: [2], preparation: { mode: 'REFERENCE' } }
      ] }, seeded.input.sourceIndex, [0, 1, 2]);
      assert.equal(document.f2.repairItems?.length, 1);
      document = await saveFoundationDocument(db, seeded.project.id, document.revision, document, 'retain real repair item');
      await register(db, seeded.project.id, document, []);
      const rows = await db.asset.findMany({ where: { projectId: seeded.project.id } });
      const byKey = (key: string) => rows.find(row => meta(row).foundationKey === key || meta(row).foundationVariantKey === key)!;
      assert.equal(meta(byKey(document.f2!.assets[0].key)).foundationDelivery.readiness, 'PENDING');
      assert.equal(meta(byKey(document.f2!.assets[0].variants[0].key)).foundationDelivery.readiness, 'PENDING');
      assert.equal(meta(byKey(document.f2!.assets[1].key)).foundationDelivery.readyForImages, true);
      assert.deepEqual(document.f2!.repairItems?.[0].assetEpisodes, [0], 'registration does not repair original declarations');
    });

    await check('duplicate variant keys in the saved document are not silently normalized into new identities', async () => {
      const seeded = await seed('duplicate variant identities'); let document = seeded.document;
      document.f2!.assets[1].variants.push({ ...structuredClone(document.f2!.assets[0].variants[0]), name: '兽形', episodes: [1], preparation: { mode: 'REFERENCE' } });
      document = await saveFoundationDocument(db, seeded.project.id, document.revision, document, 'synthetic duplicate variant');
      await assert.rejects(register(db, seeded.project.id, document, []), /重复|key/);
      assert.equal(await db.asset.count({ where: { projectId: seeded.project.id } }), 0);
    });

    await check('removed keys preserve historical material without guessing image inheritance by name', async () => {
      const seeded = await seed('historical assets'); let document = seeded.document;
      await register(db, seeded.project.id, document, []);
      const old = (await db.asset.findMany({ where: { projectId: seeded.project.id } })).find(row => meta(row).foundationKey === document.f2!.assets[0].key)!;
      await db.asset.update({ where: { id: old.id }, data: { notes: 'historical note', metadata: JSON.stringify({ ...meta(old), design: { image: 'do-not-transfer' } }) } });
      const previous = document.f2!.assets.shift()!;
      document.f2!.assets.push({ ...previous, key: 'EXPLICIT_NEW_IDENTITY', variants: [] });
      document = await saveFoundationDocument(db, seeded.project.id, document.revision, document, 'explicit new identity');
      await register(db, seeded.project.id, document, []);
      const retained = await db.asset.findUniqueOrThrow({ where: { id: old.id } });
      assert.equal(meta(retained).foundationCurrent, false); assert.equal(retained.notes, 'historical note');
      assert.deepEqual(meta(retained).design, { image: 'do-not-transfer' });
      const current = (await db.asset.findMany({ where: { projectId: seeded.project.id } })).find(row => meta(row).foundationKey === 'EXPLICIT_NEW_IDENTITY')!;
      assert.notEqual(current.id, old.id); assert.equal(meta(current).design, undefined);
      assert.equal(meta(retained).foundationMergedIntoKey, undefined, 'no inferred merge without explicit provenance');
    });

    await check('duplicate persisted identities and conflicting child bindings reject atomically', async () => {
      for (const conflict of ['duplicate', 'parent'] as const) {
        const { project, document } = await seed(conflict);
        const base = document.f2!.assets[0], variant = base.variants[0];
        const row = await db.asset.create({ data: { projectId: project.id, code: 'CH-010', type: 'CH', name: 'old', metadata: JSON.stringify({ foundationKey: base.key }) } });
        await db.asset.create({ data: { projectId: project.id, code: 'CH-011', type: 'CH', name: 'conflict', metadata: JSON.stringify(conflict === 'duplicate' ? { foundationKey: base.key } : { foundationVariantKey: variant.key, foundationParentKey: base.key }), ...(conflict === 'parent' ? { parentId: null } : {}) } });
        const before = await db.asset.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } });
        await assert.rejects(register(db, project.id, document, []), /重复|绑定|冲突/);
        assert.deepEqual(await db.asset.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } }), before);
        assert.equal((await db.asset.findUniqueOrThrow({ where: { id: row.id } })).name, 'old');
      }
    });

    await check('stale revision, forged revision body and changed source cannot publish stale work', async () => {
      const seeded = await seed('stale guard');
      await assert.rejects(register(db, seeded.project.id, { ...seeded.document, notes: ['forged same revision'] }, []), /修订|revision|内容/);
      const next = await saveFoundationDocument(db, seeded.project.id, seeded.document.revision, seeded.document, 'new revision');
      await assert.rejects(register(db, seeded.project.id, seeded.document, []), /修订|revision/);
      const episode = await db.episode.findFirstOrThrow({ where: { projectId: seeded.project.id, number: 0 } });
      await db.episode.update({ where: { id: episode.id }, data: { content: '原文真的变了' } });
      await assert.rejects(register(db, seeded.project.id, next, []), /原文|source/);
      assert.equal(await db.asset.count({ where: { projectId: seeded.project.id } }), 0);
    });

    await check('export readiness never outruns partial coverage, editing todos or unapplied decisions', async () => {
      const { buildFoundationExport } = await import('@/lib/foundation-export');
      for (const mode of ['partial', 'todo', 'decision'] as const) {
        const seeded = await seed(`export ${mode}`); let document = seeded.document;
        if (mode === 'partial') {
          document.f1!.coverage = [0]; document.f1!.episodes = document.f1!.episodes.filter(episode => episode.number === 0); document.overviewParts = [{ coverage: [0], overview: document.f1!.overview }];
          document.f2!.coverage = [0]; document.f2!.episodes = document.f2!.episodes.filter(episode => episode.number === 0); document.f2!.assets = document.f2!.assets.filter(asset => asset.usageEpisodes.every(number => number === 0)); document.editorialCoverage = [0];
        } else if (mode === 'todo') document.editorialTodos.push({ id: 'pending-export', episodes: [0], note: '仍须编辑' });
        else await db.presentationContract.create({ data: { projectId: seeded.project.id, category: 'PRODUCTION_CHOICE', question: '尚未采用的决定', options: '["甲","乙"]', userAnswer: '乙', status: 'CONFIRMED' } });
        document = await saveFoundationDocument(db, seeded.project.id, document.revision, document, `export ${mode}`);
        const exported = await buildFoundationExport(seeded.project.id, db);
        assert.equal(exported.currentState.complete, false); assert.equal(exported.currentState.dataReady, false, mode); assert.equal(exported.currentState.reviewReady, false, mode);
      }
    });

    await check('export carries working state and immutable legacy/raw evidence without publishing', async () => {
      const { project, document } = await seed('working export');
      const legacy = await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'FOUNDATION_APPROVED', content: '{"legacy":"keep-exact"}' } });
      const raw = '{"schema":"FOUNDATION_RUN_EVIDENCE_V1","calls":[{"requestOutcome":"UNKNOWN","response":{"rawOutput":"synthetic-secret-key keep raw"}}]}';
      const run = await db.pipelineRun.create({ data: { projectId: project.id, stageCode: 'F1', roleName: 'offline', status: 'FAILED', log: raw } });
      const before = await db.sceneSnapshot.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } });
      const { buildFoundationExport, serializeFoundationExport } = await import('@/lib/foundation-export');
      const exported = await buildFoundationExport(project.id, db);
      assert.deepEqual(exported.workingDocument, document);
      assert.equal(exported.deliveryState.document.revision, document.revision);
      assert.equal(exported.currentState.ready, false); assert.equal(exported.currentState.approvalId, null);
      assert.equal(exported.currentState.documentRevision, document.revision);
      assert.deepEqual(exported.currentState.completedEpisodes, [0, 1, 2]);
      assert.equal(exported.pipelineRuns.find(item => item.id === run.id)?.log, raw);
      assert.equal(exported.approvals.find(item => item.id === legacy.id)?.content, legacy.content);
      assert.ok(exported.notes.some(note => /工作稿/.test(note) && /审批|批准/.test(note)));
      const redacted = serializeFoundationExport(exported, ['synthetic-secret-key']);
      assert.ok(!redacted.includes('synthetic-secret-key')); assert.ok(redacted.includes('keep raw'));
      assert.deepEqual(await db.sceneSnapshot.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } }), before, 'export is read-only');
    });
    console.log(`Foundation delivery assets/export: ${passed} isolated checks passed.`);
  } finally { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
