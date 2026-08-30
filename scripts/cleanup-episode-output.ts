/**
 * 批量清理指定正式剧集的分镜生成产物。
 *
 * 保留：原始剧本、ScriptScene 场次结构、P1/P2 全剧资料、项目资产、本集信息包。
 * 清理：分镜、Seedance 单元、提示词版本、问题卡、E0 骨架快照、岗位会话和 E0–E5 执行记录。
 * 默认只预览；追加 --yes 才执行删除，避免把项目 ID 或集数写错时误删。
 *
 * 示例：
 *   npm run cleanup:episodes -- --project cmt... --from 1 --to 16
 *   npm run cleanup:episodes -- --project cmt... --from 1 --to 16 --yes
 */
import { ensureSqlitePragmas, isSqliteBusyError, prisma } from "@/lib/prisma";

type OutputCounts = {
  shots: number;
  units: number;
  unitShots: number;
  promptVersions: number;
  issues: number;
  runs: number;
  beatSnapshots: number;
  cliSessions: number;
  apiSessions: number;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureSqlitePragmas();

  try {
    const project = await prisma.project.findUnique({
      where: { id: options.projectId },
      select: { id: true, title: true }
    });
    if (!project) throw new Error(`找不到项目 ${options.projectId}。请使用项目页面 URL 中的项目 ID。`);

    const episodes = await prisma.episode.findMany({
      where: { projectId: project.id, number: { gte: options.from, lte: options.to } },
      orderBy: { number: "asc" },
      select: {
        id: true,
        number: true,
        title: true,
        _count: {
          select: {
            scriptScenes: true,
            storyboardShots: true,
            seedanceUnits: true,
            workflowIssues: true,
            pipelineRuns: true
          }
        }
      }
    });
    const expectedCount = options.to - options.from + 1;
    if (episodes.length !== expectedCount) {
      const found = episodes.map((episode) => episode.number).join(", ") || "无";
      throw new Error(`目标范围应有 ${expectedCount} 集，实际找到 ${episodes.length} 集（${found}）。为安全起见未执行清理。`);
    }

    const episodeIds = episodes.map((episode) => episode.id);
    const activeRuns = await prisma.pipelineRun.count({
      where: { episodeId: { in: episodeIds }, status: { in: ["QUEUED", "RUNNING"] } }
    });
    if (activeRuns > 0) {
      throw new Error(`目标剧集还有 ${activeRuns} 条正在排队或执行中的任务，请先停止任务后再清理。`);
    }

    const before = await readOutputCounts(episodeIds);
    console.log(`项目：${project.title}（${project.id}）`);
    console.log(`范围：第${options.from}集–第${options.to}集，共 ${episodes.length} 集`);
    console.log(episodes.map(formatEpisodeSummary).join("\n"));
    console.log(`待清理：${formatCounts(before)}`);
    console.log("保留：原始剧本、场次结构、P1/P2 全剧资料、项目资产和本集信息包。");

    if (!options.confirm) {
      console.log("预览模式：未删除任何数据。确认无误后追加 --yes 执行清理。");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.workflowIssue.deleteMany({ where: { episodeId: { in: episodeIds } } });
      await tx.compiledPromptVersion.deleteMany({ where: { unit: { episodeId: { in: episodeIds } } } });
      await tx.seedanceUnitShot.deleteMany({ where: { unit: { episodeId: { in: episodeIds } } } });
      await tx.seedanceUnit.deleteMany({ where: { episodeId: { in: episodeIds } } });
      await tx.storyboardShot.deleteMany({ where: { episodeId: { in: episodeIds } } });
      await tx.sceneSnapshot.deleteMany({
        where: { episodeId: { in: episodeIds }, sceneKey: { contains: "BEATS" } }
      });
      await tx.apiRoleSession.deleteMany({ where: { episodeId: { in: episodeIds } } });
      await tx.cliRoleSession.deleteMany({ where: { episodeId: { in: episodeIds } } });
      await tx.pipelineRun.deleteMany({ where: { episodeId: { in: episodeIds } } });
    });

    const after = await readOutputCounts(episodeIds);
    console.log(`已完成：清理第${options.from}集–第${options.to}集的生成产物。`);
    console.log(`清理前：${formatCounts(before)}`);
    console.log(`清理后：${formatCounts(after)}`);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new Error("数据库当前正被其它任务占用，未完成本次清理；请先停止运行中的任务后再重试。", { cause: error });
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

async function readOutputCounts(episodeIds: string[]): Promise<OutputCounts> {
  const [shots, units, unitShots, promptVersions, issues, runs, beatSnapshots, cliSessions, apiSessions] = await Promise.all([
    prisma.storyboardShot.count({ where: { episodeId: { in: episodeIds } } }),
    prisma.seedanceUnit.count({ where: { episodeId: { in: episodeIds } } }),
    prisma.seedanceUnitShot.count({ where: { unit: { episodeId: { in: episodeIds } } } }),
    prisma.compiledPromptVersion.count({ where: { unit: { episodeId: { in: episodeIds } } } }),
    prisma.workflowIssue.count({ where: { episodeId: { in: episodeIds } } }),
    prisma.pipelineRun.count({ where: { episodeId: { in: episodeIds } } }),
    prisma.sceneSnapshot.count({ where: { episodeId: { in: episodeIds }, sceneKey: { contains: "BEATS" } } }),
    prisma.cliRoleSession.count({ where: { episodeId: { in: episodeIds } } }),
    prisma.apiRoleSession.count({ where: { episodeId: { in: episodeIds } } })
  ]);
  return { shots, units, unitShots, promptVersions, issues, runs, beatSnapshots, cliSessions, apiSessions };
}

function formatEpisodeSummary(episode: {
  number: number;
  title: string | null;
  _count: {
    scriptScenes: number;
    storyboardShots: number;
    seedanceUnits: number;
    workflowIssues: number;
    pipelineRuns: number;
  };
}) {
  return `第${episode.number}集：${episode.title ?? "未命名"} · 场次 ${episode._count.scriptScenes} · 分镜 ${episode._count.storyboardShots} · 单元 ${episode._count.seedanceUnits} · 问题 ${episode._count.workflowIssues} · 执行记录 ${episode._count.pipelineRuns}`;
}

function formatCounts(counts: OutputCounts) {
  return [
    `分镜 ${counts.shots}`,
    `单元 ${counts.units}`,
    `单元镜关联 ${counts.unitShots}`,
    `提示词版本 ${counts.promptVersions}`,
    `问题卡 ${counts.issues}`,
    `执行记录 ${counts.runs}`,
    `E0快照 ${counts.beatSnapshots}`,
    `CLI会话 ${counts.cliSessions}`,
    `API会话 ${counts.apiSessions}`
  ].join(" · ");
}

function parseArgs(args: string[]) {
  const projectId = readValue(args, "--project") ?? readValue(args, "--project-id") ?? args.find((arg) => !arg.startsWith("-")) ?? "";
  const from = parseRangeValue(readValue(args, "--from"), 1, "--from");
  const to = parseRangeValue(readValue(args, "--to"), 16, "--to");
  if (!projectId) throw new Error("缺少项目 ID。示例：npm run cleanup:episodes -- --project <项目ID> --from 1 --to 16 --yes");
  if (to < from) throw new Error("--to 不能小于 --from。");
  return { projectId, from, to, confirm: args.includes("--yes") };
}

function readValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseRangeValue(value: string | undefined, fallback: number, flag: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} 必须是正整数。`);
  return parsed;
}

void main().catch((error) => {
  console.error(`清理未执行：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
