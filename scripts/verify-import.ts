import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEpisodeNumber, parseScriptBuffer, parseScriptContent, parseScriptFile, splitEpisodes } from "@/lib/import-script";

async function main() {
  assert.equal(parseEpisodeNumber("1"), 1);
  assert.equal(parseEpisodeNumber("十"), 10);
  assert.equal(parseEpisodeNumber("二十三"), 23);
  assert.equal(parseEpisodeNumber("一百二十三"), 123);

  const episodes = splitEpisodes("第1集 开端\n第一场\n第十集 终局\n最后一场");
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0]?.number, 1);
  assert.equal(episodes[1]?.number, 10);
  assert.match(episodes[0]?.content ?? "", /第一场/);

  const fallback = splitEpisodes("没有集标题的剧本正文");
  assert.deepEqual(fallback, [], "无分集标题不得假造第1集");
  const noHeading = parseScriptContent("background-only.txt", "没有集标题的剧本正文");
  assert.deepEqual(noHeading.sourceStructure.sections, [{ key: "BACKGROUND-1", kind: "BACKGROUND", start: 0, end: "没有集标题的剧本正文".length }]);
  assert.deepEqual(noHeading.sourceStructure.issues.map((issue) => issue.code), ["NO_RECOGNIZED_EPISODE"]);

  const raw = "\uFEFF全剧说明\r\n  人物设定不得遗漏。\r\n\r\n第0集 序章\r\n  正文保留空格。  \r\n\r\n第2集 后续\r\n末行\r\n";
  const preserved = parseScriptContent("source.txt", raw);
  assert.equal(preserved.sourceText, raw, "完整提取原文必须单独保留");
  assert.deepEqual(preserved.episodes.map((episode) => episode.number), [0, 2]);
  assert.equal(preserved.sourceStructure.sections.map((section) => raw.slice(section.start, section.end)).join(""), raw, "分区重建不能丢掉卷首、标题、空白或原换行");
  assert.deepEqual(preserved.sourceStructure.sections.map((section) => section.kind), ["BACKGROUND", "EPISODE", "EPISODE"]);
  assert.equal(raw.slice(preserved.sourceStructure.sections[0]!.start, preserved.sourceStructure.sections[0]!.end), "\uFEFF全剧说明\r\n  人物设定不得遗漏。\r\n\r\n");
  assert.ok(preserved.episodes[0]!.content.startsWith("第0集 序章\r\n"), "前言只作背景，不混入首个 Episode");
  assert.equal(preserved.episodes[1]!.content, "第2集 后续\r\n末行\r\n");
  const whitespaceText = "  无分集标题\r第二行  \r";
  const whitespaceOnly = parseScriptContent("whitespace-only.txt", whitespaceText);
  assert.deepEqual(whitespaceOnly.episodes, []);
  assert.equal(whitespaceText.slice(whitespaceOnly.sourceStructure.sections[0]!.start, whitespaceOnly.sourceStructure.sections[0]!.end), whitespaceText);
  assert.deepEqual(splitEpisodes("第1集\r甲\r第2集\r乙").map((episode) => episode.number), [1, 2]);
  for (const space of ["\u00a0", "\u2009"]) {
    const unicodeSpaced = `第1集\n甲\n${space}第${space}2${space}集\n乙`;
    const parsed = splitEpisodes(unicodeSpaced);
    assert.deepEqual(parsed.map((episode) => episode.number), [1, 2]);
    assert.equal(parsed.map((episode) => episode.content).join(""), unicodeSpaced);
    assert.equal(splitEpisodes(`${space}第58集\n正文`)[0]!.number, 58);
  }
  const duplicate = parseScriptContent("duplicate.txt", "第1集\n甲\n第一集\n乙");
  assert.deepEqual(duplicate.episodes, [], "同号异文不自动择稿或整份拒绝");
  assert.deepEqual(duplicate.sourceStructure.sections.map((section) => [section.kind, section.episodeNumber, "第1集\n甲\n第一集\n乙".slice(section.start, section.end)]), [
    ["UNRESOLVED", 1, "第1集\n甲\n"], ["UNRESOLVED", 1, "第一集\n乙"]
  ]);
  assert.deepEqual(duplicate.sourceStructure.issues.map((issue) => issue.code), ["DUPLICATE_EPISODE_NUMBER"]);
  const doubleHeading = splitEpisodes("第1集 主标题\n\n第一集 副标题\n正文");
  assert.deepEqual(doubleHeading.map((episode) => [episode.number, episode.title, episode.content]), [[1, "第1集 主标题", "第1集 主标题\n\n第一集 副标题\n正文"]], "相邻双标题应合为同一逻辑分集");
  assert.equal((await parseScriptBuffer("source.md", Buffer.from(raw))).sourceText, raw);

  const dir = await mkdtemp(path.join(os.tmpdir(), "director-import-"));
  try {
    const mdPath = path.join(dir, "demo.md");
    await writeFile(mdPath, "第2集\n正文", "utf8");
    const imported = await parseScriptFile(mdPath);
    assert.equal(imported.sourceName, "demo.md");
    assert.equal(imported.episodes[0]?.number, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("import parser verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
