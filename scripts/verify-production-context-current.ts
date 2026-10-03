/** Offline request comparison against a consistent DB copy. Never dispatches a model or changes the real DB. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const require = createRequire(import.meta.url);
const size = (value: unknown) => JSON.stringify(value)?.length ?? 0;
const groups = ['current', 'background', 'backgroundCandidates', 'historicalStates', 'unlinkedBackground', 'sourceFactIndex'];
const inputOf = (request: any) => JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n').at(-1).split('\n\n')[0]);
function decode(facts: any): any {
  if (!Array.isArray(facts?.rows) || !Array.isArray(facts.columns) || !facts.groups) return facts;
  const { format: _format, columns, interpretation: _interpretation, rows, groups: memberships, ...rest } = facts;
  for (const [name, members] of Object.entries(memberships) as [string, any[]][]) rest[name] = members.map(member => {
    const row = rows[Array.isArray(member) ? member[0] : member], fact: any = {};
    for (const [index, column] of columns.entries()) {
      const key = column.replace(/\?$/, ''), value = row[index];
      if (key === 'extra') Object.assign(fact, value);
      else if (value !== undefined && !(key === 'statement' && (value === null || Array.isArray(member)))) fact[key] = value;
    }
    return fact;
  });
  return rest;
}
function proveFacts(source: any, modelSource: any) {
  const original = source.context.retrievalFacts, actual = decode(modelSource.context.retrievalFacts);
  const rows = new Map([...modelSource.sourceRows, ...modelSource.contextRows].map((r: any) => [r.id, r.text]));
  const pkg = source.standardPackage, episode = /^episode-(0|[1-9]\d*)$/.exec(pkg?.binding?.sourceId ?? '');
  const fullText = pkg?.evidence?.map((item: any) => item.text).join('');
  const sentRanges = modelSource.sourceRows.map((row: any) => {
    const canonical = source.sourceRows.find((r: any) => r.id === row.id), start = pkg.evidence[canonical.line - 1]?.start;
    assert.equal(fullText.slice(start, start + row.text.length), row.text);
    return [start, start + row.text.length];
  });
  const candidates = original.historicalEvidenceCandidates ?? [];
  const linkedIds = new Set(candidates.flatMap((f: any) => f.retrieval?.anchorFactIds ?? []));
  let omitted = 0, reusedStatements = 0;
  for (const group of groups) for (const fact of original[group] ?? []) {
    const same = (candidate: any) => {
      const restored = { ...candidate };
      if (restored.id === undefined) {
        assert.equal(candidates.length, 0, 'with historical candidates, fact IDs must remain addressable');
        restored.id = fact.id;
      }
      if (fact.statement !== undefined && restored.statement === undefined) {
        const refs = typeof restored.contextRef === 'string' ? [restored.contextRef] : restored.contextRefs ?? [];
        if (!refs.length || refs.some((ref: string) => !rows.has(ref))) return false;
        restored.statement = refs.map((ref: string) => rows.get(ref)).join('');
      }
      return JSON.stringify(restored) === JSON.stringify(fact) || (() => {
        try { assert.deepEqual(restored, fact); return true; } catch { return false; }
      })();
    };
    const retained = (actual[group] ?? []).find(same);
    if (retained) {
      if (fact.statement !== undefined && retained.statement === undefined) reusedStatements++;
      continue;
    }
    // An omission needs complete source in this request, not merely a path or a stored package.
    assert.ok(['current', 'sourceFactIndex'].includes(group), `${group}: nonmechanical evidence cannot disappear`);
    assert.equal(linkedIds.has(fact.id), false, 'referenced IDs cannot disappear');
    assert.deepEqual(Object.keys(fact).sort(), ['id', 'evidence', 'subjects', 'kind', 'claim', 'applicability', 'validity', ...(fact.statement !== undefined ? ['statement'] : [])].sort());
    assert.deepEqual(fact.validity, { status: 'UNKNOWN' });
    assert.equal(fact.evidence.domain, 'EPISODE');
    assert.equal(fact.evidence.episode, Number(episode![1]));
    assert.ok(fact.evidence.end > fact.evidence.start);
    assert.ok(sentRanges.some(([start, end]: number[]) => start <= fact.evidence.start && end >= fact.evidence.end));
    if (fact.statement !== undefined) assert.equal(fact.statement, fullText.slice(fact.evidence.start, fact.evidence.end));
    omitted++;
  }
  for (const [key, value] of Object.entries(original)) if (!groups.includes(key) && !['sourceVersion', 'sourceContextVersion', 'schema'].includes(key)) {
    if (['backgroundCandidatesOmitted', 'unlinkedBackgroundCount'].includes(key) && value === 0 && actual[key] === undefined) continue;
    assert.deepEqual(actual[key], value, `fact root metadata: ${key}`);
  }
  return { omittedMechanicalRecords: omitted, reusedStatements, historicalCandidates: candidates.length };
}

async function main() {
  const projectId = process.argv[process.argv.indexOf('--project') + 1];
  if (!process.argv.includes('--project') || !projectId) throw new Error('Use --project <local project ID>; no model task will run.');
  const scratch = mkdtempSync(path.join(tmpdir(), '3008-projection-check-'));
  let db: any;
  try {
    const originalDb = new DatabaseSync(path.resolve('prisma/dev.db'), { readOnly: true });
    try { await backup(originalDb, path.join(scratch, 'audit.db')); } finally { originalDb.close(); }
    Object.assign(process.env, { DATABASE_URL: 'file:' + path.join(scratch, 'audit.db'), NODE_ENV: 'production' });
    db = require('../lib/prisma').prisma;
    const runner = require('../lib/role-runner'), stop = async () => { throw new Error('Offline verification forbids model dispatch'); };
    require.cache[require.resolve('../lib/role-runner')]!.exports = { ...runner, runRoleByProvider: stop, runCliRoleJson: stop, runApiRoleJson: stop };
    const { readProductionEpisodeHandoff } = require('../lib/episode-upstream-material');
    const { makeEpisodeInput } = require('../runtime/storyboard-v4/input.mjs');
    const { splitProductionMaterials, selectProductionMaterials } = require('../runtime/production-materials.mjs');
    const { makeBoundaryContext } = require('../runtime/episode-boundary.mjs');
    const { buildRequest, captureRules } = require('../runtime/storyboard-v4/core/core.mjs');
    const { PLAN_VERSION, VERSION } = require('../runtime/storyboard-v4/core/shared.mjs');
    const metrics = [];
    for (const number of [1, 2]) {
      const episode = await db.episode.findFirstOrThrow({ where: { projectId, number }, include: { project: true } });
      const handoff = await readProductionEpisodeHandoff(projectId, number);
      const prepared = splitProductionMaterials(makeEpisodeInput({ episode, project: episode.project, handoff, inputProtocol: 'upstream-material-v2' }));
      const before = structuredClone(prepared), source = prepared.source;
      const emotionContract = { subject: '原文人物', contextTone: '离线结构探针，不是采用方案', audienceEffect: '验证资料保留', change: '按原文完整事件', landing: '原文结尾', retain: ['全部台词、情绪与来源'] };
      const sourceRefs = source.sourceRows.map((row: any) => row.id);
      const plan = { schemaVersion: PLAN_VERSION, unitPackingPolicy: 'event-first-v1', emotionArc: '离线结构探针', entryFacts: [], fantasyCandidates: [], events: [{ id: 'e1', sourceRefs, sceneKey: 'audit', boundaryBefore: { kind: 'episode_start', reason: '本集开始' }, emotionContract }], workPackages: [{ id: 'p1', eventId: 'e1', sourceRefs, emotionContract, entryFactIds: [], contextRefs: [], dependsOn: [], scenarioKeys: [] }], provisionalUnits: [{ id: 'u1', packageId: 'p1', sourceRefs, secondsRange: [2, 5] }] };
      for (const stage of ['plan', 'author', 'finish', 'delta']) {
        const productionSnapshot = { version: 'production-feedback-v1', transportVersion: 'production-text-reuse-v1', touchesOpening: true, touchesEnding: true, materials: selectProductionMaterials(prepared.materials, stage === 'delta' ? 'finish' : stage, stage === 'plan' ? null : plan.workPackages[0], []), episodeBoundary: makeBoundaryContext({ seed: handoff.packet.episodeBoundary, chainMode: 'SINGLE' }), outgoingAgreements: [] };
        const payload = { stage: stage === 'delta' ? 'finish' : stage, source, plan, packageId: 'p1', settings: { model: 'gpt-6.1-sol', reasoning: 'medium', maxUnitSeconds: 30, maxUnits: null, fantasyMode: 'recommended', visualStyle: prepared.visualStyle }, finishMode: stage === 'delta' ? 'delta' : 'full', ...(stage === 'finish' || stage === 'delta' ? { previousDraft: { schemaVersion: VERSION, units: [{ id: 'p1-u1', shots: [] }], fantasyRealization: [] } } : {}), productionSnapshot };
        const rules = captureRules(), request = buildRequest({ ...payload, rulesSnapshot: rules });
        const previous = buildRequest({ ...payload, rulesSnapshot: { ...rules, modelProjectionVersion: 'production-context-v2' } });
        const actual = inputOf(request), old = inputOf(previous);
        for (const key of ['sourceRows', 'contextRows', 'dialogue', 'onscreenTexts', 'entryFacts', 'assets']) assert.deepEqual(actual.source[key], old.source[key], `${number}/${stage}: ${key}`);
        for (const [key, value] of Object.entries(old.source.context)) if (key !== 'retrievalFacts') assert.deepEqual(actual.source.context[key], value, `${number}/${stage}: context ${key}`);
        for (const key of ['settings', 'plan', 'previousDraft', 'productionMaterials', 'episodeBoundary', 'voiceReference', 'selection', 'outgoingAgreements']) assert.deepEqual(actual[key], old[key], `${number}/${stage}: ${key}`);
        assert.deepEqual(request.schema, previous.schema, 'output requirements remain identical');
        const retention = proveFacts(source, actual.source);
        const dispatchChars = request.prompt.length + request.instructions.length + size(request.schema), previousDispatchChars = previous.prompt.length + previous.instructions.length + size(previous.schema);
        metrics.push({ episode: number, stage, previousPromptChars: previous.prompt.length, promptChars: request.prompt.length, previousFactChars: size(old.source.context.retrievalFacts), factChars: size(actual.source.context.retrievalFacts), savedDispatchChars: previousDispatchChars - dispatchChars, savedPercent: Number(((previousDispatchChars - dispatchChars) / previousDispatchChars * 100).toFixed(2)), ...retention });
      }
      assert.deepEqual(prepared, before, 'canonical input was not mutated');
    }
    console.log(JSON.stringify({ modelCalls: 0, unit: 'UTF16 characters, not tokens or creative-quality validation', comparison: 'production-context-v2 -> production-context-v3; real source/materials; synthetic one-package plan/draft for request assembly', retentionChecks: 'nonblank source, complete dialogue/cues/channels, entry facts, assets, direction/design/continuity/materials, output schema, historical evidence and links, canonical immutability', metrics }, null, 2));
  } finally {
    if (db) await db.$disconnect();
    // Only the explicitly created scratch copy is removed; the real DB is never written.
    rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
