/** Offline regression: irregular, real-world-like history must fit without deleting evidence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectFoundationModelInput } from '../lib/foundation-model-input';
import { buildLightFoundationPrompt } from '../lib/foundation-production-prompts';
import { costFingerprint } from '../lib/foundation-delivery';
import { assertFoundationRequestBudget } from '../lib/project-foundation';
import { runFoundationDeliveryCall, DeliveryCallError, type DeliveryAttempt } from '../lib/foundation-delivery-call';

// This decoder is independent of production projection, including the source ID recipe.
function expand(table: any): any[] {
  if (Array.isArray(table)) return table;
  if (table.format === 'HISTORICAL_EVIDENCE_TABLE_V3') {
    const at = table.columns.indexOf('evidence');
    const rows = table.rowBlocks.flatMap(([count, first, step]: any[]) => Array.from({ length: count }, (_, n) => {
      const row = structuredClone(first);
      if (count > 1) row[at] = [first[at][0], first[at][1] + n * step[0], first[at][2] + n * step[1]];
      return row;
    }));
    assert.equal(rows.length, table.rowCount);
    table = { ...table, rows };
  }
  const values = table.rows.map((row: any[]) => {
    const value: any = { ...table.shared, ...Object.fromEntries(table.columns.map((k: string, i: number) => [k, row[i]])) };
    if (table.format === 'HISTORICAL_EVIDENCE_TABLE_V4') {
      Object.assign(value, Object.fromEntries(table.profileColumns.map((k: string, i: number) => [k, table.profiles[value.profile][i]])));
      delete value.profile;
    }
    for (const [key, dictionary] of Object.entries(table.dictionaries ?? {})) value[key] = (dictionary as any[])[value[key]];
    value.evidence = { ...table.evidenceShared, ...Object.fromEntries(table.evidenceColumns.map((k: string, i: number) => [k, value.evidence[i]])) };
    if (table.evidenceEnd === 'START_PLUS_UTF16_STATEMENT_LENGTH') value.evidence.end = value.evidence.start + value.statement.length;
    if (table.idDerivation) value.id = createHash('sha256').update(JSON.stringify([
      table.idDerivation.sourceVersion, table.idDerivation.sourceContextVersion,
      { domain: value.evidence.domain, episode: value.evidence.episode, start: value.evidence.start, end: value.evidence.end }
    ])).digest('hex');
    return value;
  });
  return values.map((value: any, at: number) => ({ ...value, retrieval: value.retrieval === null
    ? { mode: 'SUBJECT_MENTION', anchorFactIds: [value.id] }
    : { mode: value.retrieval[0], anchorFactIds: value.retrieval[1].map((i: number) => values[i].id) } }));
}

const sourceVersion = 'synthetic-source', sourceContextVersion = 'synthetic-context';
const raw: any[] = [];
for (let episode = 1; episode <= 78; episode++) {
  let start = 0;
  for (let line = 0; line < 28; line++) {
    // Nonperiodic lengths, changing speakers, emoji UTF16, repeated claims and neighbouring evidence.
    const statement = `${line % 3 ? '柳凡：' : '△白青禾'}第${episode}次见面，${'再'.repeat((episode * 7 + line * 11) % 13)}别碰受伤的右手${line % 7 ? '。' : '🐢！'}\n`;
    const evidence = { domain: 'EPISODE', episode, start, end: start + statement.length };
    const id = createHash('sha256').update(JSON.stringify([sourceVersion, sourceContextVersion, evidence])).digest('hex');
    raw.push({ id, subjects: line % 3 ? ['柳凡'] : ['白青禾', '柳凡'], kind: line % 3 ? 'UTTERANCE' : 'STATE', statement, evidence,
      claim: line % 3 ? 'CHARACTER_CLAIM' : 'SOURCE', applicability: 'SUBJECT', validity: { status: 'UNKNOWN' },
      candidateUse: 'HISTORICAL_EVIDENCE_ONLY', currentApplicability: 'UNKNOWN',
      retrieval: line % 9 || !raw.length ? { mode: 'SUBJECT_MENTION', anchorFactIds: [id] }
        : { mode: 'SOURCE_NEIGHBOUR', anchorFactIds: [raw.at(-1).id, id] } });
    start = evidence.end + (line % 5); // Real headings/blank lines can leave gaps; don't infer adjacency.
  }
}
const facts = { schema: 'FOUNDATION_FACTS_V1', sourceVersion, sourceContextVersion, current: [], background: [],
  backgroundCandidates: [], historicalStates: [], historicalEvidenceCandidates: raw, rules: '候选不是已确认事实。' };
const input = { workflow: 'LIGHT_STAGE1_V1', scope: [79], source: { episodes: [{ number: 79, lines: [[1, '柳凡：右手好了。']], lineCount: 1 }] },
  facts, registry: [{ key: 'CH-001', name: '柳凡', aliases: [] }], delivery: { mode: 'EDIT' }, auxiliary: '已有必要素材。'.repeat(7000) };
const before = structuredClone(input);
assertFoundationRequestBudget('offline system', buildLightFoundationPrompt('Q1', input));
const wire: any = projectFoundationModelInput(input);
const table = wire.facts.historicalEvidenceCandidates;
assert.equal(table.format, 'HISTORICAL_EVIDENCE_TABLE_V4', 'Irregular history needs lossless profile/range factoring, not just repeated-sentence runs');
assert.deepEqual(expand(table), raw, 'Every claim, release, source position and neighbour edge must survive exactly');
assert.deepEqual(input, before);
assert.deepEqual(projectFoundationModelInput(wire), wire, 'Saved transport is idempotent');
assert.deepEqual(wire.source, input.source);
assert.equal(costFingerprint('Q1', input), costFingerprint('Q1', wire), 'Wire changes do not repurchase already-paid work');

// A mismatched source length cannot authorize deriving an end offset.
const mismatch = structuredClone(input);
mismatch.facts.historicalEvidenceCandidates[0].statement += '附加说明';
const mismatchTable: any = (projectFoundationModelInput(mismatch) as any).facts.historicalEvidenceCandidates;
assert.deepEqual(expand(mismatchTable), mismatch.facts.historicalEvidenceCandidates);
assert.notEqual(mismatchTable.evidenceEnd, 'START_PLUS_UTF16_STATEMENT_LENGTH');

// Unknown metadata and unresolved anchors must retain the complete old representation.
for (const change of [(f: any) => { f.futureField = { keep: '原样保留' }; }, (f: any) => { f.retrieval.anchorFactIds = ['missing']; }]) {
  const unknown = structuredClone(input); change(unknown.facts.historicalEvidenceCandidates[0]);
  assert.deepEqual((projectFoundationModelInput(unknown) as any).facts.historicalEvidenceCandidates, unknown.facts.historicalEvidenceCandidates);
}

async function run() {
  const context: any = { provider: 'CLI', role: { code: 'Q1', skill: '', model: 'gpt-6.1-sol', reasoningEffort: 'medium', systemPrompt: 'offline system' },
    sessionMode: 'ephemeral', runId: 'offline', batchToken: 'offline', sourceVersion, inputVersion: 'offline', chunkIndex: 1, scope: [79] };
  let calls = 0, guards = 0;
  const output = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [79], changes: {} };
  const runner = async () => { calls++; return { data: output, rawOutput: JSON.stringify(output), stdout: '', stderr: '', sessionId: null }; };
  const oversized = 'source-not-to-be-truncated'.repeat(10000);
  await assert.rejects(runFoundationDeliveryCall({ stage: 'Q1', prompt: oversized, context, validate: v => v, runner,
    beforeRequest: async () => { guards++; } }), (error: unknown) => {
    assert.ok(error instanceof DeliveryCallError);
    assert.equal(error.outcome, 'NOT_SENT');
    assert.equal(error.attempts[0].providerCallCount, 0);
    assert.equal(error.attempts[0].taskPrompt, oversized);
    return /请求预算/.test(error.message);
  });
  assert.equal(calls, 0, 'Even an injected/local executor cannot receive an oversized initial call');
  assert.equal(guards, 0, 'Preflight precedes dispatch-budget reservation');
  const saved: DeliveryAttempt = { sequence: 1, kind: 'INITIAL', scope: [79], systemPrompt: 'offline system', taskPrompt: oversized,
    provider: 'CLI', model: 'gpt-6.1-sol', reasoningEffort: 'medium', startedAt: new Date(0).toISOString(), status: 'SUCCEEDED',
    requestOutcome: 'RESPONDED', providerCallCount: 1, response: { data: output, rawOutput: JSON.stringify(output), stdout: '', stderr: '', sessionId: null } };
  const replay = await runFoundationDeliveryCall({ stage: 'Q1', prompt: oversized, context, validate: v => v, runner, resumeFrom: saved });
  assert.deepEqual(replay.output, output); assert.equal(calls, 0, 'Budget enforcement must not prevent zero-cost replay of a paid response');
  console.log(JSON.stringify({ status: 'PASS', historicalRows: raw.length, wireChars: JSON.stringify(table).length,
    promptChars: buildLightFoundationPrompt('Q1', input).length, exactRoundtrip: true, providerCalls: calls }));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
