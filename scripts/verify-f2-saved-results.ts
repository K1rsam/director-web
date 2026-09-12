/** Opt-in read-only checks of saved evidence. Never creates runs/candidates or calls a provider. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Episode, PipelineRun, PresentationContract, Project, SceneSnapshot } from "@prisma/client";
import * as contracts from "@/lib/project-foundation-contracts";
import { buildEpisodeFoundationPackets, loadFoundationInputs, type FoundationCandidate, type FoundationDb } from "@/lib/foundation-state";
import { buildQ1ScopedSupply, requireBoundF1AuthorChunks } from "@/lib/foundation-review-input";

const names = ["--source-db", "--project-id", "--f1-snapshot-id", "--complete-run-id", "--partial-run-id"];
const args = process.argv.slice(2);
if (args.length !== names.length * 2 || names.some((name, index) => args[index * 2] !== name || !args[index * 2 + 1])) {
  console.error(`Usage: tsx scripts/verify-f2-saved-results.ts ${names.map((name) => `${name} <value>`).join(" ")}`);
  process.exit(2); // No default database, implicit user-data read or model fallback.
}
const [sourceDb, projectId, f1Id, completeRunId, partialRunId] = names.map((_, index) => args[index * 2 + 1]);
assert.ok(path.isAbsolute(sourceDb), "来源数据库必须显式使用绝对路径");
assert.notEqual(completeRunId, partialRunId);
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const columnsByTable: Record<string, string> = {
  Project: "id title description style aspectRatio executionMode ruleVersion archivedAt createdAt updatedAt",
  Episode: "id projectId number title content createdAt updatedAt",
  SceneSnapshot: "id projectId episodeId sceneKey title content metadata createdAt",
  PipelineRun: "id projectId episodeId stageCode roleName provider model status inputSummary outputSummary log error startedAt finishedAt durationMs createdAt",
  PresentationContract: "id projectId episodeId category question options evidence userAnswer status round note decidedAt createdAt updatedAt"
};
function select<T>(sql: string): T[] {
  assert.match(sql, /^SELECT \* FROM /);
  const columns = columnsByTable[sql.match(/^SELECT \* FROM (\w+)/)![1]];
  assert.ok(columns, "只能读取明确列出的项目资料表");
  // SQLite's SQL JSON encoder avoids the local CLI -json encoder's quadratic cost on large Unicode logs.
  const encoded = sql.replace("SELECT *", `SELECT json_object(${columns.split(" ").map((key) => `${quote(key)},${key}`).join(",")})`);
  const raw = execFileSync("sqlite3", ["-readonly", "-list", "-noheader", sourceDb, encoded], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 10000 });
  const rows = raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) as Array<Record<string, unknown>> : [];
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    ["createdAt", "updatedAt", "startedAt", "finishedAt", "decidedAt", "archivedAt"].includes(key) && value !== null ? new Date(value as string | number) : value
  ]))) as T[];
}
function one<T>(sql: string): T { const rows = select<T>(sql); assert.equal(rows.length, 1); return rows[0]; }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function readSelected() {
  const project = one<Project>(`SELECT * FROM Project WHERE id=${quote(projectId)}`);
  const episodes = select<Episode>(`SELECT * FROM Episode WHERE projectId=${quote(projectId)} ORDER BY number`);
  const f1 = one<SceneSnapshot>(`SELECT * FROM SceneSnapshot WHERE id=${quote(f1Id)} AND projectId=${quote(projectId)} AND sceneKey='FOUNDATION_F1'`);
  const f1Body = JSON.parse(f1.content);
  assert.equal(typeof f1Body.runId, "string");
  const source = one<SceneSnapshot>(`SELECT * FROM SceneSnapshot WHERE projectId=${quote(projectId)} AND sceneKey='FOUNDATION_SOURCE' ORDER BY createdAt DESC,id DESC LIMIT 1`);
  const f1Run = one<PipelineRun>(`SELECT * FROM PipelineRun WHERE id=${quote(f1Body.runId)} AND projectId=${quote(projectId)} AND stageCode='F1' AND status='SUCCEEDED'`);
  const failedRuns = [completeRunId, partialRunId].map((id) => one<PipelineRun>(`SELECT * FROM PipelineRun WHERE id=${quote(id)} AND projectId=${quote(projectId)} AND stageCode='F2' AND status='FAILED'`));
  const conditions = select<PresentationContract>(`SELECT * FROM PresentationContract WHERE projectId=${quote(projectId)} AND status='CONFIRMED' ORDER BY category,id`);
  const normalF2 = select<SceneSnapshot>(`SELECT * FROM SceneSnapshot WHERE projectId=${quote(projectId)} AND sceneKey='FOUNDATION_F2' AND json_extract(content,'$.upstreamSnapshotIds.f1')=${quote(f1Id)} AND json_extract(content,'$.runId') IN (SELECT id FROM PipelineRun WHERE projectId=${quote(projectId)} AND stageCode='F2' AND status='SUCCEEDED' AND json_extract(inputSummary,'$.recovery') IS NULL) ORDER BY createdAt DESC,id DESC LIMIT 1`)[0];
  const normalRun = normalF2 ? one<PipelineRun>(`SELECT * FROM PipelineRun WHERE id=${quote(JSON.parse(normalF2.content).runId)} AND projectId=${quote(projectId)} AND stageCode='F2'`) : null;
  return { project, episodes, f1, source, f1Run, failedRuns, conditions, normalF2: normalF2 ?? null, normalRun };
}

async function main() {
  const selected = readSelected();
  const before = hash(selected);
  try {
    const index = contracts.buildSourceIndex(selected.episodes);
    const f1 = { ...JSON.parse(selected.f1.content), id: selected.f1.id, createdAt: selected.f1.createdAt.toISOString() } as FoundationCandidate<contracts.F1Output>;
    assert.equal(index.version, f1.sourceVersion);
    const normalizeCalls = (log: string) => {
      const outputs: contracts.F2Output[] = [];
      for (const call of JSON.parse(log).calls) {
        const prior = outputs.length ? contracts.mergeF2Outputs(outputs, index, outputs.flatMap((part) => part.coverage)).assets : [];
        outputs.push(contracts.requireF2Output(call.response.data, index, call.scope, prior));
      }
      return outputs;
    };
    const completeParts = normalizeCalls(selected.failedRuns[0].log!);
    const partialParts = normalizeCalls(selected.failedRuns[1].log!);
    const complete = contracts.mergeF2Outputs(completeParts, index, index.episodes.map((episode) => episode.number));
    const partial = contracts.mergeF2Outputs(partialParts, index, partialParts.flatMap((part) => part.coverage));
    assert.equal(completeParts.length, 3); assert.equal(partialParts.length, 2);
    assert.equal(complete.assets.length, 70); assert.equal(complete.dataIssues?.length, 11); assert.equal(partial.dataIssues?.length, 56);
    for (const call of JSON.parse(selected.failedRuns[0].log!).calls) for (const asset of call.response.data.assets) {
      const merged = complete.assets.find((item) => item.key === asset.key)!;
      const variant = (merged.descriptionVariants ?? [{ text: merged.description, sourceRefs: merged.sourceRefs }]).find((item) => item.text === asset.description);
      assert.ok(variant, `${asset.key}原描述不得丢失`);
      for (const ref of asset.sourceRefs) assert.ok(variant.sourceRefs.some((kept) => kept.episode === Number(ref.episode) && kept.startLine === Number(ref.startLine) && kept.endLine === Number(ref.endLine)));
    }
    assert.ok(complete.assets.find((asset) => asset.name === "蜃")?.aliases.includes("蜃龙"));
    const ep28 = partial.episodes.find((episode) => episode.number === 28)!;
    const sunWang = partial.assets.find((asset) => asset.name === "孙旺");
    assert.ok(sunWang && ep28.assetKeys.includes(sunWang.key));
    assert.ok(ep28.assetKeys.every((key) => partial.assets.some((asset) => asset.key === key)));
    console.log("PASS 历史完整/部分响应仍可只读解释：70身份/11缺口与56缺口均保留，不改写为当前通过");

    // Reuse the input-version calculation with read-only records, not a writable database client.
    const inputDb = { project: { findUnique: async () => ({ ...selected.project, episodes: selected.episodes }) }, presentationContract: { findMany: async () => selected.conditions } } as unknown as FoundationDb;
    const currentInput = await loadFoundationInputs(projectId, inputDb);
    console.log(`当前交付规则是否要求重建F1：${currentInput.inputVersion !== f1.inputVersion}；本脚本不执行恢复或创建候选。`);
    if (selected.normalF2 && selected.normalRun) {
      const f2 = { ...JSON.parse(selected.normalF2.content), id: selected.normalF2.id, createdAt: selected.normalF2.createdAt.toISOString() } as FoundationCandidate<contracts.F2Output>;
      const authorChunks = requireBoundF1AuthorChunks({ projectId, index, candidate: f1, run: selected.f1Run });
      const packets = buildEpisodeFoundationPackets(index, f1.inputVersion, f1, f2);
      const views = authorChunks.map((chunk) => buildQ1ScopedSupply({ index, scope: chunk.scope, f1, f2, authorChunks, packets }));
      assert.equal(views.map((view) => view.candidates.f1.output.overview).join("\n\n"), f1.output.overview);
      assert.deepEqual(views.flatMap((view) => view.candidates.f1.output.coverage), index.episodes.map((episode) => episode.number));
      assert.equal(views.reduce((sum, view) => sum + view.dataIssues.length, 0), contracts.collectF2DataIssues(f2.output).length);
      for (const [position, view] of views.entries()) assert.deepEqual(view.candidates.f2.output.coverage, authorChunks[position].scope);
      const normalLog = JSON.parse(selected.normalRun.log!);
      const normalParts = normalizeCalls(selected.normalRun.log!);
      const metrics = normalLog.calls.map((call: any, position: number) => {
        const earlier = normalParts.slice(0, position);
        const registry = earlier.length ? contracts.mergeF2Outputs(earlier, index, earlier.flatMap((part) => part.coverage)).assets : [];
        const compact = registry.map(({ appearances: _appearances, ...identity }) => identity);
        return { batch: position + 1, oldRegistryChars: JSON.stringify(call.input.prior.registry ?? []).length,
          oldRepeatedChunksChars: JSON.stringify(call.input.prior.processedChunks ?? []).length, compactRegistryChars: JSON.stringify(compact).length };
      });
      console.log("PASS 正常旧稿按新Q1规则只读投影视图（不是新模型结果）：", JSON.stringify(views.map((view) => ({ scope: [view.candidates.f1.output.coverage[0], view.candidates.f1.output.coverage.at(-1)], overviewChars: view.candidates.f1.output.overview.length, dataIssues: view.dataIssues.length, authorIssues: view.authorIssues.length, referenceChars: view.referenceSource.reduce((sum, ref) => sum + ref.content.length, 0) }))));
      console.log("输入去重尺寸对照：", JSON.stringify(metrics));
    }
  } finally {
    assert.equal(hash(readSelected()), before, "选定用户资料及运行记录必须保持不变");
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
