/** Offline wire round trips; no user database, model or network calls. */
import assert from 'node:assert/strict';
import { buildSourceIndex } from '../lib/project-foundation-contracts';
import { buildLightBoundaryContext } from '../lib/light-foundation-supply';
import { costFingerprint } from '../lib/foundation-delivery';
import * as projection from '../lib/foundation-model-input';

const index = buildSourceIndex([1, 2].map(number => ({ number, title: null,
  content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n${'甲：沉默。\n'.repeat(3100)}` })));
const boundary = buildLightBoundaryContext(index, null, [], [2])!;
const input = { scope: [2], source: { episodes: [] }, boundaryContext: boundary };
const before = structuredClone(input);
const wire = projection.projectFoundationModelInput(input) as typeof input;
assert.equal((wire.boundaryContext.previousSource.nodes as unknown as { format: string }).format, 'SOURCE_NODE_TABLE_V1',
  'Complete tail evidence must not exceed the request through hundreds of repeated node-object keys.');
assert.equal(wire.boundaryContext.previousSource.text, boundary.previousSource.text);
assert.deepEqual(input, before, 'Canonical evidence and saved source remain unchanged.');
const restored = projection.expandFoundationBoundaryContext(wire.boundaryContext);
assert.deepEqual(restored, boundary, 'Every node ID, source member, coordinate, kind and boundary warning round trips.');
assert.deepEqual(projection.projectFoundationModelInput(wire), wire, 'Projection is idempotent on saved wire inputs.');
assert.equal(costFingerprint('F2', input), costFingerprint('F2', wire), 'Wire changes cannot create a fresh paid-work identity.');
assert.ok(JSON.stringify(wire).length < JSON.stringify(input).length * .55, 'Save repeated keys, not source text or evidence nodes.');

for (const nodes of [
  boundary.previousSource.nodes.map((node, i) => i === 0 ? { ...node, unknownMeaning: 'keep' } : node),
  boundary.previousSource.nodes.map((node, i) => i === 0 ? { ...node, sourceUnitIds: undefined } : node),
  boundary.previousSource.nodes.map((node, i) => i === 0 ? { ...node, sourceRange: { ...node.sourceRange, extra: 'keep' } } : node),
]) {
  const unknown = { boundaryContext: { ...boundary, previousSource: { ...boundary.previousSource, nodes } } };
  assert.deepEqual(projection.projectFoundationModelInput(unknown), unknown, 'Unknown or incomplete node shapes fall back without omission.');
}
const table = wire.boundaryContext.previousSource.nodes as unknown as Record<string, unknown>;
assert.throws(() => projection.expandFoundationBoundaryContext({ ...wire.boundaryContext, previousSource: {
  ...wire.boundaryContext.previousSource, nodes: { ...table, interpretation: 'changed meaning' }
} }), /传输|节点|结构/);
const empty = { boundaryContext: { previousSource: { nodes: [], text: '原文不能消失' }, custom: 'keep' } };
assert.deepEqual(projection.projectFoundationModelInput(empty), empty);
console.log(`PASS boundary wire: all source/nodes restored, paid identity stable, unknown shapes retained; ${JSON.stringify(input).length} → ${JSON.stringify(wire).length} UTF-16 chars, not measured Tokens`);
