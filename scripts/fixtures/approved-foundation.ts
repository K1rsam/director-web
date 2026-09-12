/** Fake first-stage setup for legacy E-stage regression tests, never for user projects. */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { executeProjectFoundation } from "@/lib/project-foundation";
import { preprocessProject } from "@/lib/project-preprocess";
import { foundationJson } from "@/lib/foundation-state";
import type { F2Asset } from "@/lib/project-foundation-contracts";

export async function seedApprovedFoundationFixture(projectId: string, db: PrismaClient) {
  if (!process.env.DATABASE_URL?.includes("director-isolated-regression-")) throw new Error("Legacy regression fixtures require the isolated database runner.");
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, include: { episodes: true, assets: true } });
  await preprocessProject(projectId, db);
  const identities: Array<Omit<F2Asset, "appearances">> = [];
  for (const asset of project.assets) {
    if (!["CH", "GROUP", "BEAST", "LOC", "PROP"].includes(asset.type)) continue;
    const key = `fixture-${asset.code}`;
    await db.asset.update({ where: { id: asset.id }, data: { metadata: JSON.stringify({ ...foundationJson(asset.metadata), foundationKey: key }) } });
    identities.push({ key, type: asset.type as F2Asset["type"], name: asset.name, aliases: [], description: "机械回归的虚构身份，不是内容质量结论", sourceRefs: project.episodes.map((episode) => ({ episode: episode.number, startLine: 1, endLine: 1 })) });
  }
  const batchToken = randomUUID();
  for (const stageCode of ["F1", "F2", "Q1"]) await db.pipelineRun.create({ data: { projectId, stageCode, roleName: stageCode, status: "QUEUED", inputSummary: JSON.stringify({ batchToken, provider: "API", foundation: true }) } });
  await executeProjectFoundation(projectId, batchToken, { db, stageRunner: async (stage, prompt) => {
    const scope: number[] = JSON.parse(prompt.split("INPUT_JSON:").at(-1)!.trim()).scope;
    const data = stage === "F1"
      ? { coverage: scope, overview: "虚构测试理解", episodes: scope.map((number) => ({ number, summary: "测试摘要", context: "仅验证工程行为", sourceSelections: [] })), issues: [] }
      : stage === "F2"
        ? { coverage: scope, assets: identities.map((asset) => ({ ...asset, sourceRefs: asset.sourceRefs.filter((ref) => scope.includes(ref.episode)) })), episodes: scope.map((number) => ({ number, context: "仅验证工程身份传递", uses: identities.map((asset) => ({ key: asset.key, presence: "ONSTAGE", state: "回归固定状态", sourceRefs: [{ episode: number, startLine: 1, endLine: 1 }] })) })), issues: [] }
        : { coverage: scope, verdict: "READY", summary: "虚构审核，仅服务旧E回归前置条件", issues: [] };
    return { data, rawOutput: JSON.stringify(data), stdout: "", stderr: "", sessionId: null };
  } });
}
