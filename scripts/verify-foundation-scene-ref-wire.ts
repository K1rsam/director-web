import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import { normalizeFoundationSceneRefWire as normalize } from '../lib/foundation-scene-ref-wire';

const canonical = { assets: [{ sceneRefs: [{ episode: 0, sceneKey: '0-1' }, { episode: 7, sceneKey: '7-2' }],
  variants: [{ sceneRefs: [{ episode: 7, sceneKey: '7-2' }] }], episodes: [0, 7] }], unrelated: [[1, 'untouched']] };
function compact(node: any): any {
  if (Array.isArray(node)) return node.map(compact);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, key === 'sceneRefs' && Array.isArray(item)
    ? item.map(ref => ref && !Array.isArray(ref) && Object.keys(ref).length === 2 && 'episode' in ref && 'sceneKey' in ref ? [ref.episode, ref.sceneKey] : ref)
    : compact(item)]));
}
assert.deepEqual(normalize(compact(canonical)), canonical);
assert.deepEqual(normalize(canonical), canonical);
const mixed = { changes: { assets: [{ key: 'a', sceneRefs: [[1, 'exact key '], { episode: 2, sceneKey: '2-1', extra: true }], note: 'unchanged' }] } };
const before = structuredClone(mixed);
assert.deepEqual((normalize(mixed) as any).changes.assets[0].sceneRefs, [{ episode: 1, sceneKey: 'exact key ' }, { episode: 2, sceneKey: '2-1', extra: true }]);
assert.deepEqual(mixed, before, 'provider evidence must not be mutated');
for (const ref of [[], [1], [1, 'x', 'extra'], ['1', 'x'], [1.5, 'x'], [Infinity, 'x'], [1, null]]) {
  assert.throws(() => normalize({ assets: [{ sceneRefs: [ref] }] }), /sceneRefs tuple/);
}
assert.deepEqual(normalize({ sceneRefs: [null, 3, { wrong: true }], other: [[1, 'x']] }), { sceneRefs: [null, 3, { wrong: true }], other: [[1, 'x']] }, 'non-tuple invalid values remain for canonical rejection');
assert.deepEqual(normalize({ sceneRefs: [[999, 'not-a-known-scene']] }), { sceneRefs: [{ episode: 999, sceneKey: 'not-a-known-scene' }] }, 'never infer or replace identity');
console.log('PASS sceneRefs pure tuple normalization, mixed legacy objects, malformed tuples, exact identities and unchanged provider evidence');

async function replay() {
  const db = new PrismaClient();
  try {
    await db.$executeRawUnsafe('PRAGMA query_only = ON');
    const runs = await db.pipelineRun.findMany({ where: { projectId: (process.env.QA_PROJECT_ID || 'missing-test-project'), stageCode: 'F2', status: 'SUCCEEDED' }, orderBy: { createdAt: 'asc' } });
    assert.equal(runs.length, 3);
    const results = runs.flatMap(run => JSON.parse(run.log!).calls.map((call: any) => {
      const original = call.response.data, frozen = JSON.stringify(original), wire = compact(original);
      assert.deepEqual(normalize(wire), original, 'real F2 canonical roundtrip is lossless');
      assert.equal(JSON.stringify(original), frozen);
      return { runId: run.id, originalChars: frozen.length, compactChars: JSON.stringify(wire).length,
        savedChars: frozen.length - JSON.stringify(wire).length };
    }));
    await writeFile('runtime-3008/scene-ref-wire-audit.json', JSON.stringify({ results, lossless: true, modelCalls: 0 }, null, 2));
    console.log(JSON.stringify(results));
  } finally { await db.$disconnect(); }
}
if (process.argv.includes('--saved-replay')) replay().catch(e => { console.error(e); process.exitCode = 1; });
