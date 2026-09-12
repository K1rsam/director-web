import assert from 'node:assert/strict';
import { buildSourceIndex, type F1Output } from '../lib/project-foundation-contracts';
import { requireProductionCatalog as catalog, requireProductionCatalogAuthor as author, requireProductionOptimization as optimize, applyProductionOptimizations as apply, mergeProductionCatalogs as merge, projectProductionCatalog as project } from '../lib/foundation-production-contracts';

const index = buildSourceIndex([1, 2, 3].map(number => ({ number, title: null, content: `原文${number}` })));
const wire = (coverage: number[], assets: unknown[]) => ({ format: 'ASSET_CATALOG_V2', coverage, assets });
const asset = (name: string, episodes: number[], extra = {}) => ({ name, type: 'CH', episodes, ...extra });
const q = (changes: unknown, unresolved: unknown[] = [], coverage = [1]) => optimize({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage, changes, unresolved }, index, coverage);
const f1: F1Output = { coverage: [1, 2, 3], overview: '', episodes: [1, 2, 3].map(number => ({ number, summary: '', context: '', sourceSelections: [], f2Notes: '' })), issues: [] };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const failures: string[] = [];
const check = (name: string, test: () => void) => { try { test(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${String(error)}`); } };

check('preparation survives projection and missing is unresolved', () => {
  const c = catalog(wire([1], [asset('主角', [1], { preparation: { mode: 'REFERENCE' }, variants: [{ name: '婚服', episodes: [1], preparation: { mode: 'INLINE' } }] }), asset('旁白', [1])]), index, [1]);
  assert.equal(c.assets[0].preparation?.mode, 'REFERENCE');
  assert.equal(project(c, [1]).assets[0].variants?.[0].preparation?.mode, 'INLINE');
  assert.equal(c.assets[1].preparation?.mode, 'UNRESOLVED');
  assert.throws(() => catalog(wire([1], [asset('坏', [1], { preparation: 42 })]), index, [1]), /preparation/);
});
check('same names never imply identity; scope and entry keys are stable', () => {
  const a = catalog(wire([1], [asset('顾渊', [1]), asset('顾渊', [1])]), index, [1]);
  const b = catalog(wire([2, 3], [asset('顾渊', [2, 3])]), index, [2, 3], a.assets);
  assert.equal(new Set([...a.assets, ...b.assets].map(a => a.key)).size, 3);
  assert.deepEqual(catalog(wire([1], [asset('顾渊', [1]), asset('顾渊', [1])]), index, [1]), a);
});
check('unknown explicit update keys cannot become new assets', () => {
  assert.throws(() => catalog(wire([1], [asset('幽灵', [1], { key: 'unknown' })]), index, [1]), /key/);
  const c = catalog(wire([1, 2, 3], [asset('甲', [1, 2, 3])]), index, [1, 2, 3]);
  assert.throws(() => apply(f1, c, [q({ assets: [asset('幽灵', [1], { key: 'unknown' })] })], index), /key/);
});
check('explicit unresolved is not READY', () => {
  const result = q({}, [{ note: '来源未核实', episodes: [1] }]);
  assert.equal(result.verdict, 'REPAIR'); assert.equal(result.unresolved?.[0].note, '来源未核实');
});
check('global merge preserves all scopes, variants and retargets derivatives without mutating input', () => {
  const first = catalog(wire([1], [asset('编号144', [1], { preparation: { mode: 'REFERENCE' }, variants: [{ name: '未定位', episodes: [], preparation: { mode: 'INLINE' } }] })]), index, [1]);
  const second = catalog(wire([2, 3], [asset('费仲', [2, 3], { variants: [{ name: '伤态', episodes: [3] }] })]), index, [2, 3]);
  const [keepKey, removeKey] = [first.assets[0].key, second.assets[0].key];
  const derivative = catalog(wire([1, 2, 3], [asset('伪装者', [1], { preparation: { mode: 'DERIVE', fromKey: removeKey } })]), index, [1, 2, 3], second.assets);
  const base = catalog({ ...merge([first, second], index, [1, 2, 3]), assets: [...merge([first, second], index, [1, 2, 3]).assets, ...derivative.assets] }, index, [1, 2, 3]);
  const edit = q({ mergeAssets: [{ keepKey, removeKeys: [removeKey] }], assets: [asset('费仲', [1], { key: keepKey, type: 'BEAST' })] });
  const snapshot = JSON.stringify({ f1, base, edit }); freeze(f1); freeze(base); freeze(edit);
  const result = apply(f1, base, [edit], index).f2;
  assert.equal(JSON.stringify({ f1, base, edit }), snapshot);
  const kept = result.assets.find(a => a.key === keepKey)!;
  assert.deepEqual(kept.usageEpisodes, [1, 2, 3]); assert.equal(kept.name, '费仲'); assert.equal(kept.type, 'BEAST');
  assert.equal(kept.preparation?.mode, 'REFERENCE'); assert.equal(kept.variants.length, 2);
  assert.equal(result.assets.find(a => a.name === '伪装者')?.preparation?.fromKey, keepKey);
  assert.ok(!result.assets.some(a => a.key === removeKey));
  for (const operations of [[{ keepKey, removeKeys: [keepKey] }], [{ keepKey, removeKeys: ['unknown'] }], [{ keepKey, removeKeys: [removeKey] }, { keepKey: removeKey, removeKeys: [keepKey] }]]) assert.throws(() => apply(f1, base, [q({ mergeAssets: operations })], index));
  assert.throws(() => apply(f1, base, [q({ mergeAssets: [{ keepKey, removeKeys: [removeKey] }], removeAssetKeys: [keepKey] })], index));
  assert.throws(() => apply(f1, base, [q({ mergeAssets: [{ keepKey, removeKeys: [removeKey] }], assets: [asset('矛盾', [1], { key: removeKey })] })], index));
});
check('derive missing source is explicit pending, valid source is only association', () => {
  const c = catalog(wire([1], [asset('缺来源', [1], { preparation: { mode: 'DERIVE' } }), asset('未知来源', [1], { preparation: { mode: 'DERIVE', fromKey: 'no-image' } }), asset('已明确来源对象', [1], { preparation: { mode: 'REFERENCE' } })]), index, [1]);
  assert.ok(c.assets.slice(0, 2).every(a => a.preparation?.mode === 'UNRESOLVED' && a.preparation.note));
  assert.equal(c.assets[1].preparation?.fromKey, 'no-image');
  const known = catalog(wire([2, 3], [asset('服装派生', [2], { preparation: { mode: 'DERIVE', fromKey: c.assets[2].key } })]), index, [2, 3], c.assets);
  assert.equal(known.assets[0].preparation?.mode, 'DERIVE'); assert.deepEqual(known.assets[0].sourceRefs, []);
  assert.equal(merge([c, known], index, [1, 2, 3]).assets[3].preparation?.mode, 'DERIVE', 'canonical part re-read must retain a known cross-scope source');
});
check('existing omitted preparation and variants preserve, explicit empty variants clear only scope', () => {
  const c = catalog(wire([1, 2, 3], [asset('甲', [1, 2, 3], { preparation: { mode: 'AUDIO' }, variants: [{ name: '声音', episodes: [1, 3], preparation: { mode: 'AUDIO' } }, { name: '未定位', episodes: [], preparation: { mode: 'INLINE' } }] })]), index, [1, 2, 3]);
  const key = c.assets[0].key;
  const next = catalog(wire([1], [asset('甲的新名', [1], { key })]), index, [1], c.assets);
  assert.equal(next.assets[0].preparation?.mode, 'AUDIO');
  const unchanged = apply(f1, c, [q({ assets: [asset('甲的新名', [1], { key })] })], index).f2.assets[0];
  assert.equal(unchanged.preparation?.mode, 'AUDIO'); assert.equal(unchanged.variants.find(v => v.name === '声音')?.preparation?.mode, 'AUDIO');
  const cleared = apply(f1, c, [q({ assets: [asset('甲', [1], { key, variants: [] })] })], index).f2.assets[0];
  assert.deepEqual(cleared.variants.map(v => [v.name, v.episodes]), [['声音', [3]], ['未定位', []]]);
});
check('canonical malformed preparation errors identify preparation', () => {
  const c = catalog(wire([1], [asset('甲', [1])]), index, [1]);
  assert.throws(() => catalog({ ...c, assets: [{ ...c.assets[0], preparation: 42 }] }, index, [1]), /preparation/);
});
check('variant DERIVE binds its generated parent, registered variant sources remain valid', () => {
  const raw = freeze(wire([1], [asset('首批无key父对象', [1], { preparation: { mode: 'REFERENCE' }, variants: [{ name: '伤态', episodes: [1], preparation: { mode: 'DERIVE' } }] }), asset('无来源基础对象', [1], { preparation: { mode: 'DERIVE' } })]));
  const before = JSON.stringify(raw), first = catalog(raw, index, [1]);
  assert.equal(first.assets[0].variants[0].preparation?.mode, 'DERIVE');
  assert.equal(first.assets[0].variants[0].preparation?.fromKey, first.assets[0].key);
  assert.equal(first.assets[1].preparation?.mode, 'UNRESOLVED'); assert.equal(JSON.stringify(raw), before);
  const variantKey = first.assets[0].variants[0].key;
  const next = catalog(wire([2, 3], [asset('派生另一对象', [2], { preparation: { mode: 'DERIVE', fromKey: variantKey } })]), index, [2, 3], first.assets);
  assert.equal(next.assets[0].preparation?.mode, 'DERIVE');
  const full = merge([first, next], index, [1, 2, 3]);
  assert.equal(full.assets[2].preparation?.mode, 'DERIVE');
  const edited = apply(f1, full, [q({ assets: [asset('派生另一对象', [2], { key: next.assets[0].key, preparation: { mode: 'DERIVE', fromKey: variantKey }, variants: [{ name: '下一态', episodes: [2], preparation: { mode: 'DERIVE' } }] })] }, [], [2])], index).f2;
  assert.equal(edited.assets[2].preparation?.mode, 'DERIVE');
  assert.equal(edited.assets[2].variants[0].preparation?.fromKey, next.assets[0].key);
});
check('global merge retargets registered variant sources', () => {
  const c = author(wire([1, 2, 3], [asset('保留', [1], { preparation: { mode: 'REFERENCE' } }), asset('归并', [2], { preparation: { mode: 'REFERENCE' }, variants: [{ name: '伤态', episodes: [2], preparation: { mode: 'DERIVE' } }] })]), index, [1, 2, 3]);
  const [keep, removed] = c.assets;
  const variantKey = removed.variants[0].key;
  const extra = author(wire([1, 2, 3], [asset('引用变体', [3], { preparation: { mode: 'DERIVE', fromKey: variantKey } })]), index, [1, 2, 3], c.assets);
  const base = catalog({ ...c, assets: [...c.assets, ...extra.assets] }, index, [1, 2, 3]);
  const result = apply(f1, base, [q({ mergeAssets: [{ keepKey: keep.key, removeKeys: [removed.key] }] })], index).f2;
  const kept = result.assets.find(a => a.key === keep.key)!;
  const derived = result.assets.find(a => a.name === '引用变体')!;
  assert.equal(derived.preparation?.mode, 'DERIVE');
  assert.equal(derived.preparation?.fromKey, kept.variants[0].key);
  assert.equal(kept.variants[0].preparation?.fromKey, keep.key);
});
check('author never trusts canonical-shaped identity or source references', () => {
  const saved = catalog(wire([1], [asset('真实已登记', [1], { preparation: { mode: 'REFERENCE' } })]), index, [1]);
  const forged = freeze({ ...saved, assets: [{ ...saved.assets[0], key: 'invented', episodes: [1] }] });
  assert.throws(() => author(forged, index, [1]), /key/);
  const badSource = freeze({ ...saved, assets: [{ ...saved.assets[0], episodes: [1], preparation: { mode: 'DERIVE', fromKey: 'invented-source' } }] });
  const snapshot = JSON.stringify(badSource);
  assert.equal(author(badSource, index, [1], saved.assets).assets[0].preparation?.mode, 'UNRESOLVED');
  assert.equal(JSON.stringify(badSource), snapshot);
  assert.equal(catalog(saved, index, [1]).assets[0].key, saved.assets[0].key, 'saved canonical remains readable');
  assert.equal(author(wire([1], [asset('正常新候选', [1])]), index, [1]).assets.length, 1);
});
check('transitive base and variant cycles mark the cycle and its dependents unresolved', () => {
  const c = author(wire([1, 2, 3], [asset('A', [1], { variants: [{ name: 'A变体', episodes: [1] }] }), asset('B', [2]), asset('下游', [3]), asset('独立', [3], { preparation: { mode: 'REFERENCE' } })]), index, [1, 2, 3]);
  const [a, b, downstream] = c.assets;
  const edits = q({ assets: [asset('A', [1], { key: a.key, preparation: { mode: 'DERIVE', fromKey: b.key, note: 'A原说明' } }), asset('B', [2], { key: b.key, preparation: { mode: 'DERIVE', fromKey: a.variants[0].key } }), asset('下游', [3], { key: downstream.key, preparation: { mode: 'DERIVE', fromKey: b.key } })] }, [], [1, 2, 3]);
  // Variant's DERIVE edge to its parent closes A -> B -> A.variant -> A.
  edits.changes.assets![0].variants = [{ name: 'A变体', episodes: [1], preparation: { mode: 'DERIVE' } }];
  const before = JSON.stringify({ c, edits }); freeze(c); freeze(edits);
  const result = apply(f1, c, [edits], index).f2;
  assert.ok(result.assets.slice(0, 3).every(a => a.preparation?.mode === 'UNRESOLVED'));
  assert.equal(result.assets[0].variants[0].preparation?.mode, 'UNRESOLVED');
  assert.equal(result.assets[0].preparation?.fromKey, b.key); assert.match(result.assets[0].preparation?.note ?? '', /A原说明/);
  assert.equal(result.assets[3].preparation?.mode, 'REFERENCE'); assert.equal(JSON.stringify({ c, edits }), before);
});
check('identity merges preserve useful preparation and both notes; explicit conflicts remain pending until edited', () => {
  const variant = (mode: string, note: string) => [{ name: '共同变体', episodes: [1], note, preparation: { mode, note: `${note}制作` } }];
  const c = author(wire([1, 2, 3], [asset('保留', [1], { variants: variant('INLINE', '说明A') }), asset('归并', [1], { preparation: { mode: 'REFERENCE', note: '已有关联资料' }, variants: variant('UNRESOLVED', '说明B') })]), index, [1, 2, 3]);
  const [keep, removed] = c.assets, mergeAssets = [{ keepKey: keep.key, removeKeys: [removed.key] }];
  const result = apply(f1, freeze(c), [q({ mergeAssets })], index).f2.assets[0];
  assert.equal(result.preparation?.mode, 'REFERENCE'); assert.match(result.preparation?.note ?? '', /已有关联资料/);
  assert.equal(result.variants[0].preparation?.mode, 'INLINE'); assert.match(result.variants[0].note, /说明A/); assert.match(result.variants[0].note, /说明B/);
  const conflictBase = author(wire([1, 2, 3], [asset('甲', [1], { preparation: { mode: 'REFERENCE', note: '方案A' }, variants: variant('INLINE', '方案V1') }), asset('乙', [1], { preparation: { mode: 'INLINE', note: '方案B' }, variants: variant('REFERENCE', '方案V2') })]), index, [1, 2, 3]);
  const operation = [{ keepKey: conflictBase.assets[0].key, removeKeys: [conflictBase.assets[1].key] }];
  const conflict = apply(f1, conflictBase, [q({ mergeAssets: operation })], index).f2.assets[0];
  assert.equal(conflict.preparation?.mode, 'UNRESOLVED'); assert.match(conflict.preparation?.note ?? '', /方案A/); assert.match(conflict.preparation?.note ?? '', /方案B/);
  assert.equal(conflict.variants[0].preparation?.mode, 'UNRESOLVED');
  const fixed = apply(f1, conflictBase, [q({ mergeAssets: operation, assets: [asset('甲', [1], { key: operation[0].keepKey, preparation: { mode: 'AUDIO', note: '明确改用' }, variants: [{ name: '共同变体', episodes: [1], note: '明确说明', preparation: { mode: 'AUDIO' } }] })] })], index).f2.assets[0];
  assert.deepEqual(fixed.preparation, { mode: 'AUDIO', note: '明确改用' }); assert.equal(fixed.variants[0].note, '明确说明');
});
check('V2 reveals and Q1 renames preserve prior names and aliases without self alias', () => {
  const first = author(wire([1], [asset('编号144', [1], { aliases: ['鼠王'] })]), index, [1]);
  const key = first.assets[0].key;
  const second = author(wire([2, 3], [asset('费仲', [2, 3], { key, aliases: ['费仲', '老人'] })]), index, [2, 3], first.assets);
  const merged = merge([first, second], index, [1, 2, 3]);
  assert.equal(merged.assets[0].name, '费仲');
  assert.deepEqual(new Set(merged.assets[0].aliases), new Set(['编号144', '鼠王', '老人']));
  const updated = apply(f1, merged, [q({ assets: [asset('真名', [1], { key })] })], index).f2.assets[0];
  assert.equal(updated.name, '真名'); assert.ok(updated.aliases.includes('费仲') && updated.aliases.includes('编号144')); assert.ok(!updated.aliases.includes('真名'));
});
check('merge compares equivalent redirected parent sources before deciding a conflict', () => {
  const variants = [{ name: '同一伤态', episodes: [1], preparation: { mode: 'DERIVE' } }];
  const c = author(wire([1, 2, 3], [asset('甲', [1], { preparation: { mode: 'REFERENCE' }, variants }), asset('甲另一名', [1], { preparation: { mode: 'REFERENCE' }, variants })]), index, [1, 2, 3]);
  const result = apply(f1, c, [q({ mergeAssets: [{ keepKey: c.assets[0].key, removeKeys: [c.assets[1].key] }] })], index).f2.assets[0];
  assert.equal(result.variants[0].preparation?.mode, 'DERIVE'); assert.equal(result.variants[0].preparation?.fromKey, result.key);
});
check('every explicit source is validated, and source removal marks surviving references unresolved', () => {
  for (const mode of ['REFERENCE', 'INLINE', 'AUDIO']) {
    const bad = author(wire([1], [asset(mode, [1], { preparation: { mode, fromKey: 'unknown', note: '原来源说明' } })]), index, [1]).assets[0].preparation;
    assert.equal(bad?.mode, 'UNRESOLVED'); assert.equal(bad?.fromKey, 'unknown'); assert.match(bad?.note ?? '', /原来源说明/);
  }
  const source = author(wire([1, 2, 3], [asset('来源', [1])]), index, [1, 2, 3]);
  const ref = author(wire([1, 2, 3], [asset('引用者', [2], { preparation: { mode: 'REFERENCE', fromKey: source.assets[0].key } })]), index, [1, 2, 3], source.assets);
  const full = catalog({ ...source, assets: [...source.assets, ...ref.assets] }, index, [1, 2, 3]);
  const after = apply(f1, full, [q({ removeAssetKeys: [source.assets[0].key] })], index).f2;
  assert.equal(after.assets[0].preparation?.mode, 'UNRESOLVED'); assert.equal(after.assets[0].preparation?.fromKey, source.assets[0].key);
});
check('unresolved registered sources propagate to variants and later dependent batches', () => {
  const firstRaw = freeze(wire([1], [asset('原型A', [1], { preparation: { mode: 'UNRESOLVED', note: '原型待定' }, variants: [{ name: '衣态', episodes: [1], preparation: { mode: 'DERIVE', note: '衣态原说明' } }] }), asset('独立参考', [1], { preparation: { mode: 'REFERENCE' } })]));
  const first = author(firstRaw, index, [1]), a = first.assets[0];
  assert.equal(a.variants[0].preparation?.mode, 'UNRESOLVED'); assert.equal(a.variants[0].preparation?.fromKey, a.key);
  assert.match(a.variants[0].preparation?.note ?? '', /衣态原说明/); assert.match(a.variants[0].preparation?.note ?? '', /来源.*待定/);
  const secondRaw = freeze(wire([2], [asset('后批B', [2], { preparation: { mode: 'DERIVE', fromKey: a.key, note: '后批原说明' } })]));
  const second = author(secondRaw, index, [2], freeze(first.assets));
  assert.equal(second.assets[0].preparation?.mode, 'UNRESOLVED'); assert.equal(second.assets[0].preparation?.fromKey, a.key);
  const third = author(wire([3], [asset('再下游C', [3], { preparation: { mode: 'DERIVE', fromKey: second.assets[0].key } })]), index, [3], [...first.assets, ...second.assets]);
  assert.equal(third.assets[0].preparation?.mode, 'UNRESOLVED');
  const full = merge([first, second, third], index, [1, 2, 3]);
  assert.equal(full.assets[1].preparation?.mode, 'REFERENCE');
  assert.ok(full.assets.filter(a => a.name !== '独立参考').every(a => a.preparation?.mode === 'UNRESOLVED'));
});
check('V2 resolvedUnresolved IDs normalize without changing unresolved semantics', () => {
  const raw = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {}, unresolved: [{ note: '仍待定' }] };
  for (const resolvedUnresolved of [undefined, null, []]) assert.deepEqual(optimize({ ...raw, resolvedUnresolved }, index, [1]).resolvedUnresolved, []);
  const result = optimize(freeze({ ...raw, resolvedUnresolved: ['pending-1', 'pending-2'] }), index, [1]);
  assert.deepEqual(result.resolvedUnresolved, ['pending-1', 'pending-2']); assert.equal(result.verdict, 'REPAIR'); assert.equal(result.unresolved?.[0].note, '仍待定');
  assert.deepEqual(optimize({ ...raw, resolvedUnresolved: ['pending-1', 'pending-1'] }, index, [1]).resolvedUnresolved, ['pending-1']);
  for (const resolvedUnresolved of [42, {}, 'pending-1', [null], ['']]) assert.throws(() => optimize({ ...raw, resolvedUnresolved }, index, [1]), /resolvedUnresolved/);
});
assert.deepEqual(failures, [], 'V2 contract counterexamples');
