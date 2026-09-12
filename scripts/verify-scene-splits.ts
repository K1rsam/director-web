import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { parseSceneBatch, type SceneSplitPlan } from '@/lib/source-parser';
import { preprocessProject } from '@/lib/project-preprocess';

const raw = '第7集\r\n7-1 日 内 地下室\r\n人物：甲乙\r\n甲乙：抬头🙂。 \r\n△天空，一片云遮住月亮。 \r\n\r\n7-2 夜 外 院子\r\n人物：丙丁\r\n丙丁：走。\r\n';
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const plan: SceneSplitPlan = { episode: 7, sourceHash: digest(raw), sceneKey: '7-1', cuts: [{ startLine: 5, anchor: '△天空，一片云遮住月亮。 ', location: '天空', interiorExterior: '外', timeOfDay: '夜' }] };
const episodes = [{ number: 7, content: raw }];

function beforeTransaction(db: PrismaClient, change: () => Promise<void>) {
  let entered = false;
  return new Proxy(db, { get(target, name, receiver) {
    if (name === '$transaction') return async (...args: unknown[]) => {
      if (!entered) { entered = true; await change(); }
      return (target.$transaction.bind(target) as (...values: unknown[]) => Promise<unknown>)(...args);
    };
    return Reflect.get(target, name, receiver);
  } });
}

function verifyParser() {
  const scenes = parseSceneBatch(episodes, [plan])[0]!.scenes;
  assert.deepEqual(scenes.map(scene => scene.sceneKey), ['7-1', '7-1__L5', '7-2'], 'a bound plan must create only its requested child scene');
  assert.equal(scenes.map(scene => scene.sourceText).join(''), raw, 'CRLF, emoji, trailing spaces and all original text are preserved');
  assert.deepEqual(scenes.map(scene => scene.sortOrder), [1, 2, 3]);
  assert.deepEqual([scenes[1].location, scenes[1].interiorExterior, scenes[1].timeOfDay], ['天空', '外', '夜']);
  assert.deepEqual(parseSceneBatch(episodes, [plan]), parseSceneBatch(episodes, [plan]), 'replay has stable keys and exact slices');
  assert.equal(parseSceneBatch(episodes)[0].scenes.length, 2, 'an action sentence never splits without a plan');
  const cut = plan.cuts[0];
  const earlier = { startLine: 4, anchor: '甲乙：抬头🙂。 ', location: '地下室' };
  const multi = parseSceneBatch(episodes, [{ ...plan, cuts: [earlier, cut] }])[0].scenes;
  assert.deepEqual(multi.map(scene => scene.sceneKey), ['7-1', '7-1__L4', '7-1__L5', '7-2']);
  assert.equal(multi.map(scene => scene.sourceText).join(''), raw);
  for (const invalid of [
    { ...plan, sourceHash: '0'.repeat(64) }, { ...plan, sceneKey: '7-9' }, { ...plan, episode: 8 },
    { ...plan, cuts: [] }, { ...plan, cuts: [{ ...cut, startLine: 1 }] }, { ...plan, cuts: [{ ...cut, startLine: 7 }] },
    { ...plan, cuts: [{ ...cut, startLine: 1.5 }] }, { ...plan, cuts: [{ ...cut, anchor: cut.anchor.trim() }] },
    { ...plan, cuts: [cut, cut] }, { ...plan, cuts: [cut, earlier] }, { ...plan, cuts: [{ ...cut, startLine: 6, anchor: '' }, cut] }
  ]) assert.throws(() => parseSceneBatch(episodes, [invalid]), /split|hash|anchor|line|target|原文/i, 'invalid plans are rejected, not guessed');
  assert.throws(() => parseSceneBatch(episodes, [plan, plan]), /duplicate|重复|split/i);
}

