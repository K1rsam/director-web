/**
 * ai-context 导出脚本（DSH 上下文桥）
 *
 * 用法：
 *   npm run context:export -- --project <项目标题|项目id> --episode <集数> [--full] [--out <目录>]
 *
 * 行为：只读数据库，把项目状态快照与指定单集信息包写入 ai-context/（默认），
 * 并刷新 CONTEXT_INDEX.md 的生成区。PROJECT_HANDOFF.md 为人工维护，脚本不触碰。
 *
 * 设计目标：输出小而全 —— 单集信息包约 15KB 以内，DSH 会话一次可读完；
 * 默认省略 e1Data..e4Data / metadata / data 等大 JSON 字段，--full 时包含。
 *
 * 依赖项目现有约定：@/lib/prisma 单例、tsx 运行、process.argv 解析（同 run-episode-pipeline.ts）。
 */
import { prisma } from "@/lib/prisma";
import { getFoundationState } from "@/lib/foundation-state";
import { deriveProjectCardState } from "@/lib/project-entry";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const OUT_DEFAULT = resolve(process.cwd(), "ai-context");

const GEN_START = "<!-- GENERATED-START -->";
const GEN_END = "<!-- GENERATED-END -->";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--full") {
      out.full = true;
      continue;
    }
    if (arg.startsWith("--")) {
      out[arg.slice(2)] = argv[i + 1] ?? true;
      i++;
    }
  }
  return out;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const pad2 = (n: number): string => String(n).padStart(2, "0");

function safeJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function refreshIndex(
  file: string,
  ctx: { projectTitle: string; stage: string; progress: number; generatedAt: string | null; episodeNumber: number }
) {
  const generated = `${GEN_START}
**项目**: ${ctx.projectTitle} ｜ **阶段**: ${ctx.stage} (${ctx.progress}%) ｜ **最近导出**: ${ctx.generatedAt ?? "—"} ｜ **最新信息包**: episodes/episode-${pad2(ctx.episodeNumber)}.json
${GEN_END}`;
  let content: string;
  try {
    const existing = await readFile(file, "utf8");
    const re = new RegExp(`${GEN_START}[\\s\\S]*${GEN_END}`);
    content = re.test(existing) ? existing.replace(re, generated) : `${existing}\n\n${generated}\n`;
  } catch {
    content = `# ai-context 索引

> 会话入口：先读本文件，再按任务读取对应信息包。不读数据库、不读完整聊天记录。

## 读我
- \`PROJECT_HANDOFF.md\` —— 项目目标 / 工作流 / 规则 / 交接（人工维护）
- \`CURRENT_STATE.json\` —— 全项目状态快照（自动生成）
- \`episodes/episode-<N>.json\` —— 单集信息包（自动生成）

## 工作流速查
全剧资料（P0 原文机械检查 → F1 理解供给 → F2 身份与源状态 → Q1 独立审查并批准）→ 旧版分镜生产（E0 叙事节奏 → E1 结构导演 → E2 表演调度 → E3 单元视听 → E4 摄影光影 → E5 审查总控；失败即停）→ 单集结果

${generated}
`;
  }
  await writeFile(file, content);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRef = String(args.project ?? "");
  const episodeN = Number(args.episode ?? NaN);
  const full = Boolean(args.full);
  const outDir = resolve(String(args.out ?? OUT_DEFAULT));
  if (!projectRef) throw new Error("缺少 --project <标题或id>");
  if (!Number.isInteger(episodeN) || episodeN < 1) throw new Error("缺少或非法 --episode <集数>");

  // ---- 定位项目 ----
  const project = await prisma.project.findFirst({
    where: { OR: [{ id: projectRef }, { title: projectRef }] },
  });
  if (!project) throw new Error(`未找到项目: ${projectRef}`);

  // ---- 单集 ----
  const episode = await prisma.episode.findUnique({
    where: { projectId_number: { projectId: project.id, number: episodeN } },
  });
  if (!episode) throw new Error(`项目「${project.title}」中未找到第 ${episodeN} 集`);

  const [scenes, shots, units, issues, runs, assets, reviews, finals] = await Promise.all([
    prisma.scriptScene.findMany({ where: { episodeId: episode.id }, orderBy: { sortOrder: "asc" } }),
    prisma.storyboardShot.findMany({ where: { episodeId: episode.id }, orderBy: { sortOrder: "asc" } }),
    prisma.seedanceUnit.findMany({ where: { episodeId: episode.id }, orderBy: { sortOrder: "asc" } }),
    prisma.workflowIssue.findMany({ where: { episodeId: episode.id }, orderBy: { createdAt: "asc" } }),
    prisma.pipelineRun.findMany({ where: { episodeId: episode.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.asset.findMany({ where: { projectId: project.id }, orderBy: { code: "asc" } }),
    prisma.reviewRound.findMany({ where: { episodeId: episode.id }, orderBy: { createdAt: "desc" } }),
    prisma.finalScript.findMany({ where: { episodeId: episode.id }, orderBy: { version: "desc" } }),
  ]);

  // 每个单元取最新一版提示词
  const unitIds = units.map((u) => u.id);
  const promptVersions = unitIds.length
    ? await prisma.compiledPromptVersion.findMany({
        where: { unitId: { in: unitIds } },
        orderBy: [{ unitId: "asc" }, { version: "desc" }],
      })
    : [];
  const latestPromptByUnit = new Map<string, (typeof promptVersions)[number]>();
  for (const pv of promptVersions) {
    if (!latestPromptByUnit.has(pv.unitId)) latestPromptByUnit.set(pv.unitId, pv);
  }

  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const shotById = new Map(shots.map((s) => [s.id, s]));

  // ---- 单集信息包 ----
  const episodePackage = {
    episode: {
      number: episode.number,
      title: episode.title ?? null,
      updatedAt: iso(episode.updatedAt),
    },
    scenes: scenes.map((s) => ({
      sceneKey: s.sceneKey,
      sortOrder: s.sortOrder,
      heading: s.heading ?? null,
      location: s.location ?? null,
      interiorExterior: s.interiorExterior ?? null,
      timeOfDay: s.timeOfDay ?? null,
      timeLayer: s.timeLayer,
      sourceText: s.sourceText,
      ...(full ? { metadata: safeJson(s.metadata) } : {}),
    })),
    shots: shots.map((s) => ({
      shotKey: s.shotKey,
      sortOrder: s.sortOrder,
      sceneKey: sceneById.get(s.sceneId)?.sceneKey ?? null,
      duration: s.duration,
      timeLayer: s.timeLayer,
      dialogue: safeJson(s.dialogue),
      ...(full
        ? {
            e1Data: safeJson(s.e1Data),
            e2Data: safeJson(s.e2Data),
            e3Data: safeJson(s.e3Data),
            e4Data: safeJson(s.e4Data),
          }
        : {}),
    })),
    units: units.map((u) => ({
      unitKey: u.unitKey,
      sortOrder: u.sortOrder,
      sceneKey: sceneById.get(u.sceneId)?.sceneKey ?? null,
      duration: u.duration,
      startPremise: u.startPremise,
      endState: u.endState,
      dominantGoal: u.dominantGoal ?? null,
      shortUnitReason: u.shortUnitReason ?? null,
      ...(full ? { data: safeJson(u.data) } : {}),
    })),
    prompts: units
      .map((u) => {
        const latest = latestPromptByUnit.get(u.id);
        return latest
          ? { unitKey: u.unitKey, version: latest.version, syncStatus: latest.syncStatus, content: latest.content }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    issues: issues.map((i) => ({
      coordinate: i.coordinate,
      code: i.code,
      severity: i.severity,
      status: i.status,
      ownerRole: i.ownerRole,
      expected: i.expected,
      evidence: i.evidence,
      shotKey: i.shotId ? shotById.get(i.shotId)?.shotKey ?? null : null,
    })),
    runs: runs.map((r) => ({
      stageCode: r.stageCode,
      roleName: r.roleName,
      provider: r.provider,
      model: r.model ?? null,
      status: r.status,
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
    })),
    reviews: reviews.map((r) => ({
      title: r.title,
      status: r.status,
      notes: r.notes ?? null,
      createdAt: iso(r.createdAt),
    })),
    finalScript: finals[0] ? { version: finals[0].version, createdAt: iso(finals[0].createdAt) } : null,
    _meta: {
      generatedAt: iso(new Date()),
      full,
      counts: { scenes: scenes.length, shots: shots.length, units: units.length, issues: issues.length },
    },
  };

  // ---- 全项目状态快照 ----
  const allEpisodes = await prisma.episode.findMany({
    where: { projectId: project.id },
    orderBy: { number: "asc" },
  });
  const productionEpisodes = allEpisodes.filter((ep) => ep.number >= 1);
  const preludeEpisodes = allEpisodes.filter((ep) => ep.number < 1);
  const epSummaries = await Promise.all(
    productionEpisodes.map(async (ep) => {
      const [unitCount, shotCount, openIssues, taskPackages] = await Promise.all([
        prisma.seedanceUnit.count({ where: { episodeId: ep.id } }),
        prisma.storyboardShot.count({ where: { episodeId: ep.id } }),
        prisma.workflowIssue.count({ where: { episodeId: ep.id, status: "OPEN" } }),
        prisma.taskPackage.count({ where: { episodeId: ep.id } }),
      ]);
      return {
        number: ep.number,
        title: ep.title ?? null,
        unitCount,
        shotCount,
        openIssues,
        taskPackages,
        updatedAt: iso(ep.updatedAt),
      };
    })
  );
  const snapshotCount = await prisma.sceneSnapshot.count({ where: { projectId: project.id } });
  const assetCount = await prisma.asset.count({ where: { projectId: project.id } });
  const unitEpisodeCount = epSummaries.filter((e) => e.unitCount > 0).length;
  const foundationReady = (await getFoundationState(project.id)).ready;
  const { stage, progress, actionLabel } = deriveProjectCardState({ episodeCount: epSummaries.length, foundationReady, unitEpisodeCount });

  const currentState = {
    generatedAt: iso(new Date()),
    project: {
      id: project.id,
      title: project.title,
      style: project.style ?? null,
      aspectRatio: project.aspectRatio,
      executionMode: project.executionMode,
      ruleVersion: project.ruleVersion,
      updatedAt: iso(project.updatedAt),
    },
    stage,
    progress,
    actionLabel,
    counts: {
      episodes: epSummaries.length,
      preludeEpisodes: preludeEpisodes.length,
      snapshots: snapshotCount,
      assets: assetCount,
      unitEpisodes: unitEpisodeCount
    },
    episodes: epSummaries,
    preludeContext: preludeEpisodes.map((ep) => ({ number: ep.number, title: ep.title, contentPreview: ep.content.slice(0, 240) })),
    assets: assets.map((a) => ({ code: a.code, type: a.type, name: a.name, status: a.status, parentCode: a.parentId ? assets.find((p) => p.id === a.parentId)?.code ?? null : null })),
  };

  // ---- 落盘 ----
  await mkdir(join(outDir, "episodes"), { recursive: true });
  const stateFile = join(outDir, "CURRENT_STATE.json");
  const pkgFile = join(outDir, "episodes", `episode-${pad2(episode.number)}.json`);
  const indexFile = join(outDir, "CONTEXT_INDEX.md");

  await writeFile(stateFile, JSON.stringify(currentState, null, 2) + "\n");
  await writeFile(pkgFile, JSON.stringify(episodePackage, null, 2) + "\n");
  await refreshIndex(indexFile, {
    projectTitle: project.title,
    stage,
    progress,
    generatedAt: currentState.generatedAt,
    episodeNumber: episode.number,
  });

  const kb = (s: string) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(1);
  const read = (f: string) => readFile(f, "utf8").then(kb);
  console.log(`✓ 已导出项目「${project.title}」第 ${episode.number} 集`);
  console.log(`  ${stateFile}  ${await read(stateFile)} KB`);
  console.log(`  ${pkgFile}  ${await read(pkgFile)} KB`);
  console.log(`  ${indexFile}  ${await read(indexFile)} KB`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
