/** Pure receiver/Q1 lifecycle regressions; no database, provider or saved source. */
import assert from 'node:assert/strict';
import { buildSourceIndex, requireF1Output } from '../lib/project-foundation-contracts';
import * as core from '../lib/foundation-production-contracts';

const index = buildSourceIndex([0, 1, 2, 3, 4].map(number => ({ number, title: null, content: `${number}-1\n甲与器物在屋内。` })));
const wire = (assets: unknown[], coverage = [1, 2]) => ({ format: 'ASSET_CATALOG_V2', coverage, assets });
const asset = (extra = {}) => ({ name: '器物', type: 'PROP', episodes: [1], preparation: { mode: 'REFERENCE' }, variants: [{ name: '残片', episodes: [1, 2], note: '保留此状态，不宣称新增出场。', preparation: { mode: 'INLINE' } }], ...extra });
const receive = (raw = wire([asset()]), prior: core.ProductionAsset[] = []) => core.requireProductionCatalogAuthor(raw, index, raw.coverage, prior);
const f1 = requireF1Output({ coverage: [1, 2, 3, 4], overview: '导航', episodes: [1, 2, 3, 4].map(number => ({ number, summary: '本集变化' })) }, index, [1, 2, 3, 4]);
const navigation = (coverage: number[]) => ({ ...f1, coverage, episodes: f1.episodes.filter(e => coverage.includes(e.number)) });
const edit = (changes: unknown, ids?: string[], coverage = [1, 2]) => core.requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage, changes, ...(ids ? { resolvedCatalogIssues: ids } : {}) }, index, coverage);
const apply = (catalog: core.ProductionCatalog, change: core.ProductionOptimization) => core.applyProductionOptimizations(navigation(catalog.coverage), catalog, [change], index).f2;
const repairs = (catalog: core.ProductionCatalog) => catalog.repairItems ?? [];
const failures: string[] = [];
function check(name: string, fn: () => void) { try { fn(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); } }
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.freeze(v); for (const item of Object.values(v)) freeze(item); } return v; }