async function main() {
  verifyParser();
  console.log('PASS bound source split parser');
  assert.ok(existsSync(join(process.cwd(), 'lib/scene-split-plan.ts')), 'transactional scene split plan helpers must exist');
  const { readSceneSplitPlans, previewSceneSplitPlans, applySceneSplitPlans } = await import('@/lib/scene-split-plan');
  const scratch = mkdtempSync(join(tmpdir(), 'director-scene-splits-'));
  const schema = join(scratch, 'schema.prisma'), datasourceUrl = `file:${join(scratch, 'test.db')}`;
  cpSync(join(process.cwd(), 'prisma/schema.prisma'), schema);
  const db = new PrismaClient({ datasourceUrl });
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', schema], {
      cwd: scratch, env: { ...process.env, DATABASE_URL: datasourceUrl, RUST_LOG: 'info', DEEPSEEK_API_KEY: '', CODEX_CLI_PATH: '/__offline_only__/no-real-codex' }, stdio: 'pipe'
    });
    const project = await db.project.create({ data: { title: '__scene_splits__', episodes: { create: [...episodes, { number: 8, content: '8-1 日 内 客厅\n甲乙：下一集。\n' }] } }, include: { episodes: true } });
    await preprocessProject(project.id, db);
    const episode = project.episodes.find(item => item.number === 7)!;
    const original = await db.scriptScene.findUniqueOrThrow({ where: { episodeId_sceneKey: { episodeId: episode.id, sceneKey: '7-1' } } });
    const sibling = await db.scriptScene.findUniqueOrThrow({ where: { episodeId_sceneKey: { episodeId: episode.id, sceneKey: '7-2' } } });
    const siblingMetadata = JSON.stringify({ ...JSON.parse(sibling.metadata), sourceFieldPatch: { sourceHash: digest(sibling.sourceText), fields: { location: '院子已校准' } } });
    await db.scriptScene.update({ where: { id: sibling.id }, data: { location: '院子已校准', metadata: siblingMetadata } });
    const other = await db.scriptScene.findFirstOrThrow({ where: { episodeId: project.episodes.find(item => item.number === 8)!.id } });
    await db.scriptScene.update({ where: { id: other.id }, data: { location: '已确认地点', metadata: JSON.stringify({ ...JSON.parse(other.metadata), sourceFieldPatch: { sourceHash: digest(other.sourceText), fields: { location: '已确认地点' } } }) } });
    const otherBefore = await db.scriptScene.findUniqueOrThrow({ where: { id: other.id } });
    const asset = await db.asset.create({ data: { projectId: project.id, code: 'LOC-900', type: 'LOC', name: '既有资产', metadata: '{"keep":true}' } });
    const before = await db.scriptScene.findMany({ where: { episode: { projectId: project.id } }, orderBy: { id: 'asc' } });
    const preview = await previewSceneSplitPlans(project.id, db, [plan]);
    assert.equal(preview.find(scene => scene.sceneKey === sibling.sceneKey)!.location, '院子已校准', 'same-episode sibling fields are not reparsed away');
    assert.equal(preview.find(scene => scene.episode === 8)!.location, '已确认地点', 'preview keeps unrelated saved field patches');
    assert.equal(preview.filter(scene => scene.episode === 7).map(scene => scene.sourceText).join(''), raw);
    assert.deepEqual(await db.scriptScene.findMany({ where: { episode: { projectId: project.id } }, orderBy: { id: 'asc' } }), before, 'preview is read-only');
    assert.deepEqual(await readSceneSplitPlans(project.id, db), []);
    await assert.rejects(db.$transaction(async tx => { await applySceneSplitPlans(project.id, tx, [plan]); throw new Error('simulate failed document CAS'); }), /failed document CAS/);
    assert.deepEqual(await readSceneSplitPlans(project.id, db), [], 'plan and scenes roll back with the caller transaction');
    assert.deepEqual(await db.scriptScene.findMany({ where: { episode: { projectId: project.id } }, orderBy: { id: 'asc' } }), before);
    await db.$transaction(tx => applySceneSplitPlans(project.id, tx, [plan]));
    assert.deepEqual(await readSceneSplitPlans(project.id, db), [plan]);
    const getRows = () => db.scriptScene.findMany({ where: { episodeId: episode.id }, orderBy: { sortOrder: 'asc' } });
    const applied = await getRows();
    assert.deepEqual(applied.map(scene => scene.sceneKey), ['7-1', '7-1__L5', '7-2']);
    assert.equal(applied[0].id, original.id);
    assert.equal(applied[2].id, sibling.id);
    assert.equal(applied[2].location, '院子已校准');
    assert.equal(applied[2].metadata, siblingMetadata);
    assert.deepEqual(applied.map(scene => scene.sortOrder), [1, 2, 3], 'following source-identical scenes get corrected sort order');
    assert.equal(applied.map(scene => scene.sourceText).join(''), raw);
    const snapshotCount = await db.sceneSnapshot.count({ where: { projectId: project.id } });
    await db.$transaction(tx => applySceneSplitPlans(project.id, tx, [plan]));
    assert.deepEqual(await getRows(), applied, 'same plan must not rewrite rows or timestamps');
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id } }), snapshotCount, 'same plan saves no duplicate receipts');
    await preprocessProject(project.id, db);
    assert.deepEqual(await getRows(), applied, 'ordinary preprocessing replays the saved split without undoing it');
    await db.scriptScene.update({ where: { id: sibling.id }, data: { sortOrder: 2 } });
    await preprocessProject(project.id, db);
    assert.equal((await getRows()).find(scene => scene.id === sibling.id)!.sortOrder, 3, 'P0 must repair sibling order even when its sourceHash is unchanged');
    assert.deepEqual(await db.scriptScene.findUnique({ where: { id: other.id } }), otherBefore);
    assert.deepEqual(await db.asset.findUnique({ where: { id: asset.id } }), asset);
    assert.deepEqual(await db.episode.findUnique({ where: { id: episode.id } }), episode, 'raw source and its timestamps stay untouched');
    // Applying the same receipt after a later legal Q1 field patch stays a no-op.
    const child = applied[1];
    await db.scriptScene.update({ where: { id: child.id }, data: { location: '天空已校准', metadata: JSON.stringify({ ...JSON.parse(child.metadata), sourceFieldPatch: { sourceHash: digest(child.sourceText), fields: { location: '天空已校准' } } }) } });
    const patched = await getRows();
    await db.$transaction(tx => applySceneSplitPlans(project.id, tx, [plan]));
    assert.deepEqual(await getRows(), patched);
    await preprocessProject(project.id, db);
    assert.deepEqual(await getRows(), patched, 'saved plan replay preserves later child field patches');
    console.log('PASS preview, atomic application, idempotence and preprocess replay');

    for (const protection of ['manual', 'patch', 'shot', 'unit', 'column', 'characters']) {
      const p = await db.project.create({ data: { title: `__split_protected_${protection}__`, episodes: { create: episodes } }, include: { episodes: true } });
      await preprocessProject(p.id, db);
      const row = await db.scriptScene.findFirstOrThrow({ where: { episodeId: p.episodes[0].id, sceneKey: '7-1' } });
      if (protection === 'manual' || protection === 'patch') await db.scriptScene.update({ where: { id: row.id }, data: { metadata: JSON.stringify({ ...JSON.parse(row.metadata), [protection === 'manual' ? 'reviewedBy' : 'sourceFieldPatch']: { keep: true } }) } });
      if (protection === 'shot') await db.storyboardShot.create({ data: { episodeId: row.episodeId, sceneId: row.id, shotKey: 'protected', sortOrder: 1, duration: 1 } });
      if (protection === 'unit') await db.seedanceUnit.create({ data: { episodeId: row.episodeId, sceneId: row.id, unitKey: 'protected', sortOrder: 1, duration: 1, startPremise: '起', endState: '止' } });
      if (protection === 'column') await db.scriptScene.update({ where: { id: row.id }, data: { location: '用户直接确认地点' } });
      if (protection === 'characters') await db.scriptScene.update({ where: { id: row.id }, data: { metadata: JSON.stringify({ ...JSON.parse(row.metadata), characters: ['用户直接确认人物'] }) } });
      const protectedBefore = await db.scriptScene.findMany({ where: { episodeId: row.episodeId }, orderBy: { id: 'asc' } });
      await assert.rejects(previewSceneSplitPlans(p.id, db, [plan]), /保护|人工|patch|下游|protected/i);
      await assert.rejects(db.$transaction(tx => applySceneSplitPlans(p.id, tx, [plan])), /保护|人工|patch|下游|protected/i);
      assert.deepEqual(await db.scriptScene.findMany({ where: { episodeId: row.episodeId }, orderBy: { id: 'asc' } }), protectedBefore);
      assert.deepEqual(await readSceneSplitPlans(p.id, db), []);
    }
    console.log('PASS protected manual, Q1, shot and unit content');
    const changedProject = await db.project.create({ data: { title: '__split_source_change__', episodes: { create: episodes } }, include: { episodes: true } });
    await preprocessProject(changedProject.id, db);
    await db.$transaction(tx => applySceneSplitPlans(changedProject.id, tx, [plan]));
    const changedRaw = raw.replace('抬头🙂', '转身🙂');
    await db.episode.update({ where: { id: changedProject.episodes[0].id }, data: { content: changedRaw } });
    await assert.rejects(preprocessProject(changedProject.id, db), /sourceHash|原文已变化/, 'a stale plan cannot silently change or unsplit newer source');
    const replacement = { ...plan, sourceHash: digest(changedRaw) };
    await db.$transaction(tx => applySceneSplitPlans(changedProject.id, tx, [replacement]));
    await preprocessProject(changedProject.id, db);
    assert.deepEqual(await readSceneSplitPlans(changedProject.id, db), [replacement], 'a new source-bound plan supersedes a stale one without an unrecoverable loop');
    const changedRows = await db.scriptScene.findMany({ where: { episodeId: changedProject.episodes[0].id }, orderBy: { sortOrder: 'asc' } });
    assert.equal(changedRows.map(scene => scene.sourceText).join(''), changedRaw);
    console.log('PASS explicit stale-source rejection and replacement plan recovery');
    const markerRaw = '第7集\n场景：大厅\n人物：甲乙\n甲乙：来。\n场景：庭院\n人物：甲乙\n甲乙：看。\n△天空，一片云遮住月亮。\n';
    const markerPlan: SceneSplitPlan = { episode: 7, sourceHash: digest(markerRaw), sceneKey: '7-2', cuts: [{ startLine: 8, anchor: '△天空，一片云遮住月亮。', location: '天空', interiorExterior: '外' }] };
    const markerProject = await db.project.create({ data: { title: '__split_second_scene_marker__', episodes: { create: { number: 7, content: markerRaw } } }, include: { episodes: true } });
    await preprocessProject(markerProject.id, db);
    const markerBefore = await db.scriptScene.findMany({ where: { episodeId: markerProject.episodes[0].id }, orderBy: { sortOrder: 'asc' } });
    assert.deepEqual(parseSceneBatch([{ number: 7, content: markerRaw }], [markerPlan])[0].scenes.map(scene => scene.sceneKey), ['7-1', '7-2', '7-2__L8']);
    const markerPreview = await previewSceneSplitPlans(markerProject.id, db, [markerPlan]);
    assert.deepEqual(markerPreview.map(scene => scene.sceneKey), ['7-1', '7-2', '7-2__L8'], 'ownership lookup keeps the second scene marker position in the full episode');
    await db.$transaction(tx => applySceneSplitPlans(markerProject.id, tx, [markerPlan]));
    await preprocessProject(markerProject.id, db);
    const markerAfter = await db.scriptScene.findMany({ where: { episodeId: markerProject.episodes[0].id }, orderBy: { sortOrder: 'asc' } });
    assert.equal(markerAfter[1].id, markerBefore[1].id);
    assert.equal(markerAfter.map(scene => scene.sourceText).join(''), markerRaw);
    const manualMarker = await db.project.create({ data: { title: '__split_manual_second_marker__', episodes: { create: { number: 7, content: markerRaw } } }, include: { episodes: true } });
    await preprocessProject(manualMarker.id, db);
    const manualRow = await db.scriptScene.findFirstOrThrow({ where: { episodeId: manualMarker.episodes[0].id, sceneKey: '7-2' } });
    await db.scriptScene.update({ where: { id: manualRow.id }, data: { location: '用户确认地点' } });
    await assert.rejects(previewSceneSplitPlans(manualMarker.id, db, [markerPlan]), /人工|保护/);
    console.log('PASS second unnumbered scene marker ownership and manual field protection');

    const raceFailures: string[] = [];
    const checkRace = async (name: string, run: () => Promise<void>) => {
      try { await run(); console.log(`PASS ${name}`); }
      catch (error) { raceFailures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    await checkRace('preprocess rejects a concurrently committed split plan', async () => {
      const p = await db.project.create({ data: { title: '__split_preprocess_race__', episodes: { create: episodes } }, include: { episodes: true } });
      await preprocessProject(p.id, db);
      const getScenes = () => db.scriptScene.findMany({ where: { episodeId: p.episodes[0].id }, orderBy: { sortOrder: 'asc' } });
      let winner = await getScenes();
      const racing = beforeTransaction(db, async () => { await db.$transaction(tx => applySceneSplitPlans(p.id, tx, [plan])); winner = await getScenes(); });
      await assert.rejects(preprocessProject(p.id, racing), /拆场计划.*变化|拆场计划.*重试/);
      assert.deepEqual(await getScenes(), winner, 'stale P0 cannot overwrite the committed parent/child source slices');
      assert.equal((await getScenes()).map(scene => scene.sourceText).join(''), raw);
      await preprocessProject(p.id, db);
      assert.deepEqual(await getScenes(), winner, 'a fresh retry consumes the winning split plan');
    });
    await checkRace('preprocess rejects concurrently changed episode source', async () => {
      const p = await db.project.create({ data: { title: '__source_preprocess_race__', episodes: { create: episodes } }, include: { episodes: true } });
      await preprocessProject(p.id, db);
      const beforeRows = await db.scriptScene.findMany({ where: { episodeId: p.episodes[0].id }, orderBy: { sortOrder: 'asc' } });
      const beforeSource = await db.sceneSnapshot.findMany({ where: { projectId: p.id }, orderBy: { id: 'asc' } });
      const nextRaw = raw.replace('抬头🙂', '转身🙂');
      const racing = beforeTransaction(db, async () => { await db.episode.update({ where: { id: p.episodes[0].id }, data: { content: nextRaw } }); });
      await assert.rejects(preprocessProject(p.id, racing), /原文.*变化|原文.*重试/);
      assert.deepEqual(await db.scriptScene.findMany({ where: { episodeId: p.episodes[0].id }, orderBy: { sortOrder: 'asc' } }), beforeRows);
      assert.deepEqual(await db.sceneSnapshot.findMany({ where: { projectId: p.id }, orderBy: { id: 'asc' } }), beforeSource, 'the stale SOURCE snapshot is not published');
      await preprocessProject(p.id, db);
      assert.equal((await db.scriptScene.findMany({ where: { episodeId: p.episodes[0].id }, orderBy: { sortOrder: 'asc' } })).map(scene => scene.sourceText).join(''), nextRaw);
    });
    await checkRace('import-only preprocessing executes checkCurrent', async () => {
      const p = await db.project.create({ data: { title: '__empty_preprocess_guard__' } });
      let guarded = false;
      await assert.rejects(preprocessProject(p.id, db, { checkCurrent: async () => { guarded = true; throw new Error('guard-current-stop'); } }), /guard-current-stop/);
      assert.ok(guarded);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id } }), 0);
    });
    await checkRace('import-only preprocessing rejects a changed import', async () => {
      const p = await db.project.create({ data: { title: '__empty_preprocess_source_race__' } });
      const imported = await db.sceneSnapshot.create({ data: { projectId: p.id, sceneKey: 'SOURCE_IMPORT', content: '旧导入原文' } });
      const racing = beforeTransaction(db, async () => { await db.sceneSnapshot.update({ where: { id: imported.id }, data: { content: '更新的导入原文' } }); });
      await assert.rejects(preprocessProject(p.id, racing), /原文.*变化|原文.*重试/);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: 'FOUNDATION_SOURCE' } }), 0);
    });
    assert.deepEqual(raceFailures, [], 'preprocess source/plan snapshots must remain current until writes begin');
  } finally {
    await db.$disconnect();
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
