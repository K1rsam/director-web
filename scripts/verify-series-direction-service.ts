import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire, registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { FoundationRunUsage } from "../lib/foundation-run-usage";
import { suppressGeneratedPrismaEnv } from "./compare-three-stage-support.mjs";
import type { SystemPresentation } from '../lib/system-presentation';

assert.ok(existsSync(path.resolve("lib/series-direction-service.ts")), "全剧方向必须有可信服务层，不能只保存在浏览器或纯函数中");
let db: PrismaClient;
const content = { settingTags: ["都市"], mechanismTags: [], arcTags: ["关系成长"], primaryTone: "克制温情", secondaryTones: ["轻喜剧"], audiencePromise: "看见人物从试探走向彼此信任。", expressionRules: ["用反应和距离表现情感变化。"], avoidances: ["不把真实伤害当作笑料。"], episodeFlexibility: "单集可悲伤、悬疑或低谷，事实与揭示时点优先。" };
const hasCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

async function systemPresentationChecks(service: typeof import('../lib/series-direction-service'), actorId: string) {
  const project = await db.project.create({ data: { title: '隔离系统表现', executionMode: 'API', roles: { create: { userId: actorId, role: 'ADMIN' } }, episodes: { create: [
    { number: 1, content: '1-1 房间 日 内\n△甲停步。\n系统：任务开始。' },
    { number: 2, content: '2-1 房间 夜 内\n裁决系统：失败。' },
  ] } } });
  const episodes = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } });
  let sourceOffset = 0;
  const sections = episodes.map(episode => { const start = sourceOffset; sourceOffset += episode.content.length; return { key: `ep${episode.number}`, kind: 'EPISODE', episodeNumber: episode.number, start, end: sourceOffset }; });
  await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'SOURCE_IMPORT', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }), content: JSON.stringify({ sourceText: episodes.map(episode => episode.content).join(''), sourceStructure: { version: 'SOURCE_STRUCTURE_V1', sections, issues: [] } }) } });
  const system = { id: 'guide', identity: '引导系统', mode: 'SPRITE' as const, carrierNotes: '观众可见的小光点；提示结束后收起',
    sourceEvidence: [{ evidenceId: `episode:${episodes[0].id}`, quote: '系统：任务开始。' }], sourceCarrier: null,
    visibility: 'AUDIENCE_ONLY' as const, audibility: 'SOURCE_ONLY' as const, contact: 'NO_ADDED_CONTACT' as const, originalVoice: 'PRESERVE_SOURCE' as const, screenText: 'NO_ADDED_TEXT' as const, rationale: null };
  const systemPresentation = { systems: [system, { ...system, id: 'judge', identity: '裁决系统', mode: 'VOICE_ONLY' as const, sourceEvidence: [{ evidenceId: `episode:${episodes[1].id}`, quote: '裁决系统：失败。' }] }] };
  let view = await service.getSeriesDirectionWorkspace(project.id, actorId, { db });
  const save = (value: SystemPresentation = systemPresentation) => service.mutateSeriesDirection(project.id, actorId, { action: 'save', stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, content: { ...content, systemPresentation: value }, coverageAcknowledged: true }, { db });
  await assert.rejects(() => save({ systems: [{ ...system, sourceEvidence: [{ evidenceId: `episode:${episodes[0].id}`, quote: '伪造的系统原话。' }] }] }), hasCode('DIRECTION_SYSTEM_EVIDENCE'), 'free editable text cannot prove its own source');
  view = await save();
  assert.equal((await service.readSeriesDirectionProjection(project.id, episodes[0].id, { db })).projection, null, 'a saved choice is not adopted');
  view = await service.mutateSeriesDirection(project.id, actorId, { action: 'confirm', stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, draftHash: view.draft!.hash, coverageAcknowledged: true }, { db });
  const old = JSON.stringify(view.current);
  const first = await service.readSeriesDirectionProjection(project.id, episodes[0].id, { db });
  assert.equal(first.projection!.systemPresentation!.systems.length, 1);
  assert.equal((await service.readProjectSeriesDirectionProjection(project.id, { db })).projection!.systemPresentation!.systems.length, 2, 'project asset input includes all actual identities');
  const { createEmptyDocument } = await import('../lib/foundation-document');
  const { loadFoundationInputs } = await import('../lib/foundation-state');
  const document = createEmptyDocument(await loadFoundationInputs(project.id));
  document.workflow = 'LIGHT_STAGE1_V1'; document.editorialCoverage = [1, 2];
  document.f2 = { format: 'ASSET_CATALOG_V1', coverage: [1, 2], issues: [], assets: [{ key: 'guide', name: '引导系统', type: 'PROP', aliases: [], description: '', sourceRefs: [], appearances: [], usageEpisodes: [1], variants: [], preparation: { mode: 'REFERENCE' } }], episodes: [{ number: 1, context: '', assetKeys: ['guide'] }, { number: 2, context: '', assetKeys: [] }] };
  await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'FOUNDATION_DOCUMENT', content: JSON.stringify(document) } });
  const prompts = await import('../lib/asset-prompt-service');
  const workspace = await prompts.loadAssetPromptWorkspace(project.id);
  assert.equal(workspace.seriesDirection!.systemPresentation!.systems.length, 2, 'actual asset workspace retains structured choices');
  const facts = await import('../lib/asset-visual-facts-service');
  await facts.ensureAssetVisualFacts(project.id, async input => {
    const packet = JSON.parse(input.prompt), data = { batches: packet.chunks.map((chunk: { id: string }) => ({ coveredChunkId: chunk.id, facts: [], issues: [] })) };
    return { data, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null };
  });
  let actualInput: Record<string, any> | undefined;
  const designed = await prompts.generateAssetPrompt(project.id, 'guide', 0, async input => {
    actualInput = JSON.parse(input.prompt);
    return { data: { key: 'guide', body: '小光点的独立轮廓。', suggestions: '' }, stdout: '', stderr: '', sessionId: null };
  });
  assert.ok(actualInput?.systemPresentation?.systems.some((item: { id: string }) => item.id === 'guide'), designed.error || 'real design runner must receive the approved structured choice');
  assert.deepEqual(actualInput?.systemPresentation?.decision, { id: first.projection!.id, revision: first.projection!.revision, sourceVersion: first.projection!.sourceVersion, cardHash: first.projection!.cardHash }, 'actual asset runner must receive the same confirmed direction identity as native authoring');
  const { readLightEpisodeFoundation } = await import('../lib/light-foundation-reader');
  const { attachEpisodeMaterials } = await import('../lib/episode-upstream-material');
  const handoff = attachEpisodeMaterials(await readLightEpisodeFoundation(project.id, 1, db), first, []);
  assert.equal(handoff.packet.upstream.seriesDirection.projection!.systemPresentation!.systems[0].mode, 'SPRITE', 'actual episode handoff contains the same adopted decision');
  const { readProductionEpisodeHandoff } = await import('../lib/episode-upstream-material');
  const actualHandoff = await readProductionEpisodeHandoff(project.id, 1);
  const { makeEpisodeInput } = createRequire(import.meta.url)('../runtime/storyboard-v4/input.mjs');
  const { buildRequest, captureRules } = createRequire(import.meta.url)('../runtime/storyboard-v4/core/core.mjs');
  const native = makeEpisodeInput({ episode: episodes[0], project, handoff: actualHandoff, inputProtocol: 'upstream-material-v2' });
  const rules = captureRules();
  const request = buildRequest({ stage: 'plan', source: native.source, rulesSnapshot: rules, settings: { maxUnits: null, fantasyMode: 'off' } });
  const actualPacket = JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
  const actualSystem = actualPacket.source.context.seriesDirection.systemPresentation;
  assert.equal(rules.systemPresentationVersion, 'SYSTEM_PRESENTATION_V1');
  assert.equal(actualSystem.schemaVersion, 'SYSTEM_PRESENTATION_V1');
  assert.equal(actualSystem.decision.cardHash, view.current!.hash);
  assert.equal(actualSystem.systems[0].id, 'guide');
  assert.equal(actualSystem.systems[0].sourceEvidence[0].episodeId, episodes[0].id);
  assert.equal(actualSystem.systems[0].originalVoice, 'PRESERVE_SOURCE');
  assert.equal(actualSystem.systems[0].mode, 'SPRITE');
  assert.match(request.prompt, /系统音.*画内.*嘴/);
  assert.match(request.prompt, /必要提示.*off/);
  view = await save({ systems: [{ ...system, mode: 'HUD' }] });
  assert.equal(JSON.stringify(view.current), old, 'editing the carrier preserves the frozen adopted record');
  view = await service.mutateSeriesDirection(project.id, actorId, { action: 'revoke', stateToken: view.stateToken, sourceVersion: view.source.sourceVersion }, { db });
  assert.equal((await service.readSeriesDirectionProjection(project.id, episodes[0].id, { db })).projection, null);
  assert.equal((await prompts.loadAssetPromptWorkspace(project.id)).seriesDirection!.systemPresentation, undefined);
  assert.ok(view.history.some(item => JSON.stringify(item.card) === old));
  view = await service.mutateSeriesDirection(project.id, actorId, { action: 'confirm', stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, draftHash: view.draft!.hash, coverageAcknowledged: true }, { db });
  await db.episode.update({ where: { id: episodes[0].id }, data: { content: `${episodes[0].content}\n△甲转身。` } });
  assert.equal((await service.readSeriesDirectionProjection(project.id, episodes[0].id, { db })).projection, null);
  assert.equal((await prompts.loadAssetPromptWorkspace(project.id)).seriesDirection!.systemPresentation, undefined, 'source-stale decisions do not reach asset design');
  assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 0, 'save/confirm/revoke have no production calls');
  const q1Project = await db.project.create({ data: { title: '系统候选共用Q1', executionMode: 'API', roles: { create: { userId: actorId, role: 'ADMIN' } }, episodes: { create: { number: 1, content: '第1集\n1-1 房间 日 内\n人物：甲\n△甲停步。\n系统：任务开始。' } } } });
  const q1Episode = await db.episode.findFirstOrThrow({ where: { projectId: q1Project.id } });
  await db.sceneSnapshot.create({ data: { projectId: q1Project.id, sceneKey: 'SOURCE_IMPORT', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }), content: JSON.stringify({ sourceText: q1Episode.content, sourceStructure: { version: 'SOURCE_STRUCTURE_V1', sections: [{ key: 'ep1', kind: 'EPISODE', episodeNumber: 1, start: 0, end: q1Episode.content.length }], issues: [] } }) } });
  const { preprocessProject } = await import('../lib/project-preprocess');
  await preprocessProject(q1Project.id, db);
  const delivery = await import('../lib/foundation-delivery');
  const task = await delivery.queueFoundationDelivery(q1Project.id, {}, db);
  const calls: string[] = [];
  await delivery.executeFoundationDelivery(q1Project.id, task.id, { db, stageRunner: async (stage, prompt) => {
    calls.push(stage);
    const packet = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
    const data = stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: packet.scope, assets: [{ name: '甲', type: 'CH', episodes: [1], sceneRefs: [[1, '1-1']], preparation: { mode: 'REFERENCE' } }] }
      : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: packet.scope, changes: {}, seriesDirection: { content: { ...content, systemPresentation: { systems: [{ ...system, sourceEvidence: [{ evidenceId: `episode:${q1Episode.id}`, quote: '系统：任务开始。' }] }] } } } };
    if (stage === 'Q1') {
      assert.equal(packet.seriesDirectionPreparation.mode, 'FINAL');
      assert.deepEqual(packet.seriesDirectionPreparation.systemSourceAnchors, [[1, `episode:${q1Episode.id}`]]);
      assert.ok(prompt.includes('系统声道') && prompt.includes('voiceBindings'), 'actual existing Q1 prompt contains system voice/source constraints');
    }
    return { data, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null };
  } });
  assert.deepEqual(calls, ['F2', 'Q1'], 'system recommendations add no role or paid call');
  const candidate = await service.getSeriesDirectionWorkspace(q1Project.id, actorId, { db });
  assert.equal(candidate.draft!.content.systemPresentation!.systems[0].mode, 'SPRITE');
  assert.equal(candidate.current, null, 'Q1 recommendations remain unadopted');
  assert.equal(candidate.foundationPreparation!.status, 'CANDIDATE_READY');
  assert.equal(candidate.foundationPreparation!.extraCalls, 0);
  console.log('PASS system presentation service: exact source proof, save/confirm/revoke/stale/history, actual asset runner, actual handoff -> native input -> plan/cardHash/voice boundaries, existing F2+Q1 only; disposable DB and injected runners');
}

