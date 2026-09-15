/** Frozen-v2 verification precedes current interpretation; no database or provider. */
import assert from 'node:assert/strict';
import { createSource, normalize, validatePlan } from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import { normalize as normalizeV2, proposePlan as proposeV2, validatePlan as validateV2 } from '../lib/fidelity-v2.mjs';
import { prepareFidelityImport, type FidelityResult } from '../lib/fidelity-import';
import { createFidelityExternalMaterial } from '../lib/fidelity-external';
import { planP1ReviewBatches } from '../lib/fidelity-p1-review';

async function main() {
  const text = '第1集 归来 场1-1 日 外 门口 人物：甲 △甲停步。甲：到了。\r\n场1-2 夜 内 大厅 人物：乙 乙：进来。\r\n第2集\n2-1\n\n街道 日 / 外\n甲：离开。\n';
  const source = createSource(text), old = normalizeV2(source) as FidelityResult;
  assert.equal(old.contractVersion, 'fidelity/2');
  assert.equal(old.episodes.reduce((n, episode) => n + episode.scenes.length, 0), 0);
  const body = { source, plan: old.plan }, original = JSON.stringify(body);
  const upgraded = await prepareFidelityImport('v2.json', Buffer.from(original), 'direct');
  assert.equal(upgraded.receipt.result.contractVersion, 'fidelity/4');
  assert.deepEqual(upgraded.receipt.result.episodes.map(episode => episode.scenes.length), [2, 1]);
  assert.equal(upgraded.receipt.readingHash, old.source.sourceVersion);
  assert.equal(upgraded.receipt.result.source.text, text);
  assert.equal(JSON.stringify(body), original);
  assert.ok(upgraded.receipt.reader.warnings.some(message => message.includes('核验旧清洗包')));
  assert.equal(validatePlan(source, old.plan).ok, false, 'current validator cannot directly accept the old semantic bindings');
  assert.deepEqual(upgraded.receipt.result.segments.map(row => [row.start, row.end, row.text]), old.segments.map(row => [row.start, row.end, row.text]));
  const blocks = createFidelityExternalMaterial(text).blocks;
  assert.deepEqual(upgraded.receipt.result.segments.map(row => [row.start, row.end, row.text]), blocks.map(row => [row.start, row.end, row.text]));
  assert.equal(planP1ReviewBatches(text).flat().map(block => block.text).join(''), text);
  for (const mutate of [
    (plan: Record<string, any>) => { plan.segments[0].sceneId = 'forged-scene'; },
    (plan: Record<string, any>) => { plan.segments[0].kind = 'body'; },
    (plan: Record<string, any>) => { plan.segments[1].speakerLabels = ['伪造人物']; },
    (plan: Record<string, any>) => { plan.segments[1].end++; },
    (plan: Record<string, any>) => { plan.issues = []; },
    (plan: Record<string, any>) => { plan.issues[0].message = '假称已解决'; }
  ]) {
    const tampered = structuredClone(body); mutate(tampered.plan);
    await assert.rejects(prepareFidelityImport('tampered-v2.json', Buffer.from(JSON.stringify(tampered)), 'direct'), /被修改|保真/);
  }
  const fakeVersion = structuredClone(body); fakeVersion.plan.contractVersion = 'fidelity/3';
  await assert.rejects(prepareFidelityImport('fake-v3.json', Buffer.from(JSON.stringify(fakeVersion)), 'direct'), /被修改|保真/);
  const unknownVersion = structuredClone(body); unknownVersion.plan.contractVersion = 'fidelity/999';
  await assert.rejects(prepareFidelityImport('unknown.json', Buffer.from(JSON.stringify(unknownVersion)), 'direct'), /保真/);
  // Earlier v2 wrote one diagnostic per line. Accept only the exact frozen format.
  const groupedSource = createSource('第一集\n甲段\n乙段\n'), grouped = proposeV2(groupedSource) as Record<string, any>;
  const linewise = structuredClone(grouped);
  linewise.issues = linewise.issues.flatMap((issue: any) => linewise.segments.filter((segment: any) => segment.start >= issue.start && segment.end <= issue.end).map((segment: any) => ({ ...issue, start: segment.start, end: segment.end })));
  assert.equal(validateV2(groupedSource, linewise).ok, true);
  await prepareFidelityImport('old-linewise-v2.json', Buffer.from(JSON.stringify({ source: groupedSource, plan: linewise })), 'direct');
  const partial = structuredClone(linewise); partial.issues.pop();
  await assert.rejects(prepareFidelityImport('missing-issue.json', Buffer.from(JSON.stringify({ source: groupedSource, plan: partial })), 'direct'), /被修改/);
  // Explicit accepted decisions survive; untrusted decisions still require authorization.
  const decisions = [{ start: 0, end: text.indexOf('\r\n') + 2, kind: 'body', episodeNumber: 1, sceneNumber: 1, note: '已有已采纳范围' }];
  const decided = { source, plan: proposeV2(source, { decisions }) };
  await assert.rejects(prepareFidelityImport('untrusted-v2.json', Buffer.from(JSON.stringify(decided)), 'direct'), /采用权限/);
  const accepted = await prepareFidelityImport('trusted-v2.json', Buffer.from(JSON.stringify(decided)), 'direct', [], true);
  assert.deepEqual(accepted.receipt.decisions, decisions);
  assert.equal(accepted.receipt.result.source.text, text);
  assert.equal((normalize(source) as FidelityResult).validation.ok, true);
  console.log('PASS current fidelity: frozen v2 verification before upgrade, linewise/grouped diagnostics strict, tamper/unknown-version rejection, accepted decisions and complete source blocks preserved (no DB/AI)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
