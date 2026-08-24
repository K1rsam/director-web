import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEpisodeNumber, parseScriptFile, splitEpisodes } from "@/lib/import-script";

async function main() {
  assert.equal(parseEpisodeNumber("1"), 1);
  assert.equal(parseEpisodeNumber("十"), 10);
  assert.equal(parseEpisodeNumber("二十三"), 23);

  const episodes = splitEpisodes("第1集 开端\n第一场\n第十集 终局\n最后一场");
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0]?.number, 1);
  assert.equal(episodes[1]?.number, 10);
  assert.match(episodes[0]?.content ?? "", /第一场/);

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

  console.log("import parser verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
