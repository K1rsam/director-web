const FOUNDATION_STAGE = /^P[12]$/;
const EPISODE_STAGES = /^E[0-5](,E[0-5])*$/;

export function buildRunnerCommand(job, projectDir) {
  const payload = record(job?.payload);
  if (!payload) throw new Error("任务参数无效。");

  if (job?.kind === "project_foundation") {
    const projectId = required(payload.projectId);
    const batchToken = required(payload.batchToken);
    const stage = optionalStage(payload.stage, FOUNDATION_STAGE);
    return {
      command: "npm",
      args: ["exec", "tsx", "scripts/run-project-foundation.ts", projectId, batchToken, ...(stage ? [stage] : [])],
      cwd: projectDir,
    };
  }

  if (job?.kind === "episode_pipeline") {
    const projectId = required(payload.projectId);
    const episodeId = required(payload.episodeId);
    const batchToken = required(payload.batchToken);
    const stage = optionalStage(payload.stage, EPISODE_STAGES);
    return {
      command: "npm",
      args: [
        "exec",
        "tsx",
        "scripts/run-episode-pipeline.ts",
        projectId,
        episodeId,
        batchToken,
        ...(stage ? [stage] : []),
      ],
      cwd: projectDir,
    };
  }

  throw new Error(`不支持的任务类型：${String(job?.kind ?? "")}`);
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function required(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 160) {
    throw new Error("任务缺少必要参数。");
  }
  return value.trim();
}

function optionalStage(value, pattern) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("任务阶段参数无效。");
  return value;
}
