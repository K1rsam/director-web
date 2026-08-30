import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanEpisodeTitle, parseEpisodeNumber, parseScriptFile, splitEpisodes } from "@/lib/import-script";
import { importProjectFromText } from "@/lib/workflow";
import { prisma } from "@/lib/prisma";

async function main() {
  assert.equal(parseEpisodeNumber("1"), 1);
  assert.equal(parseEpisodeNumber("十"), 10);
  assert.equal(parseEpisodeNumber("二十三"), 23);

  const episodes = splitEpisodes("第1集 开端\n第一场\n第十集 终局\n最后一场");
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0]?.number, 1);
  assert.equal(episodes[1]?.number, 10);
  assert.match(episodes[0]?.content ?? "", /第一场/);

  const repeatedNumberEpisodes = splitEpisodes("第1集 片段A\n正文A\n第1集 片段B\n正文B");
  assert.deepEqual(repeatedNumberEpisodes.map((episode) => episode.number), [1, 2]);
  assert.match(repeatedNumberEpisodes[1]?.title ?? "", /原集号与前文重复，已自动整理为第2集/);

  const zeroNumberEpisodes = splitEpisodes("第0集 前置资料\n人物小传：常见青自幼……\n第1集 正式开篇\n正文A\n第2集 后续\n正文B");
  assert.deepEqual(zeroNumberEpisodes.map((episode) => episode.number), [0, 1, 2]);
  assert.match(zeroNumberEpisodes[0]?.content ?? "", /人物小传/);
  assert.equal(cleanEpisodeTitle("第0集 页眉", 0), "第0集");
  assert.equal(cleanEpisodeTitle(zeroNumberEpisodes[1]?.title, 1), "第1集 正式开篇");
  assert.equal(cleanEpisodeTitle(zeroNumberEpisodes[2]?.title, 2), "第2集 后续");

  const repeatedPreludeEpisodes = splitEpisodes("第0集 前置资料A\n人物小传A\n第0集 前置资料B\n剧情简述B\n第1集 正式开篇\n正文");
  assert.deepEqual(repeatedPreludeEpisodes.map((episode) => episode.number), [0, 1]);
  assert.match(repeatedPreludeEpisodes[0]?.content ?? "", /人物小传A/);
  assert.match(repeatedPreludeEpisodes[0]?.content ?? "", /剧情简述B/);
  assert.equal(repeatedPreludeEpisodes[1]?.number, 1);

  const unheadedPreludeEpisodes = splitEpisodes("剧本类型：都市现代\n人物小传：常见青……\n剧情简述：……\n第1集 正式开篇\n正文");
  assert.deepEqual(unheadedPreludeEpisodes.map((episode) => episode.number), [0, 1]);
  assert.equal(unheadedPreludeEpisodes[0]?.title, "前置资料（第0集）");
  assert.match(unheadedPreludeEpisodes[0]?.content ?? "", /剧情简述/);
  assert.match(unheadedPreludeEpisodes[1]?.content ?? "", /正文/);
  assert.equal(cleanEpisodeTitle("第 1 集", 3), "第3集");

  const fallback = splitEpisodes("没有集标题的剧本正文");
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0]?.number, 1);

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

  const verifierUserId = randomUUID();
  const verifierTitle = `import-verifier-${verifierUserId}`;
  const preludeVerifierTitle = `import-prelude-verifier-${verifierUserId}`;
  try {
    await prisma.user.create({
      data: {
        id: verifierUserId,
        email: `${verifierUserId}@import-test.local`,
        username: `import_${verifierUserId.replaceAll("-", "").slice(0, 20)}`,
        passwordHash: "test-only",
        name: "import verifier"
      }
    });
    const created = await importProjectFromText({
      ownerUserId: verifierUserId,
      title: verifierTitle,
      sourceName: "duplicate-episodes.txt",
      sourceText: "第1集 片段A\n正文A\n第1集 片段B\n正文B",
      executionMode: "CLI"
    });
    assert.deepEqual(created.episodes.map((episode) => episode.number), [1, 2]);
    const createdWithPrelude = await importProjectFromText({
      ownerUserId: verifierUserId,
      title: preludeVerifierTitle,
      sourceName: "prelude-episodes.txt",
      sourceText: "第0集 前置资料\n人物小传\n第1集 正式开篇\n正文A\n第2集 后续\n正文B",
      executionMode: "CLI"
    });
    assert.deepEqual(createdWithPrelude.episodes.map((episode) => episode.number), [0, 1, 2]);
  } finally {
    await prisma.project.deleteMany({ where: { title: { in: [verifierTitle, preludeVerifierTitle] } } });
    await prisma.user.deleteMany({ where: { id: verifierUserId } });
    await prisma.$disconnect();
  }

  console.log("import parser verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
