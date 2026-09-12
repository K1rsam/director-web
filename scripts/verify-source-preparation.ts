import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { importProjectFromText } from "@/lib/workflow";
import { prepareFoundationSource, readSourcePreparation } from "@/lib/source-preparation";
import { preprocessProject } from "@/lib/project-preprocess";
import { loadFoundationSourceContext } from "@/lib/foundation-source";

const directory = mkdtempSync(join(tmpdir(), "source-preparation-"));
const databaseUrl = `file:${join(directory, "test.db")}`;
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const schemaPath = join(directory, "schema.prisma");
cpSync(join(process.cwd(), "prisma/schema.prisma"), schemaPath);
execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "db", "push", "--skip-generate", "--schema", schemaPath], { cwd: directory, stdio: "pipe", env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "info" } });

async function project(text: string) {
  const owner = await db.user.upsert({ where: { email: "source-prep@example.invalid" }, update: {}, create: { username: "source-prep", email: "source-prep@example.invalid", passwordHash: "offline" } });
  return (await importProjectFromText({ ownerUserId: owner.id, title: "source prep", sourceName: "source.txt", sourceText: text }, db)).project;
}

async function main() {
try {
  const clear = await project("第1集\n1-1 客厅 夜 内\n苏远：回来。\n");
  const before = await readSourcePreparation(clear.id, db);
  assert.equal(before.project.episodes.length, 1);
  const clearResult = await prepareFoundationSource(clear.id, db);
  assert.deepEqual([clearResult.assisted, clearResult.episodeCount, clearResult.unresolved], [false, 1, []], "clear source skips F1");

  const ambiguous = await project("第1集\n甲\n第2集\n乙\n第1集\n丙\n");
  const ambiguousBefore = await readSourcePreparation(ambiguous.id, db);
  let calls = 0;
  const ambiguousResult = await prepareFoundationSource(ambiguous.id, db, { assist: async (request, validate) => {
    calls++; const key = request.sections.find((section) => section.key.startsWith("UNRESOLVED-1-"))!.key;
    return { plan: validate({ assignments: [{ sectionKey: key, kind: "EPISODE", episodeNumber: 1 }] }), runId: "f1-test" };
  } });
  assert.equal(calls, 1); assert.equal(ambiguousResult.assisted, true);
  assert.notEqual(ambiguousResult.sourceInputVersion, ambiguousBefore.sourceInputVersion, "prepare returns the post-materialization source version for the next queue pin");
  const original = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: ambiguous.id, sceneKey: "SOURCE_IMPORT" } });
  assert.match(JSON.parse(original.content).sourceText, /第1集\n甲/, "original import remains immutable");
  assert.equal(await db.sceneSnapshot.count({ where: { projectId: ambiguous.id, sceneKey: "SOURCE_STRUCTURE_RESOLUTION" } }), 1);
  await prepareFoundationSource(ambiguous.id, db, { assist: async () => { calls++; throw new Error("same resolution must not call F1"); } });
  assert.equal(calls, 1, "a bound prior resolution is reused without another F1");
  assert.equal((await loadFoundationSourceContext(ambiguous.id, db)).unresolved.length, 1, "bound resolution reinterprets the original source without replacing it");
  await preprocessProject(ambiguous.id, db);
  assert.ok(await db.scriptScene.count({ where: { episode: { projectId: ambiguous.id } } }), "resolved episodes receive deterministic batch scene parsing");
  await assert.rejects(() => prepareFoundationSource(ambiguous.id, db, { checkCurrent: async () => { throw new Error("stopped"); } }), /stopped/);

  const longText = Array.from({ length: 70 }, (_, index) => `第${index + 1}集\n${"正文".repeat(100)}\n`).join("") + "第1集\n短歧义\n";
  const long = await project(longText); let longCalls = 0;
  await prepareFoundationSource(long.id, db, { assist: async (request, validate) => {
    longCalls++; assert.ok(request.sourceLength > 12_000); assert.ok(request.sections.reduce((total, section) => total + section.text.length + (section.before?.length ?? 0) + (section.after?.length ?? 0), 0) <= 12_000);
    return { plan: validate({ assignments: [{ sectionKey: request.sections[0]!.key, kind: "EPISODE", episodeNumber: 1 }] }), runId: "short-range-f1" };
  } });
  assert.equal(longCalls, 1, "a long source with bounded ambiguity still makes one F1 call");

  const bad = await project("第1集\n甲\n第2集\n乙\n第1集\n丙\n");
  await assert.rejects(() => prepareFoundationSource(bad.id, db, { assist: async (_request, validate) => ({ plan: validate({ assignments: [{ sectionKey: "unknown", kind: "EPISODE", episodeNumber: 1 }] }), runId: "must-not-save" }) }), /unresolved/i);
  assert.equal(await db.sceneSnapshot.count({ where: { projectId: bad.id, sceneKey: "SOURCE_STRUCTURE_RESOLUTION" } }), 0, "an invalid plan fails before any source resolution is written");

  const manual = await project("第1集\n原正文\n");
  const episode = await db.episode.findFirstOrThrow({ where: { projectId: manual.id } });
  await db.episode.update({ where: { id: episode.id }, data: { content: "人工正文" } });
  await prepareFoundationSource(manual.id, db);
  assert.equal((await db.episode.findUniqueOrThrow({ where: { id: episode.id } })).content, "人工正文", "manual episode content is never overwritten");

  const readerIssue = await project("第1集\n正文\n");
  const readerImport = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: readerIssue.id, sceneKey: "SOURCE_IMPORT" } });
  const readerBody = JSON.parse(readerImport.content); readerBody.sourceStructure.issues = [{ code: "DOCX_REVISION_VIEW_UNRESOLVED", message: "修订视图待核对", sectionKeys: [] }];
  await db.sceneSnapshot.update({ where: { id: readerImport.id }, data: { content: JSON.stringify(readerBody) } });
  await prepareFoundationSource(readerIssue.id, db);
  assert.ok((await loadFoundationSourceContext(readerIssue.id, db)).issues.some((issue) => issue.code === "DOCX_REVISION_VIEW_UNRESOLVED"), "non-boundary reader issues survive reparsing and block complete source status");

  const legacy = await project("第1集\n1-1地点 夜 内\n人物：苏远\n");
  const legacyEpisode = await db.episode.findFirstOrThrow({ where: { projectId: legacy.id } });
  const legacyScene = await db.scriptScene.findFirstOrThrow({ where: { episodeId: legacyEpisode.id, sceneKey: "1-1" } });
  await db.scriptScene.update({ where: { id: legacyScene.id }, data: { location: "第1集", sourceText: legacyEpisode.content.replace(/\n/g, "\r\n"), metadata: JSON.stringify({ characters: ["苏远"], props: [] }) } });
  await preprocessProject(legacy.id, db);
  const repaired = await db.scriptScene.findUniqueOrThrow({ where: { episodeId_sceneKey: { episodeId: legacyEpisode.id, sceneKey: "1-1" } } });
  assert.equal(repaired.location, "地点", "proven old P0 rows receive fixed-parser scene columns and provenance");
  await db.scriptScene.update({ where: { id: repaired.id }, data: { location: "人工地点", metadata: JSON.stringify({ characters: ["苏远"], props: [], tag: "manual" }) } });
  await preprocessProject(legacy.id, db);
  assert.equal((await db.scriptScene.findUniqueOrThrow({ where: { id: repaired.id } })).location, "人工地点", "unhashed metadata with a manual key remains protected");
  const mixed = await project('第1集\n甲\n第2集\n乙\n第1集\n丙\n');
  const mixedImport = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: mixed.id, sceneKey: 'SOURCE_IMPORT' } });
  const mixedBody = JSON.parse(mixedImport.content); mixedBody.sourceStructure.issues.push({ code: 'DOCX_REVISION_VIEW_UNRESOLVED', message: '原文修订视图尚未确定', sectionKeys: [] });
  await db.sceneSnapshot.update({ where: { id: mixedImport.id }, data: { content: JSON.stringify(mixedBody) } });
  await prepareFoundationSource(mixed.id, db, { assist: async (request, validate) => ({ plan: validate({ assignments: request.sections.map((section, index) => ({ sectionKey: section.key, kind: 'EPISODE', episodeNumber: index === 0 ? 1 : 3 })) }), runId: 'mixed-issue' }) });
  assert.ok((await loadFoundationSourceContext(mixed.id, db)).issues.some(issue => issue.code === 'DOCX_REVISION_VIEW_UNRESOLVED'), 'F1 cannot clear read errors while resolving boundaries');
  const oldWrongResolution = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: mixed.id, sceneKey: 'SOURCE_STRUCTURE_RESOLUTION' }, orderBy: { createdAt: 'desc' } });
  const oldWrongBody = JSON.parse(oldWrongResolution.content); oldWrongBody.structure.issues = [];
  await db.sceneSnapshot.update({ where: { id: oldWrongResolution.id }, data: { content: JSON.stringify(oldWrongBody) } });
  await prepareFoundationSource(mixed.id, db);
  assert.ok((await loadFoundationSourceContext(mixed.id, db)).issues.some(issue => issue.code === 'DOCX_REVISION_VIEW_UNRESOLVED'), 'a legacy resolution cannot erase original reading errors');
  const duplicateScenes = await project('第1集\n1-1 客厅 夜 内\n甲：上半段。\n1-1 天台 日 外\n甲：下半段。\n');
  const dsEpisode = await db.episode.findFirstOrThrow({ where: { projectId: duplicateScenes.id } });
  await db.episode.update({ where: { id: dsEpisode.id }, data: { content: '第1集\n1-1 客厅 夜 内\n甲：上半段。\n' } });
  await preprocessProject(duplicateScenes.id, db);
  assert.equal(await db.scriptScene.count({ where: { episodeId: dsEpisode.id } }), 1, 'program-generated disambiguation metadata must not prevent retiring a removed scene');

  const retired = await project("第1集\n1-1 客厅 夜 内\n甲：回来。\n1-2 天台 日 外\n乙：走吧。\n");
  const retiredEpisode = await db.episode.findFirstOrThrow({ where: { projectId: retired.id } });
  await db.episode.update({ where: { id: retiredEpisode.id }, data: { content: "第1集\n1-1 客厅 夜 内\n甲：回来。\n" } });
  await preprocessProject(retired.id, db);
  assert.equal(await db.scriptScene.count({ where: { episodeId: retiredEpisode.id, sceneKey: "1-2" } }), 0, "expired pure P0 scene is retired rather than remaining as a false source coordinate");
  assert.equal(await db.sceneSnapshot.count({ where: { projectId: retired.id, episodeId: retiredEpisode.id, sceneKey: "RETIRED_P0_SCENE-1-2" } }), 1, "retired P0 scene keeps a historical snapshot");
  console.log("source preparation verification passed (temporary SQLite; no provider calls)");
} finally {
  await db.$disconnect(); rmSync(directory, { recursive: true, force: true });
}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