check('V2 preserves parent/child declarations and supplies an explicitly unverified envelope', () => {
  const raw = freeze(wire([asset()])), before = JSON.stringify(raw), result = receive(raw), issue = repairs(result)[0];
  assert.deepEqual(result.assets[0].usageEpisodes, [1, 2]);
  assert.deepEqual(result.assets[0].variants[0].episodes, [1, 2]);
  assert.deepEqual(issue.assetEpisodes, [1]); assert.deepEqual(issue.variantEpisodes, [1, 2]); assert.deepEqual(issue.episodes, [2]);
  assert.equal(issue.assetKey, result.assets[0].key); assert.equal(issue.variantKey, result.assets[0].variants[0].key);
  assert.equal(issue.code, 'VARIANT_SCOPE'); assert.equal(issue.id, repairs(receive(raw))[0].id);
  assert.equal(JSON.stringify(raw), before);
  const issues = core.collectProductionRepairIssues(result);
  assert.equal(issues[0].owner, 'PROGRAM'); assert.equal(issues[0].severity, 'MAJOR');
  assert.match(issues[0].coordinate, /variants/); assert.match(issues[0].problem, /待核.*不等于.*新增出场/);
});
check('empty parent, zero and integer strings are accepted only within the true batch', () => {
  const result = receive(wire([asset({ episodes: [], variants: [{ name: '状态', episodes: ['0', '1'] }] })], [0, 1]));
  assert.deepEqual(result.assets[0].usageEpisodes, [0, 1]); assert.deepEqual(repairs(result)[0].assetEpisodes, []);
  for (const bad of [asset({ variants: [{ name: '状态', episodes: [3] }] }), asset({ key: 'foreign' }), asset({ type: 'BAD' })]) assert.throws(() => receive(wire([bad])));
  assert.throws(() => core.requireProductionCatalog({ ...wire([asset()]), format: 'ASSET_CATALOG_V1' }, index, [1, 2]));
});
check('author repair fields cannot forge clearance; trusted reads and projections retain evidence', () => {
  const raw = { ...wire([asset()]), repairItems: [] }, result = receive(raw), issue = repairs(result)[0];
  assert.equal(repairs(result).length, 1);
  assert.deepEqual(repairs(core.requireProductionCatalog(freeze(result), index, [1, 2])), [issue]);
  const projected = core.projectProductionCatalog(result, [2]);
  assert.deepEqual(projected.repairItems, [issue]); assert.deepEqual(projected.assets[0].variants[0].episodes, [2]);
  assert.deepEqual(repairs(core.requireProductionCatalog(projected, index, [2], result.assets)), [issue]);
  const split = [1, 2].map(number => core.requireProductionCatalog(core.projectProductionCatalog(result, [number]), index, [number], result.assets));
  assert.deepEqual(repairs(core.mergeProductionCatalogs(split, index, [1, 2])), [issue]);
  assert.throws(() => core.requireProductionCatalog({ ...result, repairItems: [{ ...issue, episodes: [3] }] }, index, [1, 2]));
  assert.equal(core.isProductionCatalog({ ...result, repairItems: [{ ...issue, episodes: [3] }] }), false, 'type guard must not bless corrupt saved repair evidence');
  const extra = receive(wire([], [3]));
  assert.deepEqual(repairs(core.mergeProductionCatalogs([result, extra], index, [1, 2, 3])), [issue]);
  assert.equal('repairItems' in receive(wire([asset({ episodes: [1, 2] })])), false, 'clean catalogs retain the old absent-field shape');
  const legacy = core.requireProductionCatalog({ ...wire([asset({ episodes: [1, 2] })]), format: 'ASSET_CATALOG_V1', repairItems: [issue] }, index, [1, 2]);
  assert.equal('repairItems' in legacy, false, 'V1 does not acquire receiver repairs from extra fields');
});
check('no-op, bare/unknown IDs, unrelated and partial changes retain the complete conflicted state', () => {
  const c = receive(), id = repairs(c)[0].id, a = c.assets[0];
  const variants = [{ name: '残片', episodes: [1], preparation: { mode: 'INLINE' } }];
  for (const e of [edit({}), edit({}, [id]), edit({}, ['invented']), edit({ assets: [asset({ key: a.key, name: '改名', episodes: [1], variants: undefined })] }),
    edit({ assets: [asset({ key: a.key, episodes: [1], variants })] }), edit({ assets: [asset({ key: a.key, episodes: [1, 2] })] }),
    edit({ assets: [asset({ key: a.key, episodes: [1, 2] })] }, ['invented']), edit({ assets: [{ name: '另一物', type: 'PROP', episodes: [1] }] }, [id]),
    edit({ assets: [asset({ key: a.key, episodes: [1], variants })] }, [id], [1]), edit({ removeAssetKeys: [a.key] }),
    edit({ assets: [asset({ key: a.key })] }, [id])]) {
    const result = apply(c, freeze(e));
    assert.equal(repairs(result).length, 1); assert.equal(repairs(result)[0].id, id);
    assert.deepEqual(result.assets.find(x => x.key === a.key)!.variants.find(v => v.key === a.variants[0].key)!.episodes, [1, 2]);
  }
});
check('only explicit marked parent or child corrections and covered removal close an issue', () => {
  const c = receive(), a = c.assets[0], id = repairs(c)[0].id;
  const parent = apply(c, edit({ assets: [asset({ key: a.key, episodes: [1, 2], variants: undefined })] }, [id]));
  assert.equal(repairs(parent).length, 0); assert.deepEqual(parent.assets[0].variants[0].episodes, [1, 2]);
  const child = apply(c, edit({ assets: [asset({ key: a.key, variants: [{ name: '残片', episodes: [1], preparation: { mode: 'INLINE' } }] })] }, [id]));
  assert.equal(repairs(child).length, 0); assert.deepEqual(child.assets[0].variants[0].episodes, [1]);
  const removed = apply(c, edit({ removeAssetKeys: [a.key] }, [id])); assert.equal(repairs(removed).length, 0); assert.equal(removed.assets.length, 0);
});
check('one unresolved issue cannot restore a scope whose sibling issue was prematurely cleared', () => {
  const first = receive(wire([asset()], [1, 2, 3])), a = first.assets[0], firstId = repairs(first)[0].id;
  const second = apply(first, edit({ assets: [asset({ key: a.key, episodes: [1, 2], variants: [{ name: '残片', episodes: [1, 2, 3], preparation: { mode: 'INLINE' } }] })] }, undefined, [1, 2, 3]));
  const ids = repairs(second).map(item => item.id).sort(); assert.equal(ids.length, 2);
  const change = { assets: [asset({ key: a.key, episodes: [1], variants: [{ name: '残片', episodes: [1], preparation: { mode: 'INLINE' } }] })] };
  const partial = apply(second, edit(change, [firstId], [1, 2, 3]));
  assert.deepEqual(repairs(partial).map(item => item.id).sort(), ids);
  assert.deepEqual(partial.assets[0].variants[0].episodes, [1, 2, 3]);
  const fixed = apply(second, edit(change, ids, [1, 2, 3]));
  assert.equal(repairs(fixed).length, 0); assert.deepEqual(fixed.assets[0].variants[0].episodes, [1]);
});
check('disjoint chunk repairs make independent progress instead of restoring each other forever', () => {
  const first = receive(), key = first.assets[0].key;
  const second = receive(wire([asset({ key, episodes: [3], variants: [{ name: '残片', episodes: [3, 4], preparation: { mode: 'INLINE' } }] })], [3, 4]), first.assets);
  const full = core.mergeProductionCatalogs([first, second], index, [1, 2, 3, 4]);
  const idA = repairs(full).find(item => item.episodes.includes(2))!.id, idB = repairs(full).find(item => item.episodes.includes(4))!.id;
  const afterA = apply(full, edit({ assets: [asset({ key, episodes: [1], variants: [{ name: '残片', episodes: [1], preparation: { mode: 'INLINE' } }] })] }, [idA], [1, 2]));
  assert.deepEqual(repairs(afterA).map(item => item.id), [idB]);
  assert.deepEqual(afterA.assets[0].variants[0].episodes, [1, 3, 4]);
  const afterB = apply(afterA, edit({ assets: [asset({ key, episodes: [3], variants: [{ name: '残片', episodes: [3], preparation: { mode: 'INLINE' } }] })] }, [idB], [3, 4]));
  assert.equal(repairs(afterB).length, 0); assert.deepEqual(afterB.assets[0].variants[0].episodes, [1, 3]);
});
check('global identity merge redirects coordinates without silently clearing the issue', () => {
  const c = receive(wire([asset(), { name: '同物候选', type: 'PROP', episodes: [1, 2], preparation: { mode: 'REFERENCE' } }]));
  const original = repairs(c)[0], keep = c.assets[1].key;
  const merged = apply(c, edit({ mergeAssets: [{ keepKey: keep, removeKeys: [c.assets[0].key] }] }, [original.id]));
  assert.equal(repairs(merged).length, 1); assert.equal(repairs(merged)[0].id, original.id); assert.equal(repairs(merged)[0].assetKey, keep);
  assert.equal(repairs(merged)[0].variantKey, merged.assets[0].variants[0].key);
  assert.deepEqual(repairs(core.requireProductionCatalog(merged, index, merged.coverage)), repairs(merged));
});
check('global merge also retargets the protected variant preparation before preserving it', () => {
  const c = freeze(receive(wire([asset({ variants: [{ name: '残片', episodes: [1, 2], preparation: { mode: 'DERIVE' } }] }),
    { name: '同物候选', type: 'PROP', episodes: [1, 2], preparation: { mode: 'REFERENCE' } }])));
  const keep = c.assets[1].key, merged = apply(c, edit({ mergeAssets: [{ keepKey: keep, removeKeys: [c.assets[0].key] }] }));
  assert.equal(repairs(merged).length, 1);
  assert.equal(merged.assets[0].variants[0].preparation?.mode, 'DERIVE');
  assert.equal(merged.assets[0].variants[0].preparation?.fromKey, keep);
});
check('exact registered base and variant self reuse inherits prior preparation without losing notes', () => {
  const prior = receive(wire([asset({ episodes: [1, 2], preparation: { mode: 'REFERENCE', note: '原来源' }, variants: [{ name: '残片', episodes: [1, 2], preparation: { mode: 'INLINE', note: '原状态' } }] })]));
  const a = prior.assets[0], v = a.variants[0];
  const reused = receive(wire([asset({ key: a.key, episodes: [1, 2], preparation: { mode: 'DERIVE', fromKey: a.key, note: '新提醒' }, variants: [{ name: v.name, episodes: [1, 2], preparation: { mode: 'DERIVE', fromKey: v.key, note: '状态提醒' } }] })]), prior.assets);
  assert.equal(reused.assets[0].preparation?.mode, 'REFERENCE'); assert.match(reused.assets[0].preparation?.note ?? '', /原来源.*\n.*新提醒/);
  assert.equal(reused.assets[0].variants[0].preparation?.mode, 'INLINE'); assert.match(reused.assets[0].variants[0].preparation?.note ?? '', /原状态.*\n.*状态提醒/);
  const pending = structuredClone(prior.assets); pending[0].preparation = { mode: 'UNRESOLVED', note: '原待定' };
  assert.equal(receive(wire([asset({ key: a.key, episodes: [1, 2], preparation: { mode: 'DERIVE', fromKey: a.key } })]), pending).assets[0].preparation?.mode, 'UNRESOLVED');
});
check('new self edges, child-to-base cycles and cross-object cycles remain protected', () => {
  const prior = receive(wire([asset({ episodes: [1, 2] }), { name: '另一物', type: 'PROP', episodes: [1, 2], preparation: { mode: 'REFERENCE' } }]));
  const [a, b] = prior.assets;
  const cycle = receive(wire([asset({ key: a.key, episodes: [1, 2], preparation: { mode: 'DERIVE', fromKey: b.key } }), { name: b.name, key: b.key, type: 'PROP', episodes: [1, 2], preparation: { mode: 'DERIVE', fromKey: a.key } }]), prior.assets);
  assert.equal(cycle.assets[0].preparation?.mode, 'UNRESOLVED'); assert.equal(cycle.assets[1].preparation?.mode, 'UNRESOLVED');
  const childCycle = receive(wire([asset({ key: a.key, episodes: [1, 2], preparation: { mode: 'DERIVE', fromKey: a.variants[0].key }, variants: [{ name: a.variants[0].name, episodes: [1, 2], preparation: { mode: 'DERIVE' } }] })]), prior.assets);
  assert.equal(childCycle.assets[0].preparation?.mode, 'UNRESOLVED');
  const acyclicChild = receive(wire([asset({ key: a.key, episodes: [1, 2], preparation: { mode: 'DERIVE', fromKey: a.variants[0].key }, variants: [{ name: a.variants[0].name, episodes: [1, 2], preparation: { mode: 'INLINE' } }] })]), prior.assets);
  assert.equal(acyclicChild.assets[0].preparation?.mode, 'DERIVE', 'a known acyclic child source is not itself an illegal cycle or self-reuse');
  assert.equal(acyclicChild.assets[0].preparation?.fromKey, a.variants[0].key);
  const fresh = asset({ name: '新候选', episodes: [1, 2], variants: [] });
  const predictedKey = receive(wire([fresh])).assets[0].key;
  const newSelf = receive(wire([{ ...fresh, preparation: { mode: 'DERIVE', fromKey: predictedKey } }]));
  assert.equal(newSelf.assets[0].preparation?.mode, 'UNRESOLVED', 'a guessed new key is not a registered reusable version');
});
assert.deepEqual(failures, [], 'catalog receiver/repair lifecycle regressions');
