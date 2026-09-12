/** Coordinate-only source edits. Callers own the transaction and document/asset reference checks. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@prisma/client';
import { parseSceneBatch, type SceneSplitPlan } from './source-parser';
import type { ScriptSceneDraft } from './scene-structure';
import { readSceneParserVersions } from './scene-parser-version';

export type { SceneSplitPlan } from './source-parser';
export type SceneSplitPreview = ScriptSceneDraft & { episode: number; episodeId: string };
type ReadDb = Pick<Prisma.TransactionClient, 'episode' | 'scriptScene' | 'sceneSnapshot'>;
type SceneRow = Prisma.ScriptSceneGetPayload<{ include: { shots: { select: { id: true } }; units: { select: { id: true } } } }>;
const PLAN_KEY = 'SOURCE_SCENE_SPLIT_PLAN';
const SCHEMA = 'SOURCE_SCENE_SPLIT_PLAN_V1';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const key = (plan: Pick<SceneSplitPlan, 'episode' | 'sceneKey'>) => `${plan.episode}:${plan.sceneKey}`;
function object(value: unknown): Record<string, unknown> {
  try { const item = typeof value === 'string' ? JSON.parse(value) : value; return item && typeof item === 'object' && !Array.isArray(item) ? item : {}; } catch { return {}; }
}

export async function readSceneSplitPlans(projectId: string, db: Pick<Prisma.TransactionClient, 'sceneSnapshot'>): Promise<SceneSplitPlan[]> {
  const rows = await db.sceneSnapshot.findMany({ where: { projectId, sceneKey: PLAN_KEY }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const latest = new Map<string, SceneSplitPlan>();
  for (const row of rows) {
    const body = object(row.content), plan = object(body.plan);
    if (body.schema !== SCHEMA || !Number.isSafeInteger(plan.episode) || typeof plan.sceneKey !== 'string' || typeof plan.sourceHash !== 'string' || !Array.isArray(plan.cuts)) throw new Error('已保存的拆场计划格式无效，不能忽略后重建场次。');
    const value = plan as SceneSplitPlan;
    latest.set(key(value), value);
  }
  return [...latest.values()];
}

function assertOwned(row: SceneRow, original: ScriptSceneDraft | undefined) {
  const metadata = object(row.metadata);
  const refuse = () => { throw new Error(`场次${row.sceneKey}含人工标注、Q1 patch 或下游内容，受保护，拒绝自动拆场。`); };
  if (metadata.sourceHash !== hash(row.sourceText) || row.revision !== 'V1' || row.shots.length || row.units.length
    || Object.keys(metadata).some(name => !['characters', 'props', 'sourceHash', 'sourceSceneKey', 'sceneKeyAmbiguous', 'sourceSplit'].includes(name))) refuse();
  if (metadata.sourceSplit === undefined && !original) refuse();
  const parsed = metadata.sourceSplit === undefined ? original : null;
  const fields = parsed ? { ...parsed, ...parsed.metadata } : object(object(metadata.sourceSplit).fields);
  if ((['heading', 'location', 'interiorExterior', 'timeOfDay', 'weather', 'timeLayer'] as const).some(name => fields[name] !== row[name])
    || ['characters', 'props'].some(name => !isDeepStrictEqual(fields[name], metadata[name]))) refuse();
}

async function prepare(projectId: string, db: ReadDb, plans: SceneSplitPlan[]) {
  const [episodes, rows, saved] = await Promise.all([
    db.episode.findMany({ where: { projectId }, select: { id: true, number: true, title: true, content: true }, orderBy: { number: 'asc' } }),
    db.scriptScene.findMany({ where: { episode: { projectId } }, include: { shots: { select: { id: true } }, units: { select: { id: true } } } }),
    readSceneSplitPlans(projectId, db)
  ]);
  const versions = await readSceneParserVersions(projectId, db, episodes);
  // Validate the incoming list before merging, so duplicate targets cannot disappear in a Map.
  parseSceneBatch(episodes, plans, { versions });
  // Marker-only scene identities depend on their position in the whole episode.
  const originals = new Map(parseSceneBatch(episodes, [], { versions }).flatMap(entry => entry.scenes.map(scene => [key({ episode: entry.episodeNumber, sceneKey: scene.sceneKey }), scene] as const)));
  const combined = new Map(saved.map(plan => [key(plan), plan]));
  for (const plan of plans) combined.set(key(plan), plan);
  const parsed = parseSceneBatch(episodes, [...combined.values()], { versions });
  const episodeById = new Map(episodes.map(episode => [episode.id, episode]));
  const drafts = parsed.flatMap(entry => entry.scenes.map(scene => ({ ...scene, episode: entry.episodeNumber, episodeId: episodes.find(episode => episode.number === entry.episodeNumber)!.id })));
  const preview = new Map(rows.map(row => [key({ episode: episodeById.get(row.episodeId)!.number, sceneKey: row.sceneKey }), {
    episode: episodeById.get(row.episodeId)!.number, episodeId: row.episodeId, sceneKey: row.sceneKey, sortOrder: row.sortOrder,
    heading: row.heading ?? row.sceneKey, location: row.location, interiorExterior: row.interiorExterior, timeOfDay: row.timeOfDay,
    weather: row.weather, timeLayer: row.timeLayer, sourceText: row.sourceText, metadata: object(row.metadata)
  } satisfies SceneSplitPreview]));
  const changes: { plan: SceneSplitPlan; rows: SceneRow[]; drafts: SceneSplitPreview[] }[] = [];
  for (const plan of plans) {
    const episode = episodes.find(episode => episode.number === plan.episode)!;
    const expected = drafts.filter(scene => scene.episode === plan.episode && object(scene.metadata.sourceSplit).sceneKey === plan.sceneKey);
    const family = rows.filter(row => row.episodeId === episode.id && (row.sceneKey === plan.sceneKey || object(object(row.metadata).sourceSplit).sceneKey === plan.sceneKey));
    const identical = isDeepStrictEqual(saved.find(item => key(item) === key(plan)), plan);
    if (identical) {
      if (family.length !== expected.length || expected.some(scene => !family.some(row => row.sceneKey === scene.sceneKey && row.sourceText === scene.sourceText))) throw new Error(`已保存的拆场${plan.sceneKey}与实际场次不一致，须先核对被改动的场次。`);
      continue; // A later field patch is preserved when replaying this exact receipt.
    }
    for (const row of family) assertOwned(row, originals.get(key({ episode: plan.episode, sceneKey: row.sceneKey })));
    for (const scene of expected) {
      if (rows.some(row => row.episodeId === episode.id && row.sceneKey === scene.sceneKey && !family.some(item => item.id === row.id))) throw new Error(`新子场${scene.sceneKey}与受保护的现有场次冲突。`);
    }
    for (const row of family) preview.delete(key({ episode: plan.episode, sceneKey: row.sceneKey }));
    for (const scene of expected) preview.set(key(scene), scene);
    changes.push({ plan, rows: family, drafts: expected });
  }
  const touchedEpisodes = new Set(plans.map(plan => plan.episode));
  for (const scene of drafts) {
    const current = preview.get(key(scene));
    if (touchedEpisodes.has(scene.episode) && current?.sourceText === scene.sourceText) current.sortOrder = scene.sortOrder;
  }
  return { preview: [...preview.values()].sort((a, b) => a.episode - b.episode || a.sortOrder - b.sortOrder), changes, rows };
}

/** Unchanged scenes come from saved rows, never from a fresh parse that could erase Q1 fields. */
export async function previewSceneSplitPlans(projectId: string, db: ReadDb, plans: SceneSplitPlan[]): Promise<SceneSplitPreview[]> {
  return (await prepare(projectId, db, plans)).preview;
}

