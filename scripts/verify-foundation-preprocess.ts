import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadFoundationSourceContext } from "@/lib/foundation-source";
import { preprocessProject } from "@/lib/project-preprocess";
import { importProjectFromFile } from "@/lib/workflow";

const EPISODES = [
  {
    number: 1,
    title: "第一集",
    content: "\r\n第一集\r\n1-1\r\n客厅 日 内\r\n场景：客厅\r\n人物：苏远、赵清雅\r\n道具：手机\r\n苏远：你看。  \r\n\r\n1-2\r\n教室 夜 内\r\n场景：教室\r\n苏远的母亲站在门口。\r\n"
  },
  { number: 2, title: "第二集", content: "场景 教室\n  苏远（受伤状态）抬头。\n\n" }
];

async function createProject(db: PrismaClient, title: string) {
  return db.project.create({
    data: { title, style: "3D漫剧", episodes: { create: EPISODES } },
    include: { episodes: { orderBy: { number: "asc" } } }
  });
}

async function verifyMechanicalOnly(db: PrismaClient) {
  const project = await createProject(db, "__p0_mechanical_only__");
  await preprocessProject(project.id, db);

  assert.equal(await db.asset.count({ where: { projectId: project.id } }), 0, "P0 不得从正文创建语义资产或风格资产");
  assert.deepEqual(
    await db.sceneSnapshot.findMany({ where: { projectId: project.id }, select: { sceneKey: true } }),
    [{ sceneKey: "FOUNDATION_SOURCE" }],
    "P0 只写 SOURCE，不生成项目记忆、关系或单集 AI 上下文"
  );
  assert.deepEqual(
    await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } }),
    project.episodes,
    "P0 不得改写 Episode.content 或其更新时间"
  );
  assert.deepEqual(
    await db.scriptScene.findMany({
      where: { episode: { projectId: project.id } },
      orderBy: [{ episode: { number: "asc" } }, { sortOrder: "asc" }],
      select: { sceneKey: true, location: true }
    }),
    [{ sceneKey: "1-1", location: "客厅" }, { sceneKey: "1-2", location: "教室" }, { sceneKey: "2-1", location: "教室" }],
    "原有编号场头和无编号场头仍机械建场"
  );
}

async function verifyRawSourceSnapshot(db: PrismaClient) {
  const project = await createProject(db, "__p0_raw_source__");
  await preprocessProject(project.id, db);
  const snapshot = await db.sceneSnapshot.findFirst({ where: { projectId: project.id, sceneKey: "FOUNDATION_SOURCE" }, orderBy: { createdAt: "desc" } });
  assert.ok(snapshot, "P0 应写入 FOUNDATION_SOURCE 快照");
  const content = JSON.parse(snapshot.content);
  const metadata = JSON.parse(snapshot.metadata ?? "{}");
  assert.equal(content.schema, "FOUNDATION_SOURCE_V1");
  assert.deepEqual(metadata, { schema: "FOUNDATION_SOURCE_V1", sourceVersion: content.sourceVersion });
  assert.match(content.sourceVersion, /^[a-f0-9]{64}$/);
  assert.equal(content.sourceIndex.schema, "RAW_SOURCE_INDEX_V1");
  assert.equal(content.sourceIndex.version, content.sourceVersion);
  assert.deepEqual(
    content.sourceIndex.episodes,
    EPISODES.map((episode) => ({ ...episode, lineCount: episode.content.split(/\r\n|\r|\n/).length })),
    "SOURCE 逐字保留数据库内分集原文、CRLF、首尾空行和行尾空格"
  );
  assert.deepEqual(
    content.sourceRefs,
    EPISODES.map((episode) => ({ episode: episode.number, startLine: 1, endLine: episode.content.split(/\r\n|\r|\n/).length })),
    "导航使用集号和原始行起止，不使用清洗后的 N 节点"
  );
  assert.equal(content.sourceIndex.episodes[0].content.split(/\r\n|\r|\n/)[7], "苏远：你看。  ");

  await preprocessProject(project.id, db);
  const rerun = await db.sceneSnapshot.findMany({ where: { projectId: project.id, sceneKey: "FOUNDATION_SOURCE" } });
  assert.equal(rerun.length, 1, "重跑只更新同一 SOURCE 快照");
  assert.equal(rerun[0].id, snapshot.id, "同版重跑应保持 SOURCE 快照身份");
  assert.equal(rerun[0].content, snapshot.content, "同版快照与版本应完全稳定");
}

