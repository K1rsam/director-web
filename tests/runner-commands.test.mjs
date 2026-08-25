import assert from "node:assert/strict";
import test from "node:test";

import { buildRunnerCommand } from "../runner/commands.mjs";

test("unknown job kinds can never become shell commands", () => {
  assert.throws(
    () => buildRunnerCommand({ kind: "shell", payload: { command: "rm -rf /" } }, "/safe/project"),
    /不支持的任务类型/,
  );
});

test("foundation command is fixed and ignores injected command text", () => {
  assert.deepEqual(
    buildRunnerCommand(
      {
        kind: "project_foundation",
        payload: { projectId: "project-1", batchToken: "batch-1", stage: "P1", command: "rm -rf /" },
      },
      "/safe/project",
    ),
    {
      command: "npm",
      args: ["exec", "tsx", "scripts/run-project-foundation.ts", "project-1", "batch-1", "P1"],
      cwd: "/safe/project",
    },
  );
});

test("episode command requires the existing pipeline identifiers", () => {
  assert.throws(
    () => buildRunnerCommand({ kind: "episode_pipeline", payload: { projectId: "project-1" } }, "/safe/project"),
    /缺少必要参数/,
  );
});
