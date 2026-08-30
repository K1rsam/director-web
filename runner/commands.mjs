import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function buildRunnerCommand(job, projectDir, io = {}) {
  if (job?.kind !== "project_foundation" && job?.kind !== "episode_pipeline") {
    throw new Error(`不支持的任务类型：${String(job?.kind ?? "")}`);
  }
  if (!record(job?.payload)) throw new Error("任务参数无效。");
  const inputPath = required(io.inputPath);
  const outputPath = required(io.outputPath);
  const tsxDist = join(projectDir, "node_modules", "tsx", "dist");
  const bridge = join(projectDir, "scripts", "run-runner-job.ts");
  const args = [
    "--require", join(tsxDist, "preflight.cjs"),
    "--import", pathToFileURL(join(tsxDist, "loader.mjs")).href,
    bridge,
    "--input", inputPath,
    "--output", outputPath,
  ];

  return { command: process.execPath, args, cwd: projectDir };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function required(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 160) {
    throw new Error("缺少本地任务文件参数。");
  }
  return value.trim();
}
