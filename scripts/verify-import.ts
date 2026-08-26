import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEpisodeNumber, parseScriptFile, splitEpisodes } from "@/lib/import-script";
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
  assert.match(repeatedNumberEpisodes[1]?.title ?? "", /自动整理为第2集/);

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
  } finally {
    await prisma.project.deleteMany({ where: { title: verifierTitle } });
    await prisma.user.deleteMany({ where: { id: verifierUserId } });
    await prisma.$disconnect();
  }

  console.log("import parser verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