async function verifyPreservesPublishedAssets(db: PrismaClient) {
  const project = await createProject(db, "__p0_preserve_published__");
  await preprocessProject(project.id, db);
  const parent = await db.asset.create({
    data: {
      projectId: project.id, code: "CH-900-1", type: "CH", name: "人工确认苏远", status: "confirmed",
      sourceText: "用户确认来源", notes: "不可覆盖的人工说明", firstSeenNode: "EP1:L8-L8",
      metadata: '{ "identity": "reviewed", "custom": [1, 2] }'
    }
  });
  await db.asset.create({
    data: {
      projectId: project.id, code: "CH-900-2", type: "CH", name: "人工确认苏远｜受伤", status: "confirmed",
      parentId: parent.id, metadata: '{"state":"受伤","approvedBy":"user"}'
    }
  });
  await db.asset.create({
    data: {
      projectId: project.id, code: "PROP-901", type: "PROP", name: "人工道具候选", status: "needs_confirmation",
      metadata: '{"candidate":"F2","mustPreserve":true}'
    }
  });
  const assetsBefore = await db.asset.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } });
  await preprocessProject(project.id, db);
  assert.deepEqual(
    await db.asset.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } }),
    assetsBefore,
    "重预处理不得增删或修改任何既有资产的 ID、状态、父子关系、metadata、时间戳"
  );
}

async function verifyPreservesAiMemory(db: PrismaClient) {
  const project = await createProject(db, "__p0_preserve_ai_memory__");
  for (const sceneKey of ["PROJECT_MEMORY", "EP-1-CONTEXT", "FOUNDATION_F1_CANDIDATE", "FOUNDATION_F2_CANDIDATE"]) {
    await db.sceneSnapshot.create({
      data: {
        projectId: project.id, episodeId: sceneKey === "EP-1-CONTEXT" ? project.episodes[0].id : null,
        sceneKey, content: `已审内容：${sceneKey}`, metadata: '{ "owner": "AI-or-user", "approved": true }'
      }
    });
  }
  const memoryBefore = await db.sceneSnapshot.findMany({
    where: { projectId: project.id, NOT: { sceneKey: "FOUNDATION_SOURCE" } }, orderBy: { id: "asc" }
  });
  await preprocessProject(project.id, db);
  assert.deepEqual(
    await db.sceneSnapshot.findMany({ where: { projectId: project.id, NOT: { sceneKey: "FOUNDATION_SOURCE" } }, orderBy: { id: "asc" } }),
    memoryBefore,
    "P0 不覆盖 PROJECT_MEMORY、EP-n-CONTEXT 和 F1/F2 候选"
  );
}

async function verifyPreservesSceneAssociations(db: PrismaClient) {
  const project = await createProject(db, "__p0_preserve_scene_links__");
  await preprocessProject(project.id, db);
  const scene = await db.scriptScene.findUniqueOrThrow({ where: { episodeId_sceneKey: { episodeId: project.episodes[0].id, sceneKey: "1-1" } } });
  const metadata = { ...JSON.parse(scene.metadata), characters: ["已确认角色展示名"], assetRefs: ["CH-900-1", "PROP-901"], publication: { owner: "F2", version: "approved-source" } };
  const rawMetadata = JSON.stringify(metadata, null, 2);
  await db.scriptScene.update({ where: { id: scene.id }, data: { metadata: rawMetadata, revision: "V8" } });

  await preprocessProject(project.id, db);
  const rerun = await db.scriptScene.findUniqueOrThrow({ where: { id: scene.id } });
  assert.equal(rerun.metadata, rawMetadata, "同版场次 metadata 保留原字符串，不重排或重写已确认字段");
  assert.deepEqual(JSON.parse(rerun.metadata), metadata, "同版重预处理不得清掉 assetRefs 或已发布自定义元数据");
  assert.equal(rerun.revision, "V8", "机械重预处理不伪造或重置已审版本");
}

