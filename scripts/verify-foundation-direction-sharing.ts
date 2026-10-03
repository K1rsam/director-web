/** Real isolated DB + delivery controller; only the paid model boundary is substituted. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';
import type { SeriesDirectionContent } from '@/lib/series-direction';

const dir = mkdtempSync(path.join(tmpdir(), 'foundation-direction-'));
const url = `file:${path.join(dir, 'test.db')}`;
process.env.DATABASE_URL = url;
copyFileSync(path.resolve('prisma/schema.prisma'), path.join(dir, 'schema.prisma'));
execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--schema', path.join(dir, 'schema.prisma'), '--skip-generate'], { cwd: dir, env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, stdio: 'pipe' });
const db = new PrismaClient({ datasources: { db: { url } } });
const content: SeriesDirectionContent = {
  settingTags: ['现代'], mechanismTags: [], arcTags: ['从试探走向互信'], primaryTone: '克制温情', secondaryTones: ['轻松'],
  audiencePromise: '通过行动建立信任，得到相互支持的回报。', expressionRules: ['情绪落实为可见行动，不把角色说法当世界规则。'],
  avoidances: ['不提前套用未来知情。'], episodeFlexibility: '单集可紧张或低落，整体方向不把所有片段改成同一种情绪。'
};
const out = (data: Record<string, unknown>): RoleRunResult => ({ data, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null });
const request = (prompt: string) => JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);

async function main() {
  const delivery = await import('@/lib/foundation-delivery');
  const service = await import('@/lib/series-direction-service');
  const { preprocessProject } = await import('@/lib/project-preprocess');
  const { attachEpisodeMaterials } = await import('@/lib/episode-upstream-material');
  const { readLightEpisodeFoundation } = await import('@/lib/light-foundation-reader');
  const handoffFor = async (projectId: string, episode: { id: string; number: number }) => attachEpisodeMaterials(await readLightEpisodeFoundation(projectId, episode.number, db), await service.readSeriesDirectionProjection(projectId, episode.id, { db }), []);
  const require = createRequire(import.meta.url);
  const { makeEpisodeInput } = require('../runtime/storyboard-v4/input.mjs');
  const { buildRequest } = require('../runtime/storyboard-v4/core/core.mjs');
  const user = await db.user.create({ data: { username: 'direction-admin', email: 'direction@synthetic.invalid', passwordHash: 'synthetic' } });
  const create = async (title: string, long = false) => {
    const project = await db.project.create({ data: { title, roles: { create: { userId: user.id, role: 'ADMIN' } }, episodes: { create: [1, 2].map(number => ({
      number, title: `第${number}集`, content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n△甲放下杯子。\n甲：我会帮你。\n${long && number === 1 ? ('甲：' + 'A'.repeat(100) + '。\n').repeat(250) : ''}`
    })) } } });
    await preprocessProject(project.id, db);
    return project;
  };
  const get = (id: string) => service.getSeriesDirectionWorkspace(id, user.id, { db });
  const addAuthorContext = async (projectId: string, authorText: string) => {
    const episodes = await db.episode.findMany({ where: { projectId }, orderBy: { number: 'asc' } });
    let offset = authorText.length;
    const sections = [{ key: 'author', kind: 'BACKGROUND', start: 0, end: offset }, ...episodes.map(episode => { const start = offset; offset += episode.content.length; return { key: `ep${episode.number}`, kind: 'EPISODE', episodeNumber: episode.number, start, end: offset }; })];
    await db.sceneSnapshot.create({ data: { projectId, sceneKey: 'SOURCE_IMPORT', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }), content: JSON.stringify({ sourceText: authorText + episodes.map(episode => episode.content).join(''), sourceStructure: { version: 'SOURCE_STRUCTURE_V1', sections, issues: [] } }) } });
  };
  const response = (stage: string, value: ReturnType<typeof request>, include = true) => stage === 'F2'
    ? { format: 'ASSET_CATALOG_V2', coverage: value.scope, assets: [{ name: '甲', type: 'CH', role: '主角', episodes: value.scope, sceneRefs: value.scope.map((episode: number) => [episode, `${episode}-1`]), preparation: { mode: 'REFERENCE' } }] }
    : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: value.scope, changes: {}, ...(include ? { seriesDirection: value.seriesDirectionPreparation.mode === 'FINAL' ? { content } : { signals: [{ episode: value.scope[0], quote: value.source.episodes[0].lines.find((line: [number, string]) => line[1].includes('甲：'))[1].trim().slice(0, 100), reading: '行动与对白呈现支持与犹疑；单个片段不足以锁定全剧调性。' }] } } : {}) };
  const run = async (id: string, include = true) => {
    const calls: Array<{ stage: string; input: ReturnType<typeof request> }> = [];
    const task = await delivery.queueFoundationDelivery(id, {}, db);
    await delivery.executeFoundationDelivery(id, task.id, { db, stageRunner: async (stage, prompt) => {
      const value = request(prompt); calls.push({ stage, input: value });
      if (include && stage === 'Q1') assert.ok(value.seriesDirectionPreparation, 'The existing Q1 source-reading request must carry the direction task; no separate whole-script call.');
      return out(response(stage, value, include));
    } });
    return { calls, state: await delivery.getFoundationDeliveryState(id, db) };
  };
  try {
    const project = await create('shared whole-script reading');
    const before = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } });
    const { calls, state } = await run(project.id);
    assert.equal(state.complete, true, state.task?.error ?? '');
    assert.deepEqual(calls.map(call => call.stage), ['F2', 'Q1']);
    assert.equal(calls[0].input.seriesDirectionPreparation, undefined, 'Do not duplicate the direction task in the asset author.');
    assert.equal(calls[1].input.seriesDirectionPreparation.mode, 'FINAL');
    assert.deepEqual(calls[1].input.seriesDirectionPreparation.priorSignals, [], 'The first full-scope call needs no duplicate earlier synopsis.');
    let view = await get(project.id);
    assert.deepEqual(view.draft?.content, content);
    assert.equal(view.status, 'UNCONFIRMED'); assert.equal(view.current, null, 'AI cannot adopt its own direction.');
    assert.equal(view.foundationPreparation?.status, 'CANDIDATE_READY');
    assert.equal(view.foundationPreparation?.extraCalls, 0);
    assert.equal(await db.pipelineRun.count({ where: { projectId: project.id, stageCode: 'SERIES_DIRECTION' } }), 0);
    await assert.rejects(service.generateSeriesDirectionCandidate(project.id, user.id, { action: 'generate', stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, costAcknowledged: true }, { db, runner: async () => { throw new Error('A reusable candidate must not trigger another full-script read.'); } }), (error: unknown) => (error as { code?: string }).code === 'DIRECTION_REUSE');
    assert.equal(await db.pipelineRun.count({ where: { projectId: project.id, stageCode: 'SERIES_DIRECTION' } }), 0, 'Reject redundant generation before creating a paid run.');
    const episode = before[0];
    const unconfirmed = await handoffFor(project.id, episode);
    assert.equal(unconfirmed.packet.upstream.seriesDirection.status, 'UNCONFIRMED');
    view = await service.mutateSeriesDirection(project.id, user.id, { action: 'confirm', stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, draftHash: view.draft!.hash, coverageAcknowledged: true }, { db });
    assert.equal(view.status, 'CONFIRMED', 'An explicitly acknowledged shared-reading candidate can be approved once, without a paid re-read.');
    for (const currentEpisode of before) {
      const handoff = await handoffFor(project.id, currentEpisode);
      const built = makeEpisodeInput({ episode: currentEpisode, project, handoff, inputProtocol: 'upstream-material-v2' });
      const sent = buildRequest({ stage: 'plan', source: built.source, settings: { fantasyMode: 'off', maxUnits: null } });
      const actual = JSON.parse(sent.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]).source.context;
      assert.equal(actual.seriesDirection.brief, view.brief, 'Verify the actual Stage3 prompt, not only a saved direction card.');
      assert.ok(Array.from(actual.seriesDirection.brief).length <= 600);
      assert.equal(actual.seriesDirection.priorSignals, undefined, 'Intermediate evidence/history never accompanies each Stage3 job.');
    }
    const cardCount = await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: 'SERIES_DIRECTION_CARD' } });
    await get(project.id); await get(project.id);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: 'SERIES_DIRECTION_CARD' } }), cardCount, 'Navigation/read does not generate new candidates.');
    await assert.rejects(delivery.queueFoundationDelivery(project.id, {}, db), /已整理完成|无需重复调用/);
    assert.deepEqual(await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } }), before);

    const long = await create('progressive evidence across complete source fragments', true);
    const longAuthor = '背景资料\n作者明确：全剧以互信为主，允许单集低谷。\n';
    await addAuthorContext(long.id, longAuthor);
    const longResult = await run(long.id);
    assert.equal(longResult.state.complete, true, longResult.state.task?.error ?? '');
    const edits = longResult.calls.filter(call => call.stage === 'Q1');
    assert.ok(edits.length > 1);
    assert.ok(edits.slice(0, -1).every(call => call.input.seriesDirectionPreparation.mode === 'COLLECT'));
    assert.equal(edits.at(-1)!.input.seriesDirectionPreparation.mode, 'FINAL');
    assert.ok(edits.at(-1)!.input.seriesDirectionPreparation.priorSignals.length > 0);
    assert.ok(edits.slice(0, -1).every(call => call.input.seriesDirectionPreparation.priorSignals.length === 0), 'Earlier parts do not repeatedly read the growing evidence list.');
    assert.ok(edits.slice(0, -1).every(call => !call.input.seriesDirectionPreparation.background), 'An ephemeral early read cannot remember the author appendix for the final decision; defer it rather than send it twice.');
    assert.equal(edits.at(-1)!.input.seriesDirectionPreparation.background[0][1], longAuthor, 'The actual final request receives the complete author direction, not only its unread file path or earlier receipt.');
    assert.equal((await get(long.id)).foundationPreparation?.status, 'CANDIDATE_READY');

    const legacy = await create('missing optional direction must not rebuy a valid catalogue');
    const legacyResult = await run(legacy.id, false);
    assert.equal(legacyResult.state.complete, true, legacyResult.state.task?.error ?? '');
    assert.deepEqual(legacyResult.calls.map(call => call.stage), ['F2', 'Q1']);
    const missing = await get(legacy.id);
    assert.equal(missing.draft, null);
    assert.equal(missing.foundationPreparation?.status, 'NEEDS_SUPPLEMENT');
    assert.match(missing.foundationPreparation?.message ?? '', /未|补|缺/);
    assert.equal(await db.pipelineRun.count({ where: { projectId: legacy.id } }), 2);

    const malformed = await create('direction format error is not catalogue damage');
    const malformedTask = await delivery.queueFoundationDelivery(malformed.id, {}, db), malformedCalls: string[] = [];
    await delivery.executeFoundationDelivery(malformed.id, malformedTask.id, { db, stageRunner: async (stage, prompt) => {
      const value = request(prompt); malformedCalls.push(stage);
      return out(stage === 'F2' ? response(stage, value) : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: value.scope, changes: { scenes: [{ episode: 1, sceneKey: '1-1', weather: '雨' }] }, seriesDirection: { content: { ...content, primaryTone: '字'.repeat(31) } } });
    } });
    assert.equal((await delivery.getFoundationDeliveryState(malformed.id, db)).complete, true);
    assert.deepEqual(malformedCalls, ['F2', 'Q1']);
    assert.equal((await get(malformed.id)).foundationPreparation?.status, 'NEEDS_SUPPLEMENT');
    assert.equal((await db.scriptScene.findFirstOrThrow({ where: { episode: { projectId: malformed.id, number: 1 }, sceneKey: '1-1' } })).weather, '雨', 'Correct Q1 changes survive a malformed optional direction.');

    const backgroundProject = await create('author context enters the shared reading once');
    const authorText = '背景资料\n甲内向，但愿意帮助朋友。\n作者方向资料：全剧以互信为主，允许单集低谷。\n';
    await addAuthorContext(backgroundProject.id, authorText);
    const backgroundResult = await run(backgroundProject.id);
    assert.equal(backgroundResult.state.complete, true, backgroundResult.state.task?.error ?? '');
    assert.equal(backgroundResult.calls.filter(call => call.stage === 'Q1').flatMap(call => call.input.seriesDirectionPreparation.background ?? []).filter((row: string[]) => row[1] === authorText).length, 1);
    assert.equal(backgroundResult.calls.filter(call => call.stage === 'Q1').map(call => JSON.stringify(call.input)).join('').split(JSON.stringify(authorText).slice(1, -1)).length - 1, 1, 'The full author context is supplied once.');
    assert.equal(JSON.stringify(backgroundResult.calls.find(call => call.stage === 'Q1')!.input).split('甲内向，但愿意帮助朋友。').length - 1, 1, 'Fact metadata must reference the exact supplied author context, not repeat its body.');
    const { seriesDirectionPreparation: _directionExtension, ...paidBody } = backgroundResult.calls.find(call => call.stage === 'Q1')!.input;
    const oldBody = { ...paidBody, facts: { ...paidBody.facts, rows: paidBody.facts.rows.map((row: unknown[]) => {
      const origin = row[0] as [string, string, number, number];
      return origin[0] === 'CONTEXT' && origin[1] === 'author' && row.length === 5 ? [...row, authorText.slice(origin[2], origin[3])] : row;
    }) } };
    assert.equal(delivery.costFingerprint('Q1', oldBody, [{ key: 'author', text: authorText }]), delivery.costFingerprint('Q1', backgroundResult.calls.find(call => call.stage === 'Q1')!.input, [{ key: 'author', text: authorText }]), 'The side output and proven body factoring cannot turn the same catalogue work into a new paid request.');
    assert.equal((await get(backgroundProject.id)).foundationPreparation?.status, 'CANDIDATE_READY');

    const concurrent = await create('human direction saved while Q1 is in flight');
    const concurrentTask = await delivery.queueFoundationDelivery(concurrent.id, {}, db);
    let humanHash: string | undefined;
    await delivery.executeFoundationDelivery(concurrent.id, concurrentTask.id, { db, stageRunner: async (stage, prompt) => {
      const value = request(prompt);
      if (stage === 'Q1') {
        const human = await get(concurrent.id);
        humanHash = (await service.mutateSeriesDirection(concurrent.id, user.id, { action: 'save', stateToken: human.stateToken, sourceVersion: human.source.sourceVersion, coverageAcknowledged: true, content: { ...content, primaryTone: '人的选择优先' } }, { db })).draft!.hash;
      }
      return out(response(stage, value));
    } });
    assert.equal((await delivery.getFoundationDeliveryState(concurrent.id, db)).complete, true);
    assert.equal((await get(concurrent.id)).draft?.hash, humanHash, 'A late automatic candidate never overwrites the human draft.');
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: concurrent.id, sceneKey: 'SERIES_DIRECTION_CARD' } }), 2, 'The late side candidate remains in history.');
    const lateHistory = await get(concurrent.id), highestRevision = Math.max(...lateHistory.history.map(row => row.card?.revision ?? 0));
    const nextHuman = await service.mutateSeriesDirection(concurrent.id, user.id, { action: 'save', stateToken: lateHistory.stateToken, sourceVersion: lateHistory.source.sourceVersion, coverageAcknowledged: true, content: { ...content, primaryTone: '人的新修订' } }, { db });
    assert.ok(nextHuman.draft!.revision > highestRevision, 'A late side candidate must reserve its immutable revision, without replacing the human draft.');

    const replay = await create('paid Q1 reply is reused after stop before acceptance');
    const replayTask = await delivery.queueFoundationDelivery(replay.id, {}, db);
    // Stop after the actual paid receipt is durable, not while its outcome is still UNKNOWN.
    const interruptedDb = db.$extends({ query: { pipelineRun: { async update({ args, query }) {
      const result = await query(args);
      if (result.projectId === replay.id && result.stageCode === 'Q1' && args.data.status === 'SUCCEEDED') await delivery.stopFoundationDelivery(replay.id, replayTask.id, db);
      return result;
    } } } });
    await delivery.executeFoundationDelivery(replay.id, replayTask.id, { db: interruptedDb as unknown as typeof db, stageRunner: async (stage, prompt) => {
      return out(response(stage, request(prompt)));
    } });
    assert.equal((await get(replay.id)).draft, null);
    const resumedTask = await delivery.queueFoundationDelivery(replay.id, {}, db);
    let replayPaid = 0;
    await delivery.executeFoundationDelivery(replay.id, resumedTask.id, { db, stageRunner: async () => { replayPaid++; throw new Error('Use the existing complete paid reply.'); } });
    const recovered = await delivery.getFoundationDeliveryState(replay.id, db);
    assert.equal(recovered.complete, true, recovered.task?.error ?? ''); assert.equal(replayPaid, 0);
    assert.equal((await get(replay.id)).foundationPreparation?.status, 'CANDIDATE_READY');

    const changed = await create('source drift does not mix direction versions');
    const changedTask = await delivery.queueFoundationDelivery(changed.id, {}, db);
    await delivery.executeFoundationDelivery(changed.id, changedTask.id, { db, stageRunner: async (stage, prompt) => {
      const value = request(prompt);
      if (stage === 'Q1') await db.episode.updateMany({ where: { projectId: changed.id, number: 1 }, data: { content: before[0].content + '甲：新的原文。\n' } });
      return out(response(stage, value));
    } });
    assert.equal((await get(changed.id)).draft, null, 'The in-flight old-source candidate cannot become the new-source draft.');
    assert.equal(await db.pipelineRun.count({ where: { projectId: changed.id } }), 2, 'Source drift never auto-retries the whole read.');
    console.log('PASS: shared Stage1 direction generation, fragment coverage, explicit approval, actual Stage3 supply, no extra model calls or source mutation.');
    console.log(JSON.stringify({ fixtureProjects: 8, smallStage1Calls: calls.length, fragmentedStage1Calls: longResult.calls.length, recoveredNewCalls: replayPaid, realModelCalls: 0, tokenMeasurement: 'NOT_PERFORMED' }));
  } finally { await db.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
