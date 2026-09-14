/** Read-only fake snapshot store: duplicate headings never authorize moving source text. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SourceStructure } from '@/lib/import-script';
import { duplicateSourceHeadingKeys } from '@/lib/source-structural-headings';
import { loadFoundationSourceContext } from '@/lib/foundation-source';

const fixture = (heading = '第 1 集\n\n', body = '第一集\n1-1 日 外 广场\n人物：甲\n甲：原文不得改变。\n', episodeNumber = 1) => {
  const text = heading + body;
  const structure: SourceStructure = { version: 'SOURCE_STRUCTURE_V1', sections: [
    { key: 'unresolved-heading', kind: 'UNRESOLVED', start: 0, end: heading.length },
    { key: 'body-episode', kind: 'EPISODE', episodeNumber, start: heading.length, end: text.length }
  ], issues: [] };
  return { text, structure };
};
const rejects = (value: ReturnType<typeof fixture>) => assert.deepEqual([...duplicateSourceHeadingKeys(value.text, value.structure)], []);
for (const value of [fixture(), fixture('第 0 集\r\n', '第零集\r\n0-1 日 内 大厅\r\n人物：甲\r\n', 0), fixture('EP 12\n', '第十二集\n12-1 日 内 大厅\n', 12)]) {
  const original = structuredClone(value);
  assert.deepEqual([...duplicateSourceHeadingKeys(value.text, value.structure)], ['unresolved-heading']);
  assert.deepEqual(value, original);
}
rejects(fixture('第2集\n'));
rejects(fixture('第1集\n', '第二集\n正文', 1));
rejects(fixture('第1集\n', '第一集\n正文', 2));
rejects(fixture('第1集\n甲：不能漏掉这句。\n'));
rejects(fixture('第1集 剧情梗概\n'));
rejects(fixture('第1集\n', '1-1 日 外 广场\n甲：没有重复标题。\n'));
const readingIssue = fixture();
readingIssue.structure.issues.push({ code: 'READER_LOST_TEXT', message: '本段读取缺损', sectionKeys: ['unresolved-heading'] });
rejects(readingIssue);
const nonAdjacent = fixture();
nonAdjacent.structure.sections.splice(1, 0, { key: 'between', kind: 'BACKGROUND', start: nonAdjacent.structure.sections[0].end, end: nonAdjacent.structure.sections[0].end });
rejects(nonAdjacent);
const gap = fixture(); gap.structure.sections[1].start++;
rejects(gap);
const assigned = fixture(); assigned.structure.sections[0].kind = 'BACKGROUND';
rejects(assigned);

async function load(value: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  const readingView = { kind: 'DOCX', warnings: ['读取原件提示保持可见'] };
  const snapshot = { id: 'immutable-import-1', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }), content: JSON.stringify({ sourceText: value.text, sourceStructure: value.structure, readingView, ...extra }) };
  const original = structuredClone(snapshot), calls: string[] = [];
  const db = { sceneSnapshot: {
    findMany: async (args: { where: { sceneKey: string } }) => { assert.equal(args.where.sceneKey, 'SOURCE_IMPORT'); calls.push('read-import'); return [snapshot]; },
    findFirst: async (args: { where: { sceneKey: string } }) => { assert.equal(args.where.sceneKey, 'SOURCE_STRUCTURE_RESOLUTION'); calls.push('read-resolution'); return null; }
  } } as unknown as Parameters<typeof loadFoundationSourceContext>[1];
  const context = await loadFoundationSourceContext('offline-project', db);
  assert.deepEqual(snapshot, original, '源文、原始结构与导入记录必须完全不变');
  assert.deepEqual(calls, context.coverage === 'UNKNOWN' ? ['read-import'] : ['read-import', 'read-resolution'], '仅允许读取现有来源和结构决定；坏结构应提前拒绝');
  const expectedVersion = createHash('sha256').update(JSON.stringify({ snapshotId: snapshot.id, sourceText: value.text, sections: value.structure.sections, issues: value.structure.issues, readingView }), 'utf8').digest('hex');
  return { context, expectedVersion };
}

async function main() {
  const valid = fixture(), original = structuredClone(valid);
  const { context, expectedVersion } = await load(valid);
  assert.deepEqual(valid, original);
  assert.equal(context.version, expectedVersion, '只改解释层，来源版本仍以未改动的原文与结构计算');
  assert.deepEqual(context.background, []);
  assert.deepEqual(context.issues, []);
  assert.deepEqual(context.unresolved, []);
  assert.equal(context.complete, true);
  assert.equal(context.coverage, 'COMPLETE');
  assert.deepEqual(context.notices.map(item => item.code), ['DOCX_READER_WARNING', 'REPEATED_EPISODE_HEADING']);
  assert.equal(context.notices[0].message, '读取原件提示保持可见');
  for (const value of [fixture('第2集\n'), fixture('第1集\n甲：正文。\n'), fixture('第1集\n', '第一场\n正文'), readingIssue, nonAdjacent]) {
    const result = await load(value);
    assert.equal(result.context.version, result.expectedVersion);
    assert.equal(result.context.complete, false);
    assert.equal(result.context.unresolved[0].text, value.text.slice(value.structure.sections[0].start, value.structure.sections[0].end));
    assert.deepEqual(result.context.issues, value.structure.issues);
    assert.ok(!result.context.notices.some(item => item.code === 'REPEATED_EPISODE_HEADING'));
  }
  const globalIssue = fixture(); globalIssue.structure.issues.push({ code: 'READ_FAILURE', message: '未定位读取错误', sectionKeys: [] });
  const global = await load(globalIssue);
  assert.equal(global.context.complete, false, '无定位读取错误仍阻断，不能被标题去疑点掩盖');
  assert.deepEqual(global.context.issues, globalIssue.structure.issues);
  const invalid = await load(gap);
  assert.equal(invalid.context.complete, false);
  assert.equal(invalid.context.coverage, 'UNKNOWN');
  assert.ok(invalid.context.issues.some(issue => issue.code === 'INVALID_SOURCE_IMPORT_STRUCTURE'));
  console.log('PASS structural heading source interpretation: strict adjacency/same episode/pure heading, reader-error counterexamples, immutable source/version, read-only context changes (fake snapshots, no DB/AI)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