/** Must run inside the same caller-owned transaction that saves the corresponding document refs. */
export async function applySceneSplitPlans(projectId: string, tx: Prisma.TransactionClient, plans: SceneSplitPlan[]): Promise<void> {
  if (!plans.length) return;
  const prepared = await prepare(projectId, tx, plans);
  let last = await tx.sceneSnapshot.findFirst({ where: { projectId, sceneKey: PLAN_KEY }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  for (const change of prepared.changes) {
    last = await tx.sceneSnapshot.create({ data: { projectId, episodeId: change.drafts[0].episodeId, sceneKey: PLAN_KEY, title: `${change.plan.sceneKey} 原文坐标拆场计划`,
      content: JSON.stringify({ schema: SCHEMA, plan: change.plan, previousScenes: change.rows.map(({ shots: _shots, units: _units, ...row }) => row) }),
      metadata: JSON.stringify({ schema: SCHEMA, sourceHash: change.plan.sourceHash }), createdAt: new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1)) } });
    for (const row of change.rows) if (!change.drafts.some(scene => scene.sceneKey === row.sceneKey)) await tx.scriptScene.delete({ where: { id: row.id } });
    for (const { episode: _episode, ...scene } of change.drafts) {
      const data = { ...scene, metadata: JSON.stringify({ ...scene.metadata, sourceHash: hash(scene.sourceText) }) };
      await tx.scriptScene.upsert({ where: { episodeId_sceneKey: { episodeId: scene.episodeId, sceneKey: scene.sceneKey } }, create: data, update: data });
    }
  }
  const rewritten = new Set(prepared.changes.flatMap(change => change.rows.map(row => row.id)));
  for (const row of prepared.rows) {
    if (rewritten.has(row.id)) continue;
    const current = prepared.preview.find(scene => scene.episodeId === row.episodeId && scene.sceneKey === row.sceneKey);
    if (current && current.sourceText === row.sourceText && current.sortOrder !== row.sortOrder) await tx.scriptScene.update({ where: { id: row.id }, data: { sortOrder: current.sortOrder } });
  }
}
