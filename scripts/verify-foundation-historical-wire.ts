import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { projectFoundationModelInput } from '../lib/foundation-model-input';
import { buildLightFoundationPrompt } from '../lib/foundation-production-prompts';
import { costFingerprint } from '../lib/foundation-delivery';

type Row = Record<string, any>;
const id = (n: number) => createHash('sha256').update(`historical-fixture-${n}`).digest('hex');
const history = Array.from({ length: 722 }, (_, n) => ({
  id: id(n), subjects: n % 3 ? ['甲'] : [], kind: n % 3 ? 'UTTERANCE' : 'STATE',
  statement: `  ${n % 3 ? '甲：我并不知道他的身份。' : '他拆下绷带，把信归还。'}第${n}处😀\r\n`,
  evidence: { domain: 'EPISODE', episode: Math.floor(n / 30), start: n * 100, end: n * 100 + 30 },
  claim: n % 3 ? 'CHARACTER_CLAIM' : 'SOURCE', applicability: n % 3 ? 'SUBJECT' : 'UNRESOLVED',
  validity: { status: 'UNKNOWN' }, candidateUse: 'HISTORICAL_EVIDENCE_ONLY', currentApplicability: 'UNKNOWN',
  retrieval: { mode: n % 3 || n === 0 ? 'SUBJECT_MENTION' : 'SOURCE_NEIGHBOUR', anchorFactIds: n % 3 || n === 0 ? [id(n)] : [id(n - 1), id(n + 1 < 722 ? n + 1 : n)] },
}));
const input = {
  scope: [29], source: { episodes: [{ number: 29, lineCount: 1, lines: [[1, '  甲：我回来了。😀\r\n']] }] },
  scenes: [{ episode: 29, sceneKey: '29-1', characters: ['甲'] }],
  boundaryContext: { previousSource: { episode: 28, text: '  他已拆下绷带。\r\n' }, priorStates: [], gaps: [] },
  registry: [{ key: 'CH_A', name: '甲', aliases: ['旧名'], variants: [{ key: 'CH_A_V1', name: '受伤' }] }],
  facts: { format: 'FACT_TABLE_V1', rows: [], groups: {}, historicalEvidenceCandidates: history, rules: '历史候选不是当前事实，角色主张不等于事实。' },
};

/** This follows the model-visible column dictionary, not a private production decoder. */
function expand(value: any): unknown {
  if (Array.isArray(value)) return value;
  assert.equal(value.format, 'HISTORICAL_EVIDENCE_TABLE_V1');
  assert.deepEqual(value.evidenceColumns, ['domain', 'episode', 'start', 'end']);
  assert.deepEqual(value.retrievalColumns, ['mode', 'anchorRows']);
  const rows: Row[] = value.rows.map((row: any[]) => ({ ...value.shared, ...Object.fromEntries(value.columns.map((key: string, position: number) => [key, row[position]])) }));
  const ids = rows.map(row => row.id);
  return rows.map(row => ({ ...row,
    evidence: Object.fromEntries(value.evidenceColumns.map((key: string, position: number) => [key, row.evidence[position]])),
    retrieval: { mode: row.retrieval[0], anchorFactIds: row.retrieval[1].map((position: number) => ids[position]) },
  }));
}

assert.equal(costFingerprint('F2', input), '88cb3948099ef453be85bbb177dcbff7685c604f6dc55bc7beb85ae059289338', 'Exact paid hash recorded before the transport change stays unchanged');
const original = structuredClone(input), projected: any = projectFoundationModelInput(input);
assert.equal(projected.facts.historicalEvidenceCandidates.format, 'HISTORICAL_EVIDENCE_TABLE_V1', 'Historical candidates must not bypass lossless wire projection');
assert.deepEqual(expand(projected.facts.historicalEvidenceCandidates), history, 'Every source sentence, claim, validity and retrieval edge survives exactly');
assert.deepEqual(input, original, 'No canonical input mutation');
assert.deepEqual(projected.source, input.source);
assert.deepEqual(projected.registry, input.registry, 'Keep the complete identity lookup');
assert.deepEqual(projected.boundaryContext, input.boundaryContext, 'Keep actual previous-episode continuity');
assert.deepEqual(projectFoundationModelInput(projected), projected, 'Saved wire inputs remain idempotent');
assert.equal(costFingerprint('F2', input), costFingerprint('F2', projected), 'Transport does not create new paid work');
assert.ok(JSON.stringify(projected).length + 24_000 < 200_000, 'Repeated metadata must not strand even a single short episode');
const prompt = buildLightFoundationPrompt('F2', input), fromPrompt = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
assert.deepEqual(expand(fromPrompt.facts.historicalEvidenceCandidates), history, 'Actual model prompt includes a complete self-contained table');
assert.match(fromPrompt.facts.historicalEvidenceCandidates.interpretation, /零起始/);
assert.match(fromPrompt.facts.historicalEvidenceCandidates.interpretation, /候选/);