async function main() {
  const service = await import("../lib/series-direction-service");
  const [admin, reviewer, operator, outsider] = await Promise.all(["admin", "reviewer", "operator", "outsider"].map(username => db.user.create({ data: { username, email: `${username}@synthetic.invalid`, passwordHash: "synthetic" } })));
  await systemPresentationChecks(service, admin.id);
  if (process.argv.includes('--system-only')) return;
  const project = await db.project.create({ data: { title: "合成全剧方向测试", executionMode: "API", episodes: { create: [{ number: 1, title: "相遇", content: "1-1 日 内 屋\n甲小心试探。" }, { number: 2, title: "信任", content: "2-1 夜 外 街\n乙把伞交给甲。" }] }, roles: { create: [{ userId: admin.id, role: "ADMIN" }, { userId: reviewer.id, role: "REVIEWER" }, { userId: operator.id, role: "OPERATOR" }] } } });
  const background = "作者资料：关系从试探走向信任。\n";
  const episodes = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } });
  const sourceText = background + episodes.map(e => e.content).join("");
  let offset = background.length;
  const sections = [{ key: "background", kind: "BACKGROUND", start: 0, end: offset }, ...episodes.map(e => { const start = offset; offset += e.content.length; return { key: `ep${e.number}`, kind: "EPISODE", episodeNumber: e.number, start, end: offset }; })];
  const sourceImport = await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: "SOURCE_IMPORT", metadata: JSON.stringify({ schema: "IMPORTED_SOURCE_TEXT_V2" }), content: JSON.stringify({ sourceText, sourceStructure: { version: "SOURCE_STRUCTURE_V1", sections, issues: [] } }) } });
  const get = (actorId = admin.id) => service.getSeriesDirectionWorkspace(project.id, actorId, { db });
  const mutate = (actorId: string, command: Parameters<typeof service.mutateSeriesDirection>[2]) => service.mutateSeriesDirection(project.id, actorId, command, { db });
  const save = async (view: Awaited<ReturnType<typeof get>>, primaryTone = content.primaryTone, actorId = operator.id, acknowledged = true) => mutate(actorId, { action: "save", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, content: { ...content, primaryTone }, coverageAcknowledged: acknowledged });
  const confirm = (view: Awaited<ReturnType<typeof get>>, actorId = reviewer.id) => mutate(actorId, { action: "confirm", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, draftHash: view.draft!.hash, coverageAcknowledged: true });

  let view = await get();
  assert.equal(view.status, "UNCONFIRMED"); assert.equal(view.brief, null);
  assert.equal(view.source.episodes.length, 2); assert.ok(view.source.evidence.some(e => e.kind === "BACKGROUND"));
  assert.equal((await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: { startsWith: "SERIES_DIRECTION" } } })), 0, "GET must not create direction state or run a model");
  await assert.rejects(() => get(outsider.id), hasCode("DIRECTION_FORBIDDEN"));
  const saved = await save(view);
  await assert.rejects(() => confirm(saved, operator.id), hasCode("DIRECTION_FORBIDDEN"));
  await assert.rejects(() => mutate(outsider.id, { action: "revoke", stateToken: saved.stateToken, sourceVersion: saved.source.sourceVersion }), hasCode("DIRECTION_FORBIDDEN"));
  await assert.rejects(() => mutate(admin.id, { action: "confirm", stateToken: saved.stateToken, sourceVersion: saved.source.sourceVersion, draftHash: "forged", coverageAcknowledged: true }), hasCode("DIRECTION_CONFLICT"));
  await assert.rejects(() => save(view), hasCode("DIRECTION_CONFLICT"));
  view = await confirm(saved);
  assert.equal(view.current?.confirmation?.actorId, reviewer.id);
  assert.equal(view.status, "CONFIRMED");
  const first = await service.readSeriesDirectionProjection(project.id, episodes[0].id, { db });
  const second = await service.readSeriesDirectionProjection(project.id, episodes[1].id, { db });
  assert.equal(first.projection!.brief, second.projection!.brief); assert.equal(first.projection!.cardHash, second.projection!.cardHash);
  assert.ok(Array.from(first.projection!.brief).length <= 600);
  const oldCurrent = JSON.stringify(view.current);
  const revised = await save(view, "温和现实主义");
  assert.equal(JSON.stringify(revised.current), oldCurrent, "editing draft never changes the current adopted card");
  assert.notEqual(revised.draft!.hash, revised.current!.hash);
  await assert.rejects(() => confirm(view), hasCode("DIRECTION_CONFLICT"));
  const race = await Promise.allSettled([save(revised, "含蓄真挚"), save(revised, "克制有力")]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1, "CAS accepts only one concurrent writer");
  view = await get();
  const noCoverage = await save(view, content.primaryTone, operator.id, false);
  await assert.rejects(() => confirm(noCoverage), hasCode("DIRECTION_COVERAGE"));
  view = await save(noCoverage);
  await db.episode.update({ where: { id: episodes[1].id }, data: { content: `${episodes[1].content}\n末集新增事实。` } });
  const stale = await get(); assert.equal(stale.status, "STALE"); assert.equal(stale.brief, null);
  assert.equal((await service.readSeriesDirectionProjection(project.id, episodes[0].id, { db })).projection, null);
  await assert.rejects(() => confirm(view), hasCode("DIRECTION_STALE"));
  assert.equal(JSON.stringify(stale.current), oldCurrent);
  const refreshed = await save(stale);
  view = await confirm(refreshed);
  const beforeBackground = view.source.sourceVersion;
  await db.sceneSnapshot.update({ where: { id: sourceImport.id }, data: { content: JSON.stringify({ sourceText: sourceText.replace("关系", "人物"), sourceStructure: { version: "SOURCE_STRUCTURE_V1", sections, issues: [] } }) } });
  const changedBackground = await get(); assert.notEqual(changedBackground.source.sourceVersion, beforeBackground); assert.equal(changedBackground.status, "STALE");
  view = await mutate(admin.id, { action: "revoke", stateToken: changedBackground.stateToken, sourceVersion: changedBackground.source.sourceVersion });
  assert.equal(view.current, null); assert.equal(view.status, "UNCONFIRMED"); assert.ok(view.history.some(h => h.card?.status === "CONFIRMED"));
  console.log("PASS persisted permissions, server actor, draft/current separation, CAS race, full-source stale and preserved history");

  let calls = 0;
  const runner: NonNullable<Parameters<typeof service.generateSeriesDirectionCandidate>[3]>["runner"] = async input => {
    calls++; assert.equal(input.provider, "API"); assert.equal(input.role.code, "F1"); assert.equal(input.sessionMode, "ephemeral");
    const packet = JSON.parse(input.prompt.split("INPUT_JSON:\n")[1]);
    const data = packet.phase === "evidence" ? { coverage: packet.units.map((u: { id: string }) => u.id), summary: "人物经历试探与信任变化。", evidence: packet.units.map((u: { id: string; text: string }) => ({ unitId: u.id, quote: Array.from(u.text).slice(0, 20).join(""), signal: "关系变化的原文依据" })) } : { content };
    return { data, rawOutput: JSON.stringify(data), stdout: "", stderr: "", sessionId: null };
  };
  await assert.rejects(() => service.generateSeriesDirectionCandidate(project.id, operator.id, { action: "generate", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, costAcknowledged: false }, { db, runner }), hasCode("DIRECTION_COST_ACK"));
  assert.equal(calls, 0);
  const generated = await service.generateSeriesDirectionCandidate(project.id, operator.id, { action: "generate", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, costAcknowledged: true }, { db, runner });
  assert.equal(calls, generated.generation!.completedCalls); assert.equal(generated.draft!.status, "DRAFT"); assert.equal(generated.current, null);
  assert.equal(generated.draft!.reviewedEpisodeIds.length, 0, "model receipt is never fabricated human coverage");
  await assert.rejects(() => confirm(generated), hasCode("DIRECTION_COVERAGE"));
  const packets = await db.sceneSnapshot.findMany({ where: { projectId: project.id, sceneKey: "SERIES_DIRECTION_MODEL_INPUT" } });
  const packetText = packets.map(p => p.content).join("");
  assert.ok(packetText.includes("末集新增事实") && packetText.includes("作者资料"));
  view = await confirm(await save(generated));
  const adopted = view.current!.hash;
  let attempted = 0;
  const failed = await service.generateSeriesDirectionCandidate(project.id, admin.id, { action: "generate", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, costAcknowledged: true }, { db, runner: async () => { attempted++; throw Object.assign(new Error("synthetic transport timeout"), { rawOutput: "合成已返回正文" }); } });
  assert.equal(attempted, 1); assert.equal(failed.generation!.outcome, "UNKNOWN"); assert.equal(failed.current!.hash, adopted);
  assert.equal(failed.generation!.pending, false, "an exited request is not still generating");
  assert.equal(failed.generation!.held, true); assert.equal(failed.generation!.resumable, false, "unknown usage must not be treated as paid replayable progress");
  assert.ok((await db.sceneSnapshot.findMany({ where: { projectId: project.id, sceneKey: "SERIES_DIRECTION_MODEL_OUTPUT" } })).some(s => s.content.includes("合成已返回正文")));
  await assert.rejects(() => service.generateSeriesDirectionCandidate(project.id, admin.id, { action: "generate", stateToken: failed.stateToken, sourceVersion: failed.source.sourceVersion, costAcknowledged: true }, { db, runner }), hasCode("DIRECTION_GENERATION_PENDING"));
  const editable = await save(failed, "温柔而坚定"); assert.equal(editable.current!.hash, adopted, "manual editing remains available after unknown AI outcome");
  console.log("PASS explicit full-source candidate, ephemeral provider binding, real coverage acknowledgement, paid-output preservation and no unknown retry");
  view = await mutate(admin.id, { action: "release-generation", stateToken: editable.stateToken, sourceVersion: editable.source.sourceVersion, generationId: editable.generation!.id, unknownOutcomeAcknowledged: true });
  await db.episode.update({ where: { id: episodes[1].id }, data: { content: `开头标记${"长".repeat(48_100)}完整末尾标记` } });
  view = await get();
  const delivered: string[] = []; let manuallySavedHash: string | null = null;
  const concurrent = await service.generateSeriesDirectionCandidate(project.id, admin.id, { action: "generate", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, costAcknowledged: true }, { db, runner: async input => {
    const packet = JSON.parse(input.prompt.split("INPUT_JSON:\n")[1]);
    if (packet.phase === "evidence") delivered.push(...packet.units.map((u: { text: string }) => u.text));
    else { const manual = await save(await get(), "并发手工稿保留"); manuallySavedHash = manual.draft!.hash; }
    return runner!(input);
  } });
  assert.ok(delivered.join("").includes(`开头标记${"长".repeat(48_100)}完整末尾标记`), "long episodes are split but never truncated");
  assert.equal(concurrent.draft!.hash, manuallySavedHash); assert.equal(concurrent.generation!.outcome, "REVIEW_REQUIRED");
  assert.equal(concurrent.current!.hash, adopted); assert.ok(concurrent.history.some(h => h.card?.content.primaryTone === content.primaryTone));
  let sourceChangeCalls = 0;
  const inFlightChanged = await service.generateSeriesDirectionCandidate(project.id, admin.id, { action: "generate", stateToken: concurrent.stateToken, sourceVersion: concurrent.source.sourceVersion, costAcknowledged: true }, { db, runner: async input => {
    sourceChangeCalls++;
    await db.episode.update({ where: { id: episodes[0].id }, data: { content: `${episodes[0].content}\n调用过程中来源变化。` } });
    return runner!(input);
  } });
  assert.equal(sourceChangeCalls, 1, "source changes prevent all suffix calls");
  assert.equal(inFlightChanged.generation!.outcome, "UNKNOWN"); assert.equal(inFlightChanged.draft!.hash, manuallySavedHash);
  view = await mutate(admin.id, { action: "release-generation", stateToken: inFlightChanged.stateToken, sourceVersion: inFlightChanged.source.sourceVersion, generationId: inFlightChanged.generation!.id, unknownOutcomeAcknowledged: true });
  let invalidCalls = 0;
  view = await service.generateSeriesDirectionCandidate(project.id, admin.id, { action: "generate", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, costAcknowledged: true }, { db, runner: async input => {
    invalidCalls++; const result = await runner!(input); return { ...result, data: { ...result.data, coverage: [] } };
  } });
  assert.equal(invalidCalls, 1); assert.equal(view.generation!.outcome, "UNKNOWN"); assert.equal(view.draft!.hash, manuallySavedHash);
  view = await mutate(admin.id, { action: "release-generation", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, generationId: view.generation!.id, unknownOutcomeAcknowledged: true });
  const priorCount = await db.pipelineRun.count({ where: { projectId: project.id, stageCode: "SERIES_DIRECTION" } });
  await db.episode.update({ where: { id: episodes[1].id }, data: { content: "超".repeat(24_000 * 41) } });
  view = await get();
  assert.equal(view.generationPlan.allowed, false);
  await assert.rejects(() => service.generateSeriesDirectionCandidate(project.id, admin.id, { action: "generate", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, costAcknowledged: true }, { db, runner: async () => { throw new Error("must not call"); } }), hasCode("DIRECTION_BUDGET"));
  assert.equal(await db.pipelineRun.count({ where: { projectId: project.id, stageCode: "SERIES_DIRECTION" } }), priorCount);
  console.log("PASS long-source exact coverage, no overwrite of concurrent manual draft, source-change suffix stop, invalid evidence rejection and budget preflight");
  await db.episode.update({ where: { id: episodes[1].id }, data: { content: episodes[1].content } });
  view = await get();
  const late = await service.generateSeriesDirectionCandidate(project.id, admin.id, { action: "generate", stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, costAcknowledged: true }, { db, runner: async input => {
    if (JSON.parse(input.prompt.split("INPUT_JSON:\n")[1]).phase === "synthesis") {
      const active = await get();
      const released = await mutate(admin.id, { action: "release-generation", stateToken: active.stateToken, sourceVersion: active.source.sourceVersion, generationId: active.generation!.id, unknownOutcomeAcknowledged: true });
      await save(released, "结束等待后手工保存");
    }
    return runner!(input);
  } });
  const highestHistorical = Math.max(...late.history.flatMap(row => row.card ? [row.card.revision] : []));
  const afterLate = await save(late, "继续手工修订");
  assert.ok(afterLate.draft!.revision > highestHistorical, "late paid candidate is retained without reusing its revision number");
  console.log("PASS late result after manual release reserves a unique immutable revision");

  const modelResult = (input: Parameters<NonNullable<typeof runner>>[0], stdout: string) => {
    const packet = JSON.parse(input.prompt.split("INPUT_JSON:\n")[1]);
    const data = packet.phase === "evidence" ? { coverage: packet.units.map((u: { id: string }) => u.id), summary: "合成完整证据。", evidence: packet.units.map((u: { id: string; text: string }) => ({ unitId: u.id, quote: Array.from(u.text).slice(0, 20).join(""), signal: "合成来源证据" })) } : { content };
    return { data, rawOutput: JSON.stringify(data), stdout, stderr: "", sessionId: null };
  };
  const numericSummary = (value: Awaited<ReturnType<typeof get>>) => value.generation as unknown as { usage: FoundationRunUsage | null; callUsage: Array<{ call: number; provider: string; usage: FoundationRunUsage }> };
  const generate = (value: Awaited<ReturnType<typeof get>>, runner: NonNullable<Parameters<typeof service.generateSeriesDirectionCandidate>[3]>["runner"], actorId = admin.id) => service.generateSeriesDirectionCandidate(project.id, actorId, { action: "generate", stateToken: value.stateToken, sourceVersion: value.source.sourceVersion, costAcknowledged: true }, { db, runner });
  await db.project.update({ where: { id: project.id }, data: { executionMode: "CLI" } });
  let usageCalls = 0;
  const measured = await generate(await get(), async input => {
    usageCalls++; assert.equal(input.provider, "CLI");
    return modelResult(input, JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private-thinking-sentinel" } }) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: usageCalls * 10, cached_input_tokens: 3, output_tokens: usageCalls * 2, reasoning_output_tokens: 1 } }));
  });
  const cliUsage = numericSummary(measured);
  assert.equal(cliUsage.usage?.inputTokens, 30, "known CLI usage must not remain null");
  assert.equal(cliUsage.usage?.outputTokens, 6); assert.equal(cliUsage.usage?.totalTokens, 36); assert.equal(cliUsage.usage?.unknownCalls, 0);
  assert.deepEqual(cliUsage.callUsage.map(item => [item.call, item.provider, item.usage.totalTokens]), [[1, "CLI", 12], [2, "CLI", 24]]);
  assert.ok(!JSON.stringify(measured.generation).includes("private-thinking-sentinel") && !JSON.stringify(measured.generation).includes('"stdout"'));
  await db.project.update({ where: { id: project.id }, data: { executionMode: "API" } });
  const spoofedBody = JSON.stringify({ choices: [], usage: { prompt_tokens: 9000, completion_tokens: 1000, total_tokens: 10000 } });
  const apiLogs = await generate(await get(), async input => ({ ...modelResult(input, spoofedBody), stderr: "[DeepSeek deepseek-v4-flash 12ms prompt=30 completion=7 total=37 cache_hit=0 cache_miss=0 finish=stop request=synthetic]" }));
  const loggedUsage = numericSummary(apiLogs);
  assert.equal(loggedUsage.usage?.inputTokens, 60, "API counts come from the runner's real stderr envelope, not model-authored stdout");
  assert.equal(loggedUsage.usage?.outputTokens, 14); assert.equal(loggedUsage.usage?.totalTokens, 74); assert.equal(loggedUsage.usage?.unknownCalls, 0);
  assert.ok(loggedUsage.callUsage.every(item => item.usage.inputTokens === 30 && item.usage.cachedInputTokens === null && item.usage.uncachedInputTokens === null), "stderr cache placeholders do not prove zero cache usage");
  const bodyOnly = await generate(await get(), async input => ({ ...modelResult(input, spoofedBody), stderr: "[DeepSeek deepseek-v4-flash 12ms usage 未返回 finish=stop request=synthetic]" }));
  assert.equal(numericSummary(bodyOnly).usage?.totalTokens, null, "even a choices/usage shaped model body is not provider usage metadata");
  assert.equal(numericSummary(bodyOnly).usage?.unknownCalls, 2);
  usageCalls = 0;
  const apiFailure = await generate(await get(), async input => {
    usageCalls++;
    const stdout = JSON.stringify({ usage: { prompt_tokens: usageCalls === 1 ? 7 : 5, completion_tokens: usageCalls === 1 ? 3 : 2 }, choices: [{ message: { reasoning_content: "private-api-sentinel" } }] });
    if (usageCalls === 2) throw Object.assign(new Error("synthetic failure after recorded usage"), { stdout: spoofedBody, stderr: "模型正文不是有效JSON（finish_reason=length；prompt=5 completion=2 total=7；模型=deepseek-reasoner）" });
    return { ...modelResult(input, stdout), stderr: "[DeepSeek deepseek-v4-flash 9ms prompt=7 completion=3 total=10 cache_hit=0 cache_miss=0 finish=stop request=synthetic]" };
  });
  const apiUsage = numericSummary(apiFailure);
  assert.equal(apiFailure.generation?.outcome, "FAILED"); assert.equal(apiUsage.usage?.totalTokens, 17, "failed calls retain observed numeric usage");
  assert.equal(apiFailure.generation?.pending, false); assert.equal(apiFailure.generation?.held, true);
  assert.equal(apiFailure.generation?.resumable, false, "known billing without a complete response is not safe to replay or repurchase");
  let incompleteRetries = 0;
  await assert.rejects(() => service.generateSeriesDirectionCandidate(project.id, admin.id, { action: "resume", stateToken: apiFailure.stateToken, sourceVersion: apiFailure.source.sourceVersion, costAcknowledged: true }, { db, runner: async () => { incompleteRetries++; throw new Error("must not dispatch"); } }), hasCode("DIRECTION_RECOVERY"));
  assert.equal(incompleteRetries, 0);
  assert.equal(apiUsage.callUsage.length, 2); assert.equal(apiUsage.usage?.unknownCalls, 0);
  assert.ok(!JSON.stringify(apiFailure.generation).includes("private-api-sentinel") && !JSON.stringify(apiFailure.generation).includes('"stdout"'));
  view = await mutate(admin.id, { action: "release-generation", stateToken: apiFailure.stateToken, sourceVersion: apiFailure.source.sourceVersion, generationId: apiFailure.generation!.id, unknownOutcomeAcknowledged: true });
  usageCalls = 0;
  const partlyKnown = await generate(view, async input => {
    usageCalls++;
    if (usageCalls === 2) throw new Error("synthetic response missing");
    return { ...modelResult(input, spoofedBody), stderr: "[DeepSeek deepseek-v4-flash 9ms prompt=4 completion=? total=? cache_hit=0 cache_miss=0 finish=stop request=synthetic]" };
  });
  const partialUsage = numericSummary(partlyKnown);
  assert.equal(partlyKnown.generation?.outcome, "UNKNOWN"); assert.equal(partlyKnown.generation?.resumable, false);
  assert.equal(partialUsage.callUsage[0].usage.inputTokens, 4, "partial API usage is retained per call");
  assert.equal(partialUsage.callUsage[0].usage.outputTokens, null); assert.equal(partialUsage.usage?.totalTokens, null);
  assert.equal(partialUsage.usage?.unknownCalls, 2); assert.equal(partialUsage.callUsage[1].usage.inputTokens, null);
  view = await mutate(admin.id, { action: "release-generation", stateToken: partlyKnown.stateToken, sourceVersion: partlyKnown.source.sourceVersion, generationId: partlyKnown.generation!.id, unknownOutcomeAcknowledged: true });
  console.log("PASS CLI/API per-call numeric usage, unknown call counts and known usage retained after failure without reasoning/stdout exposure");

  if (process.argv[2] !== "late-revocation") {
    let authorizedCalls = 0;
    const beforeRevocation = await get();
    try {
      await assert.rejects(() => generate(beforeRevocation, async input => {
        authorizedCalls++;
        if (authorizedCalls === 1) await db.projectRole.deleteMany({ where: { projectId: project.id, userId: operator.id } });
        return { ...modelResult(input, spoofedBody), stderr: "[DeepSeek deepseek-v4-flash 9ms prompt=7 completion=3 total=10 finish=stop request=synthetic]" };
      }, operator.id), hasCode("DIRECTION_FORBIDDEN"));
      assert.equal(authorizedCalls, 1, "revocation must prevent the next chargeable call");
      const stopped = await get();
      assert.equal(stopped.draft!.hash, beforeRevocation.draft!.hash);
      assert.equal(numericSummary(stopped).callUsage.length, 1); assert.equal(numericSummary(stopped).usage?.totalTokens, 10);
      view = await mutate(admin.id, { action: "release-generation", stateToken: stopped.stateToken, sourceVersion: stopped.source.sourceVersion, generationId: stopped.generation!.id, unknownOutcomeAcknowledged: true });
    } finally { await db.projectRole.create({ data: { projectId: project.id, userId: operator.id, role: "OPERATOR" } }); }
    console.log("PASS per-call membership recheck stops paid suffix after revocation and preserves observed usage");
  }
  const beforeLateRevocation = await get();
  try {
    await assert.rejects(() => generate(beforeLateRevocation, async input => {
      if (JSON.parse(input.prompt.split("INPUT_JSON:\n")[1]).phase === "synthesis") await db.projectRole.deleteMany({ where: { projectId: project.id, userId: operator.id } });
      return modelResult(input, "{}");
    }, operator.id), hasCode("DIRECTION_FORBIDDEN"));
    const lateRevocation = await get();
    assert.equal(lateRevocation.draft!.hash, beforeLateRevocation.draft!.hash, "late output from a revoked actor must not become the current draft");
    assert.equal(lateRevocation.current!.hash, beforeLateRevocation.current!.hash);
    assert.equal(lateRevocation.generation!.outcome, "REVIEW_REQUIRED"); assert.equal(lateRevocation.generation!.pending, false);
    assert.equal(lateRevocation.history.length, beforeLateRevocation.history.length + 1, "paid late output remains immutable audit history");
    assert.equal(numericSummary(lateRevocation).callUsage.length, 2); assert.equal(numericSummary(lateRevocation).usage?.unknownCalls, 2);
  } finally { await db.projectRole.create({ data: { projectId: project.id, userId: operator.id, role: "OPERATOR" } }); }
  console.log("PASS revoked actor's late result is retained only as history, never applied to the current draft");
  assert.ok(existsSync(path.resolve("app/projects/[projectId]/series-direction/route.ts")), "方向命令必须从会话鉴权的JSON接口进入");
  const require = createRequire(import.meta.url);
  let sessionActor: string | null = operator.id;
  const authPath = require.resolve("../lib/auth");
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { getCurrentUser: async () => sessionActor ? { id: sessionActor } : null } } as NodeModule;
  const route = require("../app/projects/[projectId]/series-direction/route") as typeof import("../app/projects/[projectId]/series-direction/route");
  const context = { params: Promise.resolve({ projectId: project.id }) };
  const request = (body: unknown, origin = "http://localhost:3008") => new Request(`http://localhost:3008/projects/${project.id}/series-direction`, { method: "POST", headers: { origin, host: "localhost:3008", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await route.GET(new Request(`http://localhost:3008/projects/${project.id}/series-direction`), context)).status, 200);
  assert.equal((await route.POST(request({ action: "save" }, "https://untrusted.invalid"), context)).status, 403);
  assert.equal((await route.POST(request({ action: "confirm", stateToken: editable.stateToken, sourceVersion: editable.source.sourceVersion, draftHash: editable.draft!.hash, coverageAcknowledged: true, actorId: admin.id }), context)).status, 403, "request actorId never replaces logged-in OPERATOR");
  sessionActor = null;
  assert.equal((await route.GET(new Request(`http://localhost:3008/projects/${project.id}/series-direction`), context)).status, 401);
  console.log("PASS route session identity, cross-origin refusal and unauthorized read");
}
async function isolatedMain() {
  const directory = mkdtempSync(path.join(tmpdir(), "series-direction-service-"));
  const file = path.join(directory, "test.db"), url = `file:${file}`;
  const require = createRequire(import.meta.url), globals = globalThis as unknown as { prisma?: PrismaClient };
  const previousUrl = process.env.DATABASE_URL, previousPrisma = globals.prisma, previousFetch = globalThis.fetch;
  const modulePaths = ["../lib/prisma", "../lib/role-runner", "../lib/auth", "../lib/series-direction-service", "../app/projects/[projectId]/series-direction/route"].map(name => require.resolve(name));
  const previousModules = new Map(modulePaths.map(name => [name, require.cache[name]]));
  let hooks: ReturnType<typeof registerHooks> | undefined, client: PrismaClient | undefined;
  try {
    process.env.DATABASE_URL = url;
    globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN_IN_SYNTHETIC_DIRECTION_TEST"); };
    const sqlite = new DatabaseSync(file);
    try {
      for (const folder of readdirSync("prisma/migrations").sort()) {
        if (/^\d/.test(folder)) sqlite.exec(readFileSync(path.join("prisma/migrations", folder, "migration.sql"), "utf8"));
      }
    } finally { sqlite.close(); }
    let prismaEnvGuarded = false;
    hooks = registerHooks({
      resolve(specifier, context, next) { return next(specifier === "server-only" ? "next/dist/compiled/server-only/empty.js" : specifier, context); },
      load(url, context, next) {
        const loaded = next(url, context);
        if (url.startsWith("file:") && fileURLToPath(url) === path.resolve("node_modules/.prisma/client/index.js")) {
          prismaEnvGuarded = true;
          return { ...loaded, source: suppressGeneratedPrismaEnv(loaded.source ? Buffer.from(loaded.source as Uint8Array).toString("utf8") : readFileSync(fileURLToPath(url), "utf8")) };
        }
        return loaded;
      },
    });
    const { PrismaClient } = await import("@prisma/client");
    assert.ok(prismaEnvGuarded, "Prisma must not load the project .env in the synthetic test");
    db = client = new PrismaClient({ datasourceUrl: url });
    globals.prisma = db;
    const prismaModule = require("../lib/prisma") as typeof import("../lib/prisma");
    assert.equal(prismaModule.prisma, db, "all default imports must bind to the disposable DB");
    const prismaPath = modulePaths[0], runnerPath = modulePaths[1];
    require.cache[prismaPath] = { ...require.cache[prismaPath]!, exports: { ...prismaModule, prisma: db } };
    const runnerModule = require("../lib/role-runner") as typeof import("../lib/role-runner");
    const forbidProvider = async () => { throw new Error("REAL_PROVIDER_FORBIDDEN_IN_SYNTHETIC_DIRECTION_TEST"); };
    require.cache[runnerPath] = { ...require.cache[runnerPath]!, exports: { ...runnerModule, runRoleByProvider: forbidProvider } };
    assert.equal(require("../lib/role-runner").runRoleByProvider, forbidProvider);
    await main();
    console.log(`PASS ${process.argv.includes('--system-only') ? 'selected system-presentation' : 'all series-direction'} service checks; temporary SQLite, injected runner, no real provider`);
  } finally {
    try { await client?.$disconnect(); }
    finally {
      hooks?.deregister();
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
      if (previousPrisma === undefined) delete globals.prisma; else globals.prisma = previousPrisma;
      for (const [name, prior] of previousModules) { if (prior) require.cache[name] = prior; else delete require.cache[name]; }
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
isolatedMain().catch(error => { console.error(error); process.exitCode = 1; });
