import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import { projectFoundationModelInput } from '../lib/foundation-model-input';
import { buildLightFoundationPrompt } from '../lib/foundation-production-prompts';

function restoreSceneRefs(value: any): any {
  if (Array.isArray(value)) return value.map(restoreSceneRefs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'sceneRefs' && Array.isArray(child)
    ? child.map(ref => Array.isArray(ref) ? { episode: ref[0], sceneKey: ref[1] } : ref) : restoreSceneRefs(child)]));
}

const source = { episodes: [{ number: 0, lineCount: 2, lines: [[1, '  人物：原文\r\n'], [2, '\r\n']] }] };
const fact = { id: 'a'.repeat(64), subjects: ['人物'], kind: 'UTTERANCE', claim: 'CHARACTER_CLAIM', applicability: 'SUBJECT', evidence: { domain: 'EPISODE', episode: 0, start: 0, end: 10 }, validity: { status: 'UNKNOWN' } };
const background = { ...fact, statement: '背景必须原样保留\r\n', evidence: { domain: 'CONTEXT', sectionKey: '背景-0', start: 0, end: 12 }, validity: { status: 'EXPLICIT', start: 0, end: 3 } };
const { statement: _backgroundStatement, ...unlinked } = background;
const input = { scope: [0], source, scenes: [{ sceneKey: 'S0' }], candidates: { f2: { assets: [{ key: 'CH_exact', sceneRefs: [{ episode: 0, sceneKey: 'S0' }], variants: [{ key: 'V_exact', sceneRefs: [{ episode: 0, sceneKey: 'S0' }] }] }] } }, confirmedDecisions: [{ id: 'choice-exact', revision: 'keep' }], facts: { sourceVersion: 'hash', current: [fact], background: [background], backgroundCandidates: [background], unlinkedBackground: [unlinked] } };
const before = JSON.stringify(input);
const wire: any = projectFoundationModelInput(input);
assert.equal(JSON.stringify(input), before);
assert.deepEqual(wire.source, source);
assert.deepEqual(wire.confirmedDecisions, input.confirmedDecisions);
assert.deepEqual(wire.candidates.f2.assets[0].sceneRefs, [[0, 'S0']]);
assert.deepEqual(restoreSceneRefs(wire.candidates), input.candidates);
assert.equal(wire.facts.rows.length, 1);
assert.equal(wire.facts.omittedCurrentIndexCount, 1);
assert.equal(wire.facts.groups.current, undefined);
assert.equal(wire.facts.groups.unlinkedBackground, undefined);
assert.equal(wire.facts.rows[0][5], background.statement);
assert.deepEqual(wire.facts.rows[0][6], background.validity);
for (const external of [
  { ...fact, statement: '外部补充，不能当成原文删掉' },
  { ...fact, validity: { status: 'EXPLICIT', start: 0 } },
  { ...fact, evidence: { ...fact.evidence, episode: 999 } },
]) {
  const result: any = projectFoundationModelInput({ ...input, facts: { current: [external] } });
  assert.equal(result.facts.rows.length, 1);
  assert.equal(result.facts.omittedCurrentIndexCount, 0);
}
const fragment: any = projectFoundationModelInput({ ...input, source: { episodes: [{ number: 0, lineCount: 2, lines: [[2, '\r\n']] }] }, facts: { current: [fact] } });
assert.equal(fragment.facts.rows.length, 1);
assert.deepEqual(projectFoundationModelInput(wire), wire);
assert(!JSON.stringify(wire).includes(fact.id));

async function main() {
  if (!process.argv.includes('--saved')) { console.log('Foundation model-input semantic preservation passed'); return; }
  const db = new PrismaClient();
  try {
    await db.$executeRawUnsafe('PRAGMA query_only = ON');
    const runs = await db.pipelineRun.findMany({ where: { projectId: (process.env.QA_PROJECT_ID || 'missing-test-project'), stageCode: { in: ['F2', 'Q1'] } }, orderBy: { createdAt: 'desc' } });
    const report = runs.flatMap(run => {
      let log: any; try { log = JSON.parse(run.log ?? '{}'); } catch { return []; }
      return (log.calls ?? []).flatMap((call: any) => {
        const marker = 'INPUT_JSON:\n', prompt = call.taskPrompt ?? '', position = prompt.indexOf(marker);
        if (position < 0) return [];
        let parsed: any; try { parsed = JSON.parse(prompt.slice(position + marker.length)); } catch { return []; }
        const projected: any = projectFoundationModelInput(parsed);
        for (const key of Object.keys(parsed).filter(key => key !== 'facts')) assert.deepEqual(restoreSceneRefs(projected[key]), restoreSceneRefs(parsed[key]));
        const oldSize = JSON.stringify(parsed).length, newSize = JSON.stringify(projected).length;
        const freshPrompt = buildLightFoundationPrompt(run.stageCode as 'F2' | 'Q1', parsed);
        return [{ runId: run.id, stage: run.stageCode, sequence: call.sequence, scope: parsed.scope, inputBefore: oldSize, inputAfter: newSize,
          factsBefore: JSON.stringify(parsed.facts).length, factsAfter: JSON.stringify(projected.facts).length,
          requestBefore: prompt.length + (call.systemPrompt?.length ?? 0), requestAfter: freshPrompt.length + (call.systemPrompt?.length ?? 0),
          savedInputChars: oldSize - newSize, savedRequestChars: prompt.length - freshPrompt.length, nonFactSemanticsRestoredExactly: true,
          sourceAndScenesIdentical: JSON.stringify(projected.source) === JSON.stringify(parsed.source) && JSON.stringify(projected.scenes) === JSON.stringify(parsed.scenes) }];
      });
    });
    await writeFile('runtime-3008/payload-wire-projection.json', JSON.stringify({ unit: 'UTF-16 characters; offline saved-request replay, not measured model tokens', report }, null, 2));
    console.log(JSON.stringify(report));
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