const mixedValidity = structuredClone(history);
mixedValidity[3].validity = { status: 'EXPLICIT', start: 3, end: 8 } as any;
const mixed: any = projectFoundationModelInput({ ...input, facts: { ...input.facts, historicalEvidenceCandidates: mixedValidity } });
assert.deepEqual(expand(mixed.facts.historicalEvidenceCandidates), mixedValidity, 'Non-default validity must never be flattened');
const raw: any = projectFoundationModelInput({ ...input, facts: { historicalEvidenceCandidates: history, current: [] } });
assert.deepEqual(expand(raw.facts.historicalEvidenceCandidates), history, 'Raw and already-packed fact roots both receive historical projection');
for (const mutate of [
  (rows: Row[]) => { rows[1].futureField = { text: '未知证据原样保留' }; },
  (rows: Row[]) => { rows[1].evidence.sourceVersion = 'unknown-extra'; },
  (rows: Row[]) => { rows[1].retrieval.extra = 'unknown-extra'; },
  (rows: Row[]) => { rows[1].validity.until = 'unknown-shape'; },
  (rows: Row[]) => { rows[1].retrieval.anchorFactIds = ['not-in-this-table']; },
  (rows: Row[]) => { rows[1].id = rows[0].id; },
  (rows: Row[]) => { delete rows[1].claim; },
  (rows: Row[]) => { rows[1].kind = { toString: 'unknown-json-shape' }; },
  (rows: Row[]) => { rows[1].validity.status = { toString: 'unknown-json-shape' }; },
  (rows: Row[]) => { rows[1].retrieval.mode = { toString: 'unknown-json-shape' }; },
]) {
  const candidates: Row[] = structuredClone(history); mutate(candidates);
  const fallback: any = projectFoundationModelInput({ ...input, facts: { ...input.facts, historicalEvidenceCandidates: candidates } });
  assert.deepEqual(fallback.facts.historicalEvidenceCandidates, candidates, 'Unknown shapes and unresolved references fall back without dropping data');
}

const savedDbArg = process.argv.indexOf('--saved-db');
if (savedDbArg >= 0) {
  const file = process.argv[savedDbArg + 1]; assert(file, '--saved-db requires an explicit database path');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const runs = db.prepare("SELECT id,stageCode,inputSummary,log FROM PipelineRun WHERE stageCode IN ('F2','Q1') ORDER BY createdAt").all() as Row[];
    for (const run of runs) {
      let log: Row; try { log = JSON.parse(run.log ?? '{}'); } catch { continue; }
      for (const call of log.calls ?? []) {
        const oldPrompt = call.taskPrompt; if (typeof oldPrompt !== 'string') continue;
        let saved: Row; try { saved = JSON.parse(oldPrompt.split('INPUT_JSON:\n').at(-1)!); } catch { continue; }
        if (!Array.isArray(saved.facts?.historicalEvidenceCandidates)) continue;
        const next: any = projectFoundationModelInput(saved), table = next.facts.historicalEvidenceCandidates;
        assert.deepEqual(expand(table), saved.facts.historicalEvidenceCandidates);
        const { facts: _before, ...beforeRest } = saved, { facts: _after, ...afterRest } = next;
        assert.deepEqual(afterRest, beforeRest, 'Saved source, previous episode and registry are untouched');
        assert.equal(costFingerprint(run.stageCode, saved), costFingerprint(run.stageCode, next));
        const savedWork = JSON.parse(run.inputSummary ?? '{}').workFingerprint;
        if (typeof savedWork === 'string') assert.equal(costFingerprint(run.stageCode, next), savedWork, 'Previously recorded paid-work identity must still match');
        const freshPrompt = buildLightFoundationPrompt(run.stageCode, saved), before = oldPrompt.length + (call.systemPrompt?.length ?? 0), after = freshPrompt.length + (call.systemPrompt?.length ?? 0);
        console.log(JSON.stringify({ runId: run.id, scope: saved.scope, outcome: call.requestOutcome, unit: 'UTF16_CHARS_NOT_TOKENS', historicalRows: saved.facts.historicalEvidenceCandidates.length,
          historicalBefore: JSON.stringify(saved.facts.historicalEvidenceCandidates).length, historicalAfter: JSON.stringify(table).length, requestBefore: before, requestAfter: after,
          withOutputReserve: after + 24_000, fitsBudget: after + 24_000 <= 200_000, sourceRegistryBoundaryUnchanged: true, roundtripExact: true, paidHashUnchanged: true }));
      }
    }
  } finally { db.close(); }
}
console.log('PASS historical evidence wire: exact roundtrip, source/registry/boundary preservation, safe fallback, readable dictionary, idempotence and paid reuse');