async function verifySourceChangesAndProtectedScenes(db: PrismaClient) {
  const project = await createProject(db, "__p0_source_change__");
  await preprocessProject(project.id, db);
  const episodeId = project.episodes[0].id;
  const snapshot = await db.sceneSnapshot.findFirst({ where: { projectId: project.id, sceneKey: "FOUNDATION_SOURCE" }, orderBy: { createdAt: "desc" } });
  assert.ok(snapshot, "源版本变更测试需要 P0 SOURCE 快照");
  const sourceVersion = JSON.parse(snapshot.content).sourceVersion;
  const scene1 = await db.scriptScene.findUniqueOrThrow({ where: { episodeId_sceneKey: { episodeId, sceneKey: "1-1" } } });
  const scene2 = await db.scriptScene.findUniqueOrThrow({ where: { episodeId_sceneKey: { episodeId, sceneKey: "1-2" } } });
  await db.scriptScene.update({ where: { id: scene1.id }, data: { metadata: JSON.stringify({ ...JSON.parse(scene1.metadata), assetRefs: ["CH-900-1"] }) } });
  await db.storyboardShot.create({ data: { episodeId, sceneId: scene2.id, shotKey: "retained-shot", sortOrder: 1, duration: 3 } });
  const unitScene = await db.scriptScene.create({ data: { episodeId, sceneKey: "legacy-unit", sortOrder: 8, sourceText: "旧场次" } });
  await db.seedanceUnit.create({ data: { episodeId, sceneId: unitScene.id, unitKey: "retained-unit", sortOrder: 1, duration: 3, startPremise: "起", endState: "止" } });
  const emptyScene = await db.scriptScene.create({ data: { episodeId, sceneKey: "legacy-empty", sortOrder: 9, sourceText: "过时空场" } });

  const updatedText = "\n1-1\n走廊 日 外\n场景：走廊\n人物：赵清雅\n赵清雅：换了一行。\n\n1-3\n新场 夜 内\n新内容。\n";
  await db.episode.update({ where: { id: episodeId }, data: { content: updatedText } });
  await preprocessProject(project.id, db);
  const updatedSnapshot = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: project.id, sceneKey: "FOUNDATION_SOURCE" }, orderBy: { createdAt: "desc" } });
  const updatedSource = JSON.parse(updatedSnapshot.content);
  assert.notEqual(updatedSource.sourceVersion, sourceVersion, "原文变化必须产生新 sourceVersion");
  assert.notEqual(updatedSnapshot.id, snapshot.id, "新原文版本必须新增 SOURCE 身份，不覆盖旧 sourceId");
  assert.deepEqual(await db.sceneSnapshot.findUnique({ where: { id: snapshot.id } }), snapshot, "旧版原文内容、版本和 ID 必须保持不变，供历史审查引用");
  assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: "FOUNDATION_SOURCE" } }), 2);
  assert.equal(updatedSource.sourceIndex.episodes[0].content, updatedText);
  const changedScene = await db.scriptScene.findUniqueOrThrow({ where: { id: scene1.id } });
  assert.equal(changedScene.location, "走廊", "源变化后仍刷新机械场次字段");
  assert.deepEqual(JSON.parse(changedScene.metadata).characters, ["赵清雅"]);
  assert.deepEqual(JSON.parse(changedScene.metadata).assetRefs, ["CH-900-1"], "P0 不清理已发布关联，源版本失效由基础工程门禁裁定");
  assert.ok(await db.scriptScene.findUnique({ where: { id: scene2.id } }), "不得删除已有镜头关联的旧场次");
  assert.ok(await db.scriptScene.findUnique({ where: { id: unitScene.id } }), "不得删除已有单元关联的旧场次");
  assert.equal(await db.scriptScene.findUnique({ where: { id: emptyScene.id } }), null, "过时且无镜头、单元关联的机械场次仍可清理");
  assert.ok(await db.scriptScene.findUnique({ where: { episodeId_sceneKey: { episodeId, sceneKey: "1-3" } } }));

  await preprocessProject(project.id, db);
  assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: "FOUNDATION_SOURCE" } }), 2, "新版本同版重跑也不新增重复 SOURCE");

  await db.episode.update({ where: { id: episodeId }, data: { content: updatedText.replace(/\n/g, "\r\n") } });
  await preprocessProject(project.id, db);
  const newlineChanged = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: project.id, sceneKey: "FOUNDATION_SOURCE" }, orderBy: { createdAt: "desc" } });
  assert.notEqual(JSON.parse(newlineChanged.content).sourceVersion, updatedSource.sourceVersion, "仅原始换行变化也应改变源版本，不按清洗正文签名");
  assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: "FOUNDATION_SOURCE" } }), 3);
  assert.deepEqual(await db.sceneSnapshot.findUnique({ where: { id: updatedSnapshot.id } }), updatedSnapshot, "再次变更源版本仍保留上一版完整原文");
}

