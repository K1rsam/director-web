import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { parseScriptBuffer, parseScriptContent, type ImportedScript } from "@/lib/import-script";
import { importProjectFromFile } from "@/lib/workflow";
import { loadFoundationSourceContext } from "@/lib/foundation-source";

function sectionText(imported: ImportedScript) {
  return imported.sourceStructure.sections.map((section) => imported.sourceText.slice(section.start, section.end)).join("");
}

async function makeDocx(documentXml: string) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", documentXml);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function verifyDocxReadKeepsBreakTabAndRuns() {
  const docx = await makeDocx(`<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>第</w:t></w:r><w:r><w:t>1</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>集</w:t></w:r></w:p>
      <w:p><w:r><w:t>苏</w:t></w:r><w:r><w:t>远</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>进门。</w:t></w:r></w:p>
      <w:p><w:r><w:t>第2集</w:t></w:r></w:p><w:p><w:r><w:t>继续。</w:t></w:r></w:p>
    </w:body></w:document>`);
  const imported = await parseScriptBuffer("split-runs.docx", docx);
  assert.equal(imported.sourceText, "第1\n集\n\n苏远\t进门。\n\n第2集\n\n继续。\n\n", "DOCX 的 br、tab 与相邻 run 的文字顺序必须在读取文本中保留");
  assert.deepEqual(imported.episodes.map((episode) => episode.number), [1, 2], "软换行的标题仍是第1集，分 run 的苏远不可被拆坏");
  assert.equal(sectionText(imported), imported.sourceText, "结构区间必须可完整重建 DOCX 读取文本");

  const revised = await parseScriptBuffer("revised.docx", await makeDocx(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第1集</w:t></w:r><w:ins><w:r><w:t>修订正文</w:t></w:r></w:ins><w:del><w:r><w:delText>删改正文</w:delText></w:r></w:del></w:p></w:body></w:document>`));
  assert.match(revised.readingView.view, /REVISIONS_UNRESOLVED/, "含修订 DOCX 须标明读取视图未决");
  assert.match(revised.sourceStructure.issues.map((issue) => issue.code).join(" "), /DOCX_REVISION_VIEW_UNRESOLVED/, "不得把 DOCX 修订静默当作已接受或已拒绝");
}

function verifyTextDecodingAndSourceStructure() {
  const utf8Bom = Buffer.from("\uFEFF第1集\nUTF8 正文", "utf8");
  const importedBom = parseScriptBuffer("bom.txt", utf8Bom);
  return importedBom.then((bom) => {
    assert.equal(bom.sourceText, "\uFEFF第1集\nUTF8 正文", "UTF-8 BOM 不得被读取层静默移除");
    assert.equal(bom.readingView.encoding, "utf-8", "UTF-8 BOM 文件须记录实际读取编码");

    const gb18030 = Buffer.from([0xB5, 0xDA, 0x31, 0xBC, 0xAF, 0x0A, 0xD5, 0xFD, 0xCE, 0xC4]); // 第1集\n正文
    return parseScriptBuffer("gb18030.txt", gb18030).then((gb) => {
      assert.equal(gb.sourceText, "第1集\n正文", "有据 GB18030 必须按 GB18030 读取");
      assert.equal(gb.readingView.encoding, "gb18030");
      return assert.rejects(() => parseScriptBuffer("broken.txt", Buffer.from([0xFF, 0xFE, 0xFD])), /无法.*UTF-8.*GB18030|无法.*读取/, "不合法文本不得虚构成一集");
    });
  });
}

function verifyClassificationAndBoundaries() {
  const adjacent = parseScriptContent("adjacent.txt", "人物小传\n\n第1集\n\n第一集\n\n1-1 客厅 日 内\n苏远：回来。\n第2集\n2-1 走廊 日 外\n赵清雅：等等。\n");
  assert.deepEqual(adjacent.episodes.map((episode) => episode.number), [1, 2], "紧邻的第1集/第一集标签仅隔空白时必须合为一个逻辑边界");
  assert.match(adjacent.episodes[0]!.content, /第1集\n\n第一集/, "两个原标签必须保留在原文切片中");
  assert.equal(adjacent.sourceStructure.sections[0]!.kind, "BACKGROUND", "未编号人物前言不得夹入首集");
  assert.equal(sectionText(adjacent), adjacent.sourceText, "背景、正剧区间拼接不得静默丢块");

  const duplicates = parseScriptContent("duplicates.txt", "第1集\n甲正文\n第2集\n明确正文\n第1集\n乙正文\n第51集\n补充稿\n");
  assert.deepEqual(duplicates.episodes.map((episode) => episode.number), [2, 51], "同号异文不得覆盖，也不得吞掉其它明确集或第51集补充");
  assert.equal(duplicates.sourceStructure.sections.filter((section) => section.kind === "UNRESOLVED").length, 2, "同号异文两段均须保留为未决区");
  assert.match(duplicates.sourceStructure.issues.map((issue) => issue.code).join(" "), /DUPLICATE_EPISODE_NUMBER/, "同号异文须要求人工择稿");
  assert.equal(sectionText(duplicates), duplicates.sourceText);

  const profileZero = parseScriptContent("profile.txt", "第0集 人物设定\n人物：苏远\n关系：赵清雅的弟弟\n第1集\n1-1 客厅 日 内\n苏远：开场。\n");
  assert.deepEqual(profileZero.episodes.map((episode) => episode.number), [1], "第0集明确资料头且无剧情结构应归背景");
  const dramaticZero = parseScriptContent("prologue.txt", "第0集 序章\n0-1 雨夜 外\n苏远冲进雨里。\n第1集\n1-1 客厅 内\n赵清雅：回来了。\n");
  assert.deepEqual(dramaticZero.episodes.map((episode) => episode.number), [0, 1], "有戏的第0集序章仍为正剧");
  for (const cue of ["△苏远静立窗边。", "场0-1 客厅 日 内\n苏远静立。"]) {
    const source = `第0集 人物设定\n${cue}\n第1集\n正文\n`;
    const zeroWithScene = parseScriptContent("profile-with-scene.txt", source);
    assert.deepEqual(zeroWithScene.episodes.map(episode => episode.number), [0, 1], "明确舞台或场号结构优先于资料标题，不得回落为背景");
    assert.equal(zeroWithScene.episodes[0].content, source.slice(0, source.indexOf("第1集")));
  }
  const none = parseScriptContent("notes.txt", "人物设定\n苏远：男，二十六岁。\n");
  assert.deepEqual(none.episodes, [], "无可识别集时不得擅自造出第1集");
  assert.equal(none.sourceStructure.sections[0]!.kind, "BACKGROUND");
  assert.match(none.sourceStructure.issues.map((issue) => issue.code).join(" "), /NO_RECOGNIZED_EPISODE/);

  const supplement = parseScriptContent("supplement.txt", "第50集\n五十正文\n增补 第51集\n51-1 雨夜 外\n新增 第52集\n52-1 天台 外\n第53集\n五十三正文\n");
  assert.deepEqual(supplement.episodes.map((episode) => episode.number), [50, 51, 52, 53], "独立导入文件内有明确集号的增补段应直接读取，不覆盖其它稿件");
  assert.equal(supplement.episodes.find(episode => episode.number === 51)!.content, "增补 第51集\n51-1 雨夜 外\n");
  assert.equal(supplement.sourceStructure.issues.length, 0);
  assert.match(supplement.readingView.warnings.join(" "), /增补|新增/);
  const supplementPair = parseScriptContent("supplement-pair.txt", "新增 第51集\n第51集\n51-1 门口 日 外\n正文\n");
  assert.deepEqual(supplementPair.episodes.map(episode => episode.number), [51], "紧邻空白的增补/普通双标题仍是一个逻辑边界");
  const mixedNumber = parseScriptContent("mixed-number.txt", "第六集\n6-1 日 内\n前文\n第七7集\n场7-1 日 内\n正文\n第八集\n后文\n");
  assert.ok(mixedNumber.episodes.find(episode => episode.number === 7)!.content.startsWith("第七7集"), "相同中阿数字并写的标题必须留在本集，不挂到前集末尾");

  const sceneCandidate = parseScriptContent("scene-candidate.txt", "第11集\n正文\n场12-1 门口\n第12段内容\n第13集\n后文\n");
  assert.deepEqual(sceneCandidate.episodes.map((episode) => episode.number), [11, 12, 13], "相邻集号明确支持的场12-1应形成有标记的读取视图，不吞11也不无故停工");
  assert.equal(sceneCandidate.episodes[1].content, "场12-1 门口\n第12段内容\n");
  assert.match(sceneCandidate.episodes[1].title, /按原场号定位/);
  assert.equal(sceneCandidate.sourceStructure.issues.length, 0);
  assert.equal(sceneCandidate.sourceStructure.sections.map(section => sceneCandidate.sourceText.slice(section.start, section.end)).join(""), sceneCandidate.sourceText);
  const ambiguousScene = parseScriptContent("ambiguous-scene.txt", "第11集\n正文\n场9-1 门口\n未明归属\n第13集\n后文\n");
  assert.ok(ambiguousScene.sourceStructure.sections.some(section => section.kind === "UNRESOLVED" && section.episodeNumber === 9), "不匹配相邻集号的场段仍须保留为未决，不能静默择稿");
  const ambiguousChain = parseScriptContent("ambiguous-chain.txt", "第11集\n正文\n场9-1 门口\n甲\n场10-1 屋内\n乙\n第13集\n后文\n");
  assert.deepEqual(ambiguousChain.episodes.map(episode => episode.number), [11, 13], "未决场号不能成为后续确定集号的推断依据");

  const actionZero = parseScriptContent("action-zero.txt", "第0集 世界观序章\n黎明前，苏远翻过围墙，冲进雨里。\n第1集\n1-1 客厅 内\n赵清雅：回来了。\n");
  assert.deepEqual(actionZero.episodes.map((episode) => episode.number), [0, 1], "第0集正文提到世界观但有明确行动时不得静默归背景");
  const outlineZero = parseScriptContent("outline-zero.txt", "第0集\n故事大纲：\n主角五年后回到家乡，推开旧宅的大门。\n分集概括：\n1.主角下山。\n第1集\n1-1 山门 外 日\n主角出发。\n");
  assert.deepEqual(outlineZero.episodes.map(episode => episode.number), [1], "明确大纲标题下的动作是梗概，不应因包含动作词就制造正剧0集");
  assert.ok(outlineZero.sourceStructure.sections.some(section => section.kind === "BACKGROUND" && section.episodeNumber === 0));
  assert.ok(parseScriptContent("story-title.txt", "第0集 不只是故事大纲\n苏远忽然消失。\n第1集\n正文\n").episodes.some(episode => episode.number === 0), "标题仅提到大纲不等于声明该段是背景资料");
}

async function verifyImportPersistence() {
  const directory = mkdtempSync(join(tmpdir(), "director-import-source-"));
  const url = `file:${join(directory, "import-source.db")}`;
  const schemaPath = join(directory, "schema.prisma");
  cpSync(join(process.cwd(), "prisma/schema.prisma"), schemaPath);
  const db = new PrismaClient({ datasourceUrl: url });
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "db", "push", "--skip-generate", "--schema", schemaPath], { cwd: directory, env: { ...process.env, DATABASE_URL: url, RUST_LOG: "info" }, stdio: "pipe" });
  try {
    const owner = await db.user.create({ data: { username: "import-source", email: "import-source@example.invalid", passwordHash: "offline" } });
    const source = Buffer.from("第1集\n1-1 客厅 内\n苏远：在。\n");
    const { project } = await importProjectFromFile({ ownerUserId: owner.id, title: "__import_source__", sourceName: "original.txt", buffer: source }, db);
    const imported = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: project.id, sceneKey: "SOURCE_IMPORT" } });
    const body = JSON.parse(imported.content);
    const metadata = JSON.parse(imported.metadata ?? "{}");
    assert.equal(body.sourceText, source.toString("utf8"), "SOURCE_IMPORT 存读取文本");
    assert.equal(body.originalFile.base64, source.toString("base64"), "SOURCE_IMPORT 保留仅供恢复的原始上传快照");
    assert.equal(body.sourceStructure.version, "SOURCE_STRUCTURE_V1");
    assert.equal(metadata.schema, "IMPORTED_SOURCE_TEXT_V2");
    assert.equal(sectionText(body), body.sourceText, "落库结构范围可重建原读取文本");

    const ambiguous = await importProjectFromFile({ ownerUserId: owner.id, title: "__import_ambiguous__", sourceName: "ambiguous.txt", buffer: Buffer.from("人物设定\n苏远：二十六岁。\n第1集\n甲稿\n第2集\n明确稿\n第1集\n乙稿\n") }, db);
    const context = await loadFoundationSourceContext(ambiguous.project.id, db);
    assert.equal(context.background[0]?.text, "人物设定\n苏远：二十六岁。\n", "来源上下文须投影未编号背景原文");
    assert.deepEqual(context.unresolved.map((section) => section.text), ["第1集\n甲稿\n", "第1集\n乙稿\n"], "来源上下文须投影同号未决原文，不只给 sectionKey");
    assert.equal(context.complete, false, "有未决区时不得声称来源上下文完整");

    const notes = await importProjectFromFile({ ownerUserId: owner.id, title: "__import_notes__", sourceName: "notes.txt", buffer: Buffer.from("人物设定\n苏远：二十六岁。\n") }, db);
    assert.equal(await db.episode.count({ where: { projectId: notes.project.id } }), 0, "无可识别集时项目仍保存，但不得伪造 Episode");
    const readable = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: notes.project.id, sceneKey: "FOUNDATION_SOURCE" } });
    assert.equal(JSON.parse(readable.content).schema, "FOUNDATION_SOURCE_IMPORT_ONLY_V1", "无集导入的 P0 应保存可读说明而不是抛错");

    const legacy = await db.project.create({ data: { title: "__legacy_source__" } });
    await db.sceneSnapshot.create({ data: { projectId: legacy.id, sceneKey: "SOURCE_IMPORT", content: JSON.stringify({ sourceName: "legacy.txt", sourceText: "旧原文" }), metadata: JSON.stringify({ schema: "IMPORTED_SOURCE_TEXT_V1" }) } });
    const legacyContext = await loadFoundationSourceContext(legacy.id, db);
    assert.deepEqual(legacyContext.background, [], "旧导入不应被自动重释为新背景");
    assert.match(legacyContext.notices.map((notice) => notice.code).join(" "), /LEGACY_SOURCE_IMPORT_BOUNDARY/, "旧导入须明确历史边界，但不能伪装成当前结构问题");
    assert.equal(legacyContext.issues.length, 0, "旧导入边界说明不是当前正剧的阻断性缺口");

    const olderStructured = parseScriptContent("old-v2.txt", "旧前言\n第1集\n旧正文\n");
    const sourceOrder = await db.project.create({ data: { title: "__latest_source_only__" } });
    await db.sceneSnapshot.create({ data: { projectId: sourceOrder.id, sceneKey: "SOURCE_IMPORT", content: JSON.stringify({ sourceName: "old-v2.txt", sourceText: olderStructured.sourceText, sourceStructure: olderStructured.sourceStructure, readingView: olderStructured.readingView }), metadata: JSON.stringify({ schema: "IMPORTED_SOURCE_TEXT_V2" }), createdAt: new Date(0) } });
    await db.sceneSnapshot.create({ data: { projectId: sourceOrder.id, sceneKey: "SOURCE_IMPORT", content: JSON.stringify({ sourceName: "legacy-current.txt", sourceText: "最新旧记录" }), metadata: JSON.stringify({ schema: "IMPORTED_SOURCE_TEXT_V1" }), createdAt: new Date(1_000) } });
    const latestOnly = await loadFoundationSourceContext(sourceOrder.id, db);
    assert.deepEqual(latestOnly.background, [], "最新旧记录不得回退采用更早的 V2 背景");
    assert.equal(latestOnly.coverage, "UNKNOWN", "最新不支持记录须如实标为当前来源未知");
    await db.sceneSnapshot.create({ data: { projectId: sourceOrder.id, sceneKey: "SOURCE_IMPORT", content: "损坏的当前内容", metadata: "{", createdAt: new Date(2_000) } });
    const malformedLatest = await loadFoundationSourceContext(sourceOrder.id, db);
    assert.equal(malformedLatest.coverage, "UNKNOWN", "最新损坏元数据也不得回退使用旧 V2");
    assert.notEqual(malformedLatest.version, latestOnly.version, "来源指纹必须绑定真正最新的导入记录");
    assert.match(malformedLatest.notices.map((notice) => notice.code).join(" "), /CURRENT_SOURCE_IMPORT_METADATA_UNREADABLE/);

    const styleWarningDocx = await makeDocx(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="CustomScene"/></w:pPr><w:r><w:t>第1集</w:t></w:r></w:p><w:p><w:r><w:t>正文完整。</w:t></w:r></w:p></w:body></w:document>`);
    const styleWarning = await importProjectFromFile({ ownerUserId: owner.id, title: "__style_warning__", sourceName: "style-warning.docx", buffer: styleWarningDocx }, db);
    const styleContext = await loadFoundationSourceContext(styleWarning.project.id, db);
    assert.equal(styleContext.complete, true, "普通 DOCX 未定义样式告警不应把完整来源标成未完成");
    assert.equal(styleContext.issues.length, 0, "样式告警应留在读取提示，不是阻断性来源问题");
    assert.match(styleContext.notices.map((notice) => notice.code).join(" "), /DOCX_READER_WARNING/, "样式读取告警须保留为信息提示");
  } finally {
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  await verifyDocxReadKeepsBreakTabAndRuns();
  await verifyTextDecodingAndSourceStructure();
  verifyClassificationAndBoundaries();
  await verifyImportPersistence();
  console.log("import source preservation verification passed (isolated SQLite; no model calls)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
