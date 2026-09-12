import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the production closure with synthetic state, without importing the worker or database.
const source = readFileSync('lib/foundation-delivery.ts', 'utf8');
const ast = ts.createSourceFile('delivery.ts', source, ts.ScriptTarget.Latest, true);
let initializer: ts.Expression | undefined;
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'buildEditWork') initializer = node.initializer;
  ts.forEachChild(node, find);
}
find(ast); assert.ok(initializer, 'production shared planner exists');
const compiled = ts.transpileModule(`const buildEditWork = ${initializer.getText(ast)}; return buildEditWork;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const doc: any = { reviewedSuggestions: {}, appliedDecisions: {}, requiredDecisionIds: [], editorialCoverage: [1, 2], f2: { assets: [{ key: 'a', usageEpisodes: [1] }, { key: 'b', usageEpisodes: [2] }] } };
const loaded = { needsContextEdit: false };
const build = new Function('doc', 'loaded', 'all', 'remainingChoiceScope', 'union', compiled)(doc, loaded, [1, 2], (_doc: any, choice: any) => choice.episodes, (...sets: number[][]) => [...new Set(sets.flat())]);
const decision = { id: 'd1', revision: 'r1', episodes: [1] }, suggestion = { id: 's2', revision: 'r2', episodes: [2] };
const choices = { pending: [suggestion], confirmed: [decision], registry: [] };
const measured = build([1, 2], choices), execution = build([1, 2], choices);
assert.deepEqual(execution, measured, 'measurement and execution share phase/scope/targets');
assert.equal(execution.phase, 'EDIT'); assert.deepEqual(execution.scope, [1, 2]); assert.equal(execution.targets, undefined);
const calls: any[] = [];
const mock = (work: any) => { calls.push(work); return { coverage: work.scope, resolvedSuggestions: work.localSuggestions.map((s: any) => s.id), appliedDecisions: work.localDecisions.map((d: any) => d.id) }; };
const result = mock(execution);
assert.deepEqual(result.coverage, [1, 2]); assert.deepEqual(result.resolvedSuggestions, ['s2']); assert.deepEqual(result.appliedDecisions, ['d1']); assert.equal(calls.length, 1, 'mixed work is one initial EDIT, not an omitted suggestion requiring a repair');
const only = build([1], { ...choices, pending: [] });
assert.equal(only.phase, 'APPLY_DECISION'); assert.deepEqual(only.targets, { episodes: [1], keys: ['a'] });
assert.equal(build([1, 2], { ...choices, pending: [] }).phase, 'EDIT', 'decision coverage must cover every requested episode');
doc.editorialCoverage = [2]; assert.equal(build([1], { ...choices, pending: [] }).phase, 'EDIT', 'unreviewed episode needs EDIT');
doc.editorialCoverage = [1, 2]; loaded.needsContextEdit = true;
assert.equal(build([1], { ...choices, pending: [] }).phase, 'EDIT', 'context work needs EDIT');
loaded.needsContextEdit = false; doc.reviewedSuggestions.s2 = 'r2';
assert.equal(build([2], { ...choices, confirmed: [{ ...decision, episodes: [2] }] }).phase, 'APPLY_DECISION', 'already reviewed suggestion does not force EDIT');
doc.appliedDecisions.d1 = 'r1';
assert.equal(build([1], { ...choices, pending: [] }).phase, 'EDIT', 'stale already applied choice cannot produce APPLY_DECISION');
assert.equal((source.match(/buildEditWork\(scope, /g) ?? []).length, 2, 'both measuring and sending consume the same production helper');
console.log('PASS shared production edit-work helper: mixed suggestion/decision mock covers both episodes once, full decision scope, uncovered/context/stale choice guards, and exact measurement/execution work');
