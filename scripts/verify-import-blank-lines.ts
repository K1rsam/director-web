import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, readdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import JSZip from 'jszip';
import {parseScriptBuffer, parseScriptContent, splitEpisodes, type ImportedScript} from '../lib/import-script';
import {assertFidelityMaterialization, prepareFidelityImport, prepareFidelityReading, type FidelityResult} from '../lib/fidelity-import';
import {projectPinnedFidelitySource} from '../lib/fidelity-source-projection';
import {createSource, normalize} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const raw = '\r\n \t\u3000\u00a0\r第5集\r\n\r\n5-1 屋内 日 内\r\n\t\r\n  甲：保留 😀 与\t空格。  \r\n\u3000\u00a0\r\n△甲点头。\r\n\r\n';
const clean = '第5集\r\n5-1 屋内 日 内\r\n  甲：保留 😀 与\t空格。  \r\n△甲点头。\r\n';
function checkRawAudit(imported: ImportedScript, original: string) {
  assert.equal(imported.sourceText, original, '原读取文本不能改写');
  assert.equal(imported.sourceStructure.sections.map(s => original.slice(s.start, s.end)).join(''), original, '原分区仍完整覆盖原读取文本');
}
function checkCleanup(imported: ImportedScript, expected: string) {
  const cleanup = Reflect.get(imported.readingView, 'blankLineCleanup');
  assert.equal(cleanup?.version, 'SCRIPT_BLANK_LINES_V1');
  let cursor = 0, rebuilt = '';
  for (const range of cleanup.removedRanges) {
    assert.ok(range.start >= cursor && range.end > range.start);
    assert.equal(imported.sourceText.slice(range.start, range.end).trim(), '', '删除范围只能含空白');
    rebuilt += imported.sourceText.slice(cursor, range.start); cursor = range.end;
  }
  assert.equal(rebuilt + imported.sourceText.slice(cursor), expected, '原坐标删除映射能还原清洗稿');
}

test('paste and file readers remove blank-only lines while preserving raw UTF16 offsets and nonblank EOLs', async () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const original = ` \t${eol}第7集${eol}${eol}\u3000\u00a0${eol}  甲：原话 😀。  ${eol}\t${eol}`;
    const expected = `第7集${eol}  甲：原话 😀。  ${eol}`;
    for (const imported of [parseScriptContent('paste.txt', original), await parseScriptBuffer('file.txt', Buffer.from(original)), await parseScriptBuffer('file.md', Buffer.from(original))]) {
      assert.equal(imported.episodes[0].content, expected);
      assert.equal(imported.episodes[0].number, 7);
      checkRawAudit(imported, original); checkCleanup(imported, expected);
      if (imported.originalFile) assert.equal(imported.originalFile.base64, Buffer.from(original).toString('base64'));
    }
    assert.equal(splitEpisodes(original)[0].content, expected);
    assert.equal(parseScriptContent('again.txt', expected).episodes[0].content, expected, '清理幂等');
  }
  const whitespace = parseScriptContent('empty.txt', '\n \t\u3000\u00a0\r\n');
  assert.deepEqual(whitespace.episodes, []); checkRawAudit(whitespace, whitespace.sourceText); checkCleanup(whitespace, '');
});

test('new fidelity imports clean working bodies without altering raw receipts, source numbering or pinned proof', async () => {
  const prepared = await prepareFidelityImport('new.txt', Buffer.from(raw), 'fidelity');
  assert.equal(prepared.imported.episodes[0].content, clean);
  assert.equal(prepared.imported.episodes[0].number, 5);
  checkRawAudit(prepared.imported, raw); checkCleanup(prepared.imported, clean);
  assert.equal(prepared.receipt.readingHash, hash(raw));
  assert.equal(prepared.receipt.originalHash, hash(raw));
  assert.deepEqual(prepared.receipt.result, normalize(createSource(raw)), '保真原文、计划、segments和normalizedText保持原证据');
  assertFidelityMaterialization(prepared.imported, prepared.receipt);
  const {episodes, ...compact} = prepared.imported;
  assert.deepEqual(projectPinnedFidelitySource(compact, prepared.receipt), prepared.imported);
  const corrupt = structuredClone(prepared.imported);
  corrupt.readingView.blankLineCleanup!.removedRanges[0].end++;
  assert.throws(() => assertFidelityMaterialization(corrupt, prepared.receipt), /空行|清洗/);
  assert.throws(() => projectPinnedFidelitySource(corrupt, prepared.receipt));
  const changedBody = {...prepared.imported, episodes: episodes.map(e => ({...e, content: e.content.replace('原话', '改话') + '改'}))};
  assert.throws(() => assertFidelityMaterialization(changedBody, prepared.receipt));
});

test('DOCX blank paragraphs are removed from work content while original bytes and reading text remain recoverable', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:p><w:r><w:t>第5集</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">　 </w:t><w:tab/></w:r></w:p><w:p><w:r><w:t>5-1 屋内 日 内</w:t><w:br/><w:t xml:space="preserve">  甲：保留</w:t><w:tab/><w:t>原话。  </w:t></w:r></w:p></w:body></w:document>');
  const bytes = await zip.generateAsync({type: 'nodebuffer'});
  const prepared = await prepareFidelityImport('paragraphs.docx', bytes, 'fidelity');
  assert.equal(prepared.imported.episodes[0].content, '第5集\n5-1 屋内 日 内\n  甲：保留\t原话。  \n');
  assert.ok(prepared.imported.sourceText.includes('\n\n'));
  assert.equal(prepared.imported.originalFile?.base64, bytes.toString('base64'));
  checkRawAudit(prepared.imported, prepared.imported.sourceText);
  assertFidelityMaterialization(prepared.imported, prepared.receipt);
});

