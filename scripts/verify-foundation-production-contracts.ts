import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { buildSourceIndex, type F1Output } from '../lib/project-foundation-contracts';

async function main() {
  assert.ok(existsSync(new URL('../lib/foundation-production-contracts.ts', import.meta.url)), 'compact production contracts must exist');
  const { requireProductionCatalog: catalog, mergeProductionCatalogs: merge, projectProductionCatalog: project, isProductionCatalog, requireProductionOptimization: optimize, applyProductionOptimizations: apply } = await import('../lib/foundation-production-contracts');
  const index = buildSourceIndex([1, 2, 3].map(number => ({ number, title: null, content: `原文${number}` })));
  const wire = (coverage: number[], assets: unknown[]) => ({ format: 'ASSET_CATALOG_V1', coverage, assets });
  const hero = { key: 'hero', name: '主角', type: 'CH', episodes: [1], aliases: ['阿甲'], variants: [{ name: '婚服', episodes: [1] }, { name: '独臂', episodes: [1] }] };
  const first = catalog(wire([1], [hero]), index, [1]);
  assert.deepEqual(first.assets[0].usageEpisodes, [1]);
  assert.deepEqual(first.assets[0].appearances, []);
  assert.equal(first.assets[0].description, '');
  assert.ok(isProductionCatalog(first)); assert.ok(!isProductionCatalog(wire([1], [hero])));
  assert.ok(!isProductionCatalog({ ...first, assets: [{ ...first.assets[0], usageEpisodes: ['1'] }] }));
  const second = catalog(wire([2, 3], [{ name: '阿甲', type: 'CH', episodes: ['2', 3], variants: [{ name: '独臂', episodes: [2, 3] }] }]), index, [2, 3], first.assets);
  assert.equal(second.assets[0].key, 'hero'); assert.equal(second.assets[0].name, '主角');
  const full = merge([first, second], index, [1, 2, 3]);
  assert.equal(full.assets.length, 1); assert.deepEqual(full.assets[0].usageEpisodes, [1, 2, 3]);
  assert.deepEqual(full.assets[0].variants.map(v => v.episodes), [[1], [1, 2, 3]]);
  assert.deepEqual(project(full, [2]), wire([2], [{ key: 'hero', name: '主角', type: 'CH', aliases: ['阿甲'], episodes: [2], variants: [{ name: '独臂', episodes: [2], note: '' }] }]));
  assert.equal(catalog(wire([1], []), index, [1]).assets.length, 0);
  assert.equal(catalog(wire([1], [{ name: '钥匙', type: 'PROP', episodes: [1], aliases: [], variants: [] }]), index, [1]).assets[0].key, catalog(wire([1], [{ name: '钥匙', type: 'PROP', episodes: [1] }]), index, [1]).assets[0].key);
  for (const broken of [{ ...hero, episodes: [2] }, { ...hero, aliases: 42 }, { ...hero, variants: 'bad' }, { ...hero, variants: [{ name: '婚服', episodes: [2] }] }, { ...hero, type: 'BAD' }]) assert.throws(() => catalog(wire([1], [broken]), index, [1]));
  assert.deepEqual(catalog(wire([1, 1], []), index, [1]).coverage, [1]);
  assert.throws(() => merge([first, first], index, [1]), 'normalizing an author set cannot permit overlapping program chunks');
  assert.throws(() => catalog(wire([1], [hero, hero]), index, [1]));
  const numbered = catalog(wire([1], [{ key: 'beast-144', name: '编号144', type: 'BEAST', aliases: ['144'], episodes: [1] }]), index, [1]);
  for (const aliases of [['编号144', '144', '白金之王'], undefined]) {
    const raw = wire([2], [{ key: 'beast-144', name: '费仲', type: 'BEAST', aliases, episodes: [2], variants: [{ name: '鼠耳老人·心脉重伤', episodes: [2] }] }]);
    const before = JSON.stringify({ raw, numbered });
    const revealed = catalog(raw, index, [2], numbered.assets);
    assert.equal(revealed.assets[0].key, 'beast-144'); assert.equal(revealed.assets[0].name, '编号144');
    assert.ok(revealed.assets[0].aliases.includes('费仲') && revealed.assets[0].aliases.includes('144'));
    assert.equal(revealed.assets[0].variants[0].name, '鼠耳老人·心脉重伤');
    assert.deepEqual(merge([numbered, revealed], index, [1, 2]).assets[0].usageEpisodes, [1, 2]);
    assert.equal(JSON.stringify({ raw, numbered }), before, 'normalizing an evolving name cannot rewrite original responses');
  }
  assert.ok(catalog(wire([2], [{ ...hero, name: '改名', episodes: [2], variants: [] }]), index, [2], first.assets).assets[0].aliases.includes('改名'));
  const classified = catalog(wire([2], [{ key: 'hero', name: '主角真名', type: 'BEAST', episodes: [2] }]), index, [2], first.assets);
  assert.equal(classified.assets[0].type, 'BEAST');
  const combined = merge([first, classified], index, [1, 2]);
  assert.equal(combined.assets[0].type, 'BEAST'); assert.ok(combined.assets[0].aliases.includes('主角真名'));
  const independentlyParsed = catalog(wire([2], [{ key: 'beast-144', name: '费仲', type: 'CH', episodes: [2] }]), index, [2]);
  const mergedName = merge([numbered, independentlyParsed], index, [1, 2]).assets[0];
  assert.equal(mergedName.name, '编号144'); assert.ok(mergedName.aliases.includes('费仲')); assert.equal(mergedName.type, 'CH');
  const twins = catalog(wire([1], [{ ...hero, key: 'a' }, { ...hero, key: 'b' }]), index, [1]);
  assert.throws(() => catalog(wire([2], [{ name: '主角', type: 'CH', episodes: [2] }]), index, [2], twins.assets));
  const q = (coverage: number[], changes: unknown) => optimize({ format: 'FOUNDATION_OPTIMIZATION_V1', coverage, changes }, index, coverage);
  assert.equal(q([1], {}).verdict, 'READY');
  assert.throws(() => optimize({ coverage: [1], verdict: 'READY', summary: '通过', issues: [] }, index, [1]));
  for (const changes of [{ overview: 42 }, { random: [] }, { episodes: [{ number: 2, summary: '越界' }] }, { episodes: [{ number: 1, summary: 'a' }, { number: 1, summary: 'b' }] }, { assets: 'bad' }, { assets: [hero], removeAssetKeys: ['hero'] }]) assert.throws(() => q([1], changes));
  assert.deepEqual(q([1], { removeAssetKeys: ['hero', 'hero'] }).changes.removeAssetKeys, ['hero']);
  const f1: F1Output = { coverage: [1, 2, 3], overview: '总览', episodes: [1, 2, 3].map(number => ({ number, summary: '旧摘要', context: '保留上下文', sourceSelections: [], f2Notes: '保留线索' })), issues: [] };
  const duplicate = catalog(wire([1, 2, 3], [{ key: 'duplicate', name: '误拆', type: 'CH', episodes: [1, 3] }]), index, [1, 2, 3]);
  const base = catalog(wire([1, 2, 3], [...project(full, [1, 2, 3]).assets, ...project(duplicate, [1, 2, 3]).assets]), index, [1, 2, 3]);
  const edits = q([1], { episodes: [{ number: 1, summary: '修正男童导航' }], assets: [{ ...hero, name: '正确主角', type: 'GROUP' }, { name: '男童', type: 'CH', episodes: [1] }, { name: '钥匙', type: 'PROP', episodes: [1] }], removeAssetKeys: ['duplicate'] });
  const snapshot = JSON.stringify({ f1, base, edits, index });
  const result = apply(f1, base, [edits], index);
  assert.equal(JSON.stringify({ f1, base, edits, index }), snapshot);
  assert.equal(result.f1.episodes[0].summary, '修正男童导航'); assert.equal(result.f1.episodes[0].context, '保留上下文'); assert.deepEqual(result.f1.episodes[1], f1.episodes[1]);
  assert.deepEqual(result.f2.assets.find(a => a.key === 'hero')?.usageEpisodes, [1, 2, 3]);
  assert.equal(result.f2.assets.find(a => a.key === 'hero')?.type, 'GROUP');
  assert.deepEqual(result.f2.assets.find(a => a.key === 'duplicate')?.usageEpisodes, [3]);
  assert.equal(result.f2.assets.length, 4);
  assert.deepEqual(result.f2.episodes[0].assetKeys.length, 3);
  assert.throws(() => apply(f1, full, [q([1], { removeAssetKeys: ['missing'] })], index));
  assert.equal(apply(f1, full, [q([1], { episodes: [{ number: 1, summary: '清空', context: '' }] })], index).f1.episodes[0].context, '');
  assert.deepEqual(apply(f1, full, [q([1], { assets: [{ key: 'hero', name: '新名', type: 'CH', episodes: [1] }] })], index).f2.assets[0].aliases, ['阿甲']);
  assert.throws(() => apply(f1, full, [q([1], { overview: '本片新概述' })], index));
  assert.equal(apply(f1, full, [q([1], { overview: '本片新概述' })], index, [{ coverage: [1], overview: '旧概述' }, { coverage: [2, 3], overview: '其它片概述' }]).f1.overview, '本片新概述\n\n其它片概述');
  // Optional null means omitted; mandatory fields and malformed non-null members stay strict.
  const nullable = catalog(wire([1], [{ ...hero, aliases: null, variants: null }]), index, [1]);
  assert.deepEqual(nullable.assets[0].aliases, []); assert.deepEqual(nullable.assets[0].variants, []);
  assert.equal(catalog(wire([1], [{ ...hero, variants: [{ name: '婚服', episodes: [1], note: null }] }]), index, [1]).assets[0].variants[0].note, '');
  const nilEdit = optimize({ format: 'FOUNDATION_OPTIMIZATION_V1', coverage: [1], summary: null, notes: null, changes: { episodes: null, assets: null, removeAssetKeys: null, overview: null } }, index, [1]);
  assert.deepEqual(nilEdit.changes, {}); assert.equal(nilEdit.summary, ''); assert.deepEqual(nilEdit.notes, []);
  assert.deepEqual(apply(f1, full, [q([1], { assets: [{ key: 'hero', name: '主角', type: 'CH', episodes: [1], aliases: null, variants: null }] })], index).f2.assets[0].aliases, ['阿甲']);
  assert.deepEqual(apply(f1, full, [q([1], { assets: [{ key: 'hero', name: '主角', type: 'CH', episodes: [1], aliases: [] }] })], index).f2.assets[0].aliases, []);
  for (const key of ['format', 'coverage', 'assets']) assert.throws(() => catalog({ ...wire([1], [hero]), [key]: null }, index, [1]));
  for (const key of ['name', 'type', 'episodes']) assert.throws(() => catalog(wire([1], [{ ...hero, [key]: null }]), index, [1]));
  assert.throws(() => q([1], null));
  for (const bad of [{ ...hero, aliases: [null] }, { ...hero, variants: [null] }, { ...hero, variants: [{ name: '婚服', episodes: [1], note: 42 }] }]) assert.throws(() => catalog(wire([1], [bad]), index, [1]));
  for (const field of ['summary', 'notes']) assert.throws(() => optimize({ format: 'FOUNDATION_OPTIMIZATION_V1', coverage: [1], changes: {}, [field]: 42 }, index, [1]));
  for (const field of ['episodes', 'assets', 'removeAssetKeys', 'overview']) assert.throws(() => q([1], { [field]: 42 }));
  for (const field of ['episodes', 'assets', 'removeAssetKeys']) assert.throws(() => q([1], { [field]: [null] }));
  const correctionFailures: string[] = [];
  for (const [name, check] of Object.entries({
    'omitted variants preserve only retained usages': () => {
      for (const variants of [undefined, null]) {
        const updated = apply(f1, full, [q([1, 2], { assets: [{ key: 'hero', name: '改名', type: 'CH', episodes: [1], variants }] })], index).f2.assets[0];
        assert.deepEqual(updated.usageEpisodes, [1, 3]);
        assert.deepEqual(updated.variants.map(v => [v.name, v.episodes]), [['独臂', [1, 3]], ['婚服', [1]]]);
      }
      const cleared = apply(f1, full, [q([1, 2], { assets: [{ key: 'hero', name: '改名', type: 'CH', episodes: [1], variants: [] }] })], index).f2.assets[0];
      assert.deepEqual(cleared.variants.map(v => [v.name, v.episodes]), [['独臂', [3]]]);
      const replaced = apply(f1, full, [q([1, 2], { assets: [{ key: 'hero', name: '改名', type: 'CH', episodes: [1], variants: [{ name: '病服', episodes: [1] }] }] })], index).f2.assets[0];
      assert.deepEqual(replaced.variants.map(v => [v.name, v.episodes]), [['独臂', [3]], ['病服', [1]]]);
    },
    'automatic identities are type scoped': () => {
      const location = { name: '主角', type: 'LOC', episodes: [2] };
      assert.notEqual(catalog(wire([2], [location]), index, [2], first.assets).assets[0].key, 'hero');
      assert.equal(apply(f1, full, [q([2], { assets: [location] })], index).f2.assets.length, 2);
      assert.equal(catalog(wire([2], [{ ...location, key: 'hero' }]), index, [2], first.assets).assets[0].type, 'LOC', 'an explicitly retained identity may carry a new candidate classification for Q1');
    },
    'keyless alias clearing is explicit': () => {
      for (const aliases of [undefined, null, []]) {
        const updated = apply(f1, full, [q([1], { assets: [{ name: '主角', type: 'CH', episodes: [1], aliases }] })], index).f2.assets[0];
        assert.equal(updated.key, 'hero'); assert.deepEqual(updated.aliases, aliases ?? ['阿甲']);
      }
    },
    'nullable key and context are omitted not malformed': () => {
      assert.equal(catalog(wire([1], [{ ...hero, key: null }]), index, [1]).assets[0].key, catalog(wire([1], [{ ...hero, key: undefined }]), index, [1]).assets[0].key);
      assert.equal(apply(f1, full, [q([1], { episodes: [{ number: 1, summary: '更新', context: null }], assets: [{ name: '主角', type: 'CH', episodes: [1], key: null }] })], index).f1.episodes[0].context, '保留上下文');
      assert.throws(() => catalog(wire([1], [{ ...hero, key: 42 }]), index, [1]));
      assert.throws(() => q([1], { episodes: [{ number: 1, summary: '更新', context: 42 }] }));
    }
  })) { try { check(); } catch { correctionFailures.push(name); } }
  assert.deepEqual(correctionFailures, [], 'quality review counterexamples must pass');
  const unlocated = { key: 'shelter', name: '避难所', type: 'LOC', episodes: [], variants: [{ name: '破损', episodes: [] }] };
  const definitions = catalog(wire([1], [unlocated, { ...hero, variants: [{ name: '未定位婚服', episodes: [] }] }]), index, [1]);
  assert.deepEqual(definitions.assets[0].usageEpisodes, []); assert.deepEqual(definitions.assets[0].variants[0].episodes, []);
  assert.deepEqual(definitions.episodes[0].assetKeys, ['hero']);
  const mergedDefinitions = merge([definitions, catalog(wire([2, 3], []), index, [2, 3])], index, [1, 2, 3]);
  assert.equal(mergedDefinitions.assets.length, 2); assert.equal(mergedDefinitions.assets[0].variants[0].name, '破损');
  assert.deepEqual(project(mergedDefinitions, [1]).assets.map(a => a.key), ['hero']);
  assert.deepEqual(project(mergedDefinitions, [1]).assets[0].variants, []);
  assert.deepEqual(apply(f1, full, [q([1], { assets: [unlocated] })], index).f2.assets.find(a => a.key === 'shelter')?.usageEpisodes, []);
  for (const broken of [{ ...unlocated, episodes: undefined }, { ...unlocated, episodes: null }, { ...unlocated, episodes: [2] }, { ...unlocated, variants: [{ name: '破损', episodes: [1] }] }]) assert.throws(() => catalog(wire([1], [broken]), index, [1]));
  assert.throws(() => catalog(wire([], [unlocated]), index, []));
  for (const variants of [undefined, []]) {
    const afterRename = apply(f1, mergedDefinitions, [q([1], { assets: [{ key: 'hero', name: '修正名', type: 'CH', episodes: [1], variants }] })], index).f2;
    assert.deepEqual(afterRename.assets.find(a => a.key === 'hero')?.variants.map(v => [v.name, v.episodes]), [['未定位婚服', []]]);
  }
  assert.ok(!apply(f1, mergedDefinitions, [q([1], { removeAssetKeys: ['hero'] })], index).f2.assets.some(a => a.key === 'hero'));
  console.log('PASS production contracts: baseline plus real-shaped name/classification evolution regressions');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
