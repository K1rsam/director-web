import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildRunnerCommand } from "../runner/commands.mjs";

test("unknown job kinds can never become shell commands", () => {
  assert.throws(
    () => buildRunnerCommand({ kind: "shell", payload: { command: "rm -rf /" } }, "/safe/project"),
    /不支持的任务类型/,
  );
});

test("foundation command is fixed and ignores injected command text", () => {
  const projectDir = "C:\\safe\\project";
  const inputPath = "C:\\temp\\input.json";
  const outputPath = "C:\\temp\\output.json";
  const tsxDist = join(projectDir, "node_modules", "tsx", "dist");
  assert.deepEqual(
    buildRunnerCommand(
      {
        kind: "project_foundation",
        payload: { projectId: "project-1", batchToken: "batch-1", stage: "P1", command: "rm -rf /" },
      },
      projectDir,
      { inputPath, outputPath },
    ),
    {
      command: process.execPath,
      args: [
        "--require", join(tsxDist, "preflight.cjs"),
        "--import", pathToFileURL(join(tsxDist, "loader.mjs")).href,
        join(projectDir, "scripts", "run-runner-job.ts"),
        "--input", inputPath,
        "--output", outputPath,
      ],
      cwd: projectDir,
    },
  );
});

test("pipeline command requires task snapshot files instead of local project identifiers", () => {
  assert.throws(
    () => buildRunnerCommand({ kind: "episode_pipeline", payload: { projectId: "project-1" } }, "C:\\safe\\project"),
    /缺少本地任务文件参数/,
  );
});