test('JSON package and paired-original imports receive a new clean projection without rewriting the supplied source plan', async () => {
  const result = normalize(createSource(raw)) as FidelityResult;
  const bytes = Buffer.from(JSON.stringify({source: result.source, plan: result.plan}));
  for (const original of [undefined, {name: 'original.txt', bytes: Buffer.from(raw)}]) {
    const prepared = await prepareFidelityImport('fidelity-import.json', bytes, 'direct', [], false, original);
    assert.equal(prepared.imported.episodes[0].content, clean);
    checkRawAudit(prepared.imported, raw); checkCleanup(prepared.imported, clean);
    assert.deepEqual(prepared.receipt.result.plan, result.plan);
    assertFidelityMaterialization(prepared.imported, prepared.receipt);
  }
});

test('untagged old source receipts keep their original blank lines during projection and review continuation', () => {
  const legacy: ImportedScript = {sourceName: 'old.txt', sourceText: raw, episodes: [], sourceStructure: {version: 'SOURCE_STRUCTURE_V1', sections: [], issues: []}, readingView: {kind: 'TEXT', view: 'IN_MEMORY_TEXT', warnings: []}};
  const prepared = prepareFidelityReading(legacy, 'fidelity', [], hash(raw));
  assert.ok(prepared.imported.episodes[0].content.includes('\r\n\r\n'));
  assert.equal(Reflect.get(prepared.imported.readingView, 'blankLineCleanup'), undefined);
  const before = structuredClone(prepared);
  assert.deepEqual(projectPinnedFidelitySource(prepared.imported, prepared.receipt), prepared.imported);
  assert.deepEqual(prepareFidelityReading(prepared.imported, 'fidelity', [], hash(raw)), prepared);
  assert.deepEqual(prepared, before);
});

test('actual project import persists clean Episode content and source maps in an isolated database', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'director-blank-lines-'));
  const database = path.join(directory, 'test.db');
  const sql = new DatabaseSync(database);
  for (const migration of readdirSync('prisma/migrations').sort()) if (/^\d/.test(migration)) sql.exec(readFileSync(path.join('prisma/migrations', migration, 'migration.sql'), 'utf8'));
  sql.close(); process.env.DATABASE_URL = `file:${database}`;
  const {prisma} = await import('../lib/prisma');
  const {importParsedProject, importProjectFromText} = await import('../lib/workflow');
  try {
    const owner = await prisma.user.create({data: {username: 'blank-lines', email: 'blank-lines@synthetic.invalid', passwordHash: 'offline'}});
    const prepared = await prepareFidelityImport('new.txt', Buffer.from(raw), 'fidelity');
    const meta = {ownerUserId: owner.id, title: '隔离清洗验证', sourceName: 'new.txt'};
    for (const result of [await importParsedProject({...meta, fidelityReceipt: prepared.receipt}, prepared.imported, prisma), await importProjectFromText({...meta, sourceText: raw}, prisma)]) {
      const episodes = await prisma.episode.findMany({where: {projectId: result.project.id}});
      assert.equal(episodes[0].content, clean, '数据库中的工作正文必须真正清洗，不能只在界面隐藏');
      const snapshot = await prisma.sceneSnapshot.findFirstOrThrow({where: {projectId: result.project.id, sceneKey: 'SOURCE_IMPORT'}});
      const imported = JSON.parse(snapshot.content) as ImportedScript;
      checkRawAudit(imported, raw); checkCleanup(imported, clean);
      const scenes = await prisma.scriptScene.findMany({where: {episodeId: {in: episodes.map(episode => episode.id)}}});
      assert.ok(scenes.length); assert.ok(scenes.every(scene => !/\r\n\r\n/.test(scene.sourceText)));
      assert.equal(await prisma.pipelineRun.count({where: {projectId: result.project.id}}), 0);
    }
    const {refreshFidelitySource} = await import('../lib/fidelity-refresh');
    const {project} = await importParsedProject({...meta, fidelityReceipt: prepared.receipt}, prepared.imported, prisma);
    const scene = await prisma.scriptScene.findFirstOrThrow({where: {episode: {projectId: project.id}}});
    const retired = await prisma.sceneSnapshot.create({data: {projectId: project.id, episodeId: scene.episodeId, sceneKey: 'RETIRED_P0_SCENE-old-key', content: scene.sourceText, metadata: JSON.stringify({schema: 'RETIRED_P0_SCENE_V1', sceneKey: 'old-key', metadata: {sourceHash: hash(scene.sourceText), characters: [], props: []}})}});
    assert.ok(!raw.includes(scene.sourceText), '空行清洗后派生场次不必再是原文连续子串');
    await refreshFidelitySource(project.id, prisma, {decisions: [{start: 0, end: raw.length, kind: 'context', note: '隔离测试确认背景'}], checkCurrent: async () => {}});
    assert.deepEqual(await prisma.sceneSnapshot.findUniqueOrThrow({where: {id: retired.id}}), {...retired, episodeId: null}, '已核验的新清洗正文仍是合法派生历史，不能误判为人工改写');
  } finally { await prisma.$disconnect(); }
});