async function verifyFileImportPreservesRawText(db: PrismaClient) {
  const owner = await db.user.create({
    data: { username: "p0-import-verification", email: "p0-import@example.invalid", passwordHash: "isolated-test-only" }
  });
  const raw = "\uFEFF卷首：人物说明不可删除。  \r\n\r\n第0集 序章\r\n0-1\r\n场景：旧屋\r\n人物：苏远\r\n苏远：开始。\r\n\r\n第2集 正篇\r\n2-1\r\n场景：走廊\r\n苏远抬头。  \r\n\r\n";
  for (const extension of ["md", "txt"]) {
    const sourceName = `preserved-source.${extension}`;
    const { project } = await importProjectFromFile({
      ownerUserId: owner.id, title: `__p0_import_${extension}__`, sourceName, buffer: Buffer.from(raw, "utf8")
    }, db);
    const episodes = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } });
    assert.deepEqual(episodes.map((episode) => episode.number), [0, 2], "保留原第0集与跳号，不虚构新集");
    const preface = "\uFEFF卷首：人物说明不可删除。  \r\n\r\n";
    assert.equal(episodes.map((episode) => episode.content).join(""), raw.slice(preface.length), `${extension} 的 Episode 保留其原始标题、CRLF、空行和行尾空格`);
    assert.ok(episodes[0]!.content.startsWith("第0集 序章"), "前言必须独立为背景，不伪装成第0集正文");
    const importedSource = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: project.id, sceneKey: "SOURCE_IMPORT" } });
    const imported = JSON.parse(importedSource.content);
    const importMetadata = JSON.parse(importedSource.metadata ?? "{}");
    assert.equal(imported.sourceName, sourceName);
    assert.equal(imported.sourceText, raw, "SOURCE_IMPORT 必须逐字保存读取原文");
    assert.equal(imported.sourceStructure.sections.map((section: { start: number; end: number }) => raw.slice(section.start, section.end)).join(""), raw, "V2 来源分区必须可精确复原原文");
    assert.deepEqual(imported.sourceStructure.sections.map((section: { kind: string }) => section.kind), ["BACKGROUND", "EPISODE", "EPISODE"]);
    assert.equal(imported.originalFile.base64, Buffer.from(raw, "utf8").toString("base64"), "V2 必须保留原文件恢复字段");
    assert.equal(imported.originalFile.encoding, "base64");
    assert.equal(importMetadata.schema, "IMPORTED_SOURCE_TEXT_V2");
    assert.equal(importMetadata.originalFileStoredForRecovery, true);
    const sourceContext = await loadFoundationSourceContext(project.id, db);
    assert.deepEqual(sourceContext.background, [{ key: "BACKGROUND-1", text: preface }], "P0 只从 V2 SOURCE_IMPORT 读取独立背景，不挤入 Episode");
    const foundationSource = await db.sceneSnapshot.findFirstOrThrow({
      where: { projectId: project.id, sceneKey: "FOUNDATION_SOURCE" }, orderBy: { createdAt: "desc" }
    });
    const index = JSON.parse(foundationSource.content).sourceIndex;
    assert.deepEqual(index.episodes, episodes.map(({ number, title, content }) => ({
      number, title, content, lineCount: content.split(/\r\n|\r|\n/).length
    })), "P0 SOURCE 原值与导入后 Episode.content 一致");
    assert.equal(index.episodes.map((episode: { content: string }) => episode.content).join(""), raw.slice(preface.length));
    assert.equal(await db.asset.count({ where: { projectId: project.id } }), 0, "上传到 P0 的完整路径不得粗建资产");
  }
}

async function main() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "director-foundation-preprocess-"));
  const datasourceUrl = `file:${join(temporaryDirectory, "preprocess.db")}`;
  const schemaPath = join(temporaryDirectory, "schema.prisma");
  cpSync(join(process.cwd(), "prisma/schema.prisma"), schemaPath);
  const db = new PrismaClient({ datasourceUrl });
  try {
    // 专属临时目录与显式数据源，Prisma 不读取工作区 .env 或现有数据库。
    execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "db", "push", "--skip-generate", "--schema", schemaPath], {
      cwd: temporaryDirectory, env: { ...process.env, DATABASE_URL: datasourceUrl, RUST_LOG: "info" }, stdio: "pipe"
    });
    const cases = [verifyMechanicalOnly, verifyRawSourceSnapshot, verifyPreservesPublishedAssets, verifyPreservesAiMemory, verifyPreservesSceneAssociations, verifySourceChangesAndProtectedScenes, verifyFileImportPreservesRawText];
    let failures = 0;
    for (const test of cases) {
      try {
        await test(db);
        console.log(`PASS ${test.name}`);
      } catch (error) {
        failures += 1;
        console.error(`FAIL ${test.name}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
      }
    }
    assert.equal(failures, 0, `${failures} foundation preprocess verification(s) failed`);
    console.log("foundation preprocess verification passed (isolated SQLite; no model calls)");
  } finally {
    await db.$disconnect();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
