import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { readFidelityReceipt } from "../lib/fidelity-store";
import { refreshFidelitySource } from "../lib/fidelity-refresh";
import { prepareFidelityReading } from "../lib/fidelity-import";
import { projectPinnedFidelitySource } from "../lib/fidelity-source-projection";

// This diagnostic never opens the production database for writes. It requires an
// explicit consistent backup and exercises the existing guarded migration there.
async function main() {
  const [backup, projectId] = process.argv.slice(2);
  assert.ok(backup && path.isAbsolute(backup) && projectId, "Pass an absolute consistent backup and the exact project id");
  const scratch = await mkdtemp(path.join(tmpdir(), "episode-number-qa-")), file = path.join(scratch, "copy.db");
  await copyFile(backup, file);
  const db = new PrismaClient({ datasourceUrl: `file:${file}` });
  try {
    const before = await db.episode.findMany({ where: { projectId }, orderBy: { number: "asc" } });
    const scenes = await db.scriptScene.findMany({ where: { episode: { projectId } }, orderBy: { id: "asc" } });
    const current = await readFidelityReceipt(projectId, db); assert.ok(current?.sourceSnapshot);
    const source = projectPinnedFidelitySource(JSON.parse(current.sourceSnapshot.content), current.receipt);
    const prepared = prepareFidelityReading({ ...source, readingView: current.receipt.reader }, current.receipt.mode, current.receipt.decisions, current.receipt.originalHash);
    assert.equal(prepared.receipt.episodeNumbering, "SOURCE_NUMBER_V1");
    assert.equal(prepared.imported.episodes.length, before.length);
    const expected = prepared.imported.episodes.map(episode => {
      const matches = before.filter(old => old.content === episode.content && old.title === episode.title);
      assert.equal(matches.length, 1, "Every episode must have an exact unique unchanged-content identity");
      return { id: matches[0].id, oldNumber: matches[0].number, number: episode.number, content: episode.content, title: episode.title };
    });
    assert.ok(expected.some(item => item.oldNumber !== item.number));
    const outcome = await refreshFidelitySource(projectId, db, { expectedReceiptId: current.snapshot.id, expectedSourceId: current.sourceSnapshot.id, decisions: current.receipt.decisions });
    assert.equal(outcome.changed, true);
    const after = await db.episode.findMany({ where: { projectId }, orderBy: { number: "asc" } });
    assert.equal(after.length, before.length);
    for (const item of expected) {
      const episode = after.find(value => value.id === item.id); assert.ok(episode);
      assert.equal(episode.number, item.number); assert.equal(episode.content, item.content); assert.equal(episode.title, item.title);
    }
    const afterScenes = await db.scriptScene.findMany({ where: { episode: { projectId } }, orderBy: { id: "asc" } });
    assert.equal(afterScenes.length, scenes.length);
    assert.deepEqual(afterScenes.map(scene => [scene.id, scene.episodeId, scene.sourceText]), scenes.map(scene => [scene.id, scene.episodeId, scene.sourceText]));
    const latest = await readFidelityReceipt(projectId, db); assert.ok(latest?.sourceSnapshot);
    assert.equal(latest.receipt.originalHash, current.receipt.originalHash); assert.equal(latest.receipt.readingHash, current.receipt.readingHash);
    assert.deepEqual(latest.receipt.result, current.receipt.result, "Immutable normalization result is preserved");
    assert.deepEqual(projectPinnedFidelitySource(JSON.parse(latest.sourceSnapshot.content), latest.receipt).episodes, prepared.imported.episodes);
    const archives = await db.sceneSnapshot.count({ where: { projectId, sceneKey: { startsWith: "RETIRED_FIDELITY_EPISODE-" } } });
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    console.log(JSON.stringify({ status: "PASS", scope: "consistent backup copy only; zero models", projectId, episodes: after.length, scenes: afterScenes.length, first: after[0].number, last: after.at(-1)!.number, originalTextUnchanged: latest.receipt.readingHash === hash(source.sourceText), idsAndEpisodeBodiesUnchanged: true, archives, scratch }));
  } finally { await db.$disconnect(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
