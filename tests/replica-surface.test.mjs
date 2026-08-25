import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("original project library and creation surfaces replace the control prototype", () => {
  for (const route of [
    "app/login/page.tsx",
    "app/page.tsx",
    "app/projects/new/page.tsx",
    "app/projects/[projectId]/page.tsx",
    "app/projects/[projectId]/episodes/[episodeId]/page.tsx",
  ]) {
    assert.equal(existsSync(route), true, route);
  }

  const home = readFileSync("app/page.tsx", "utf8");
  const creation = readFileSync("app/projects/new/project-create-form.tsx", "utf8");
  const chrome = readFileSync("app/ui/app-chrome.tsx", "utf8");
  assert.match(home, /projectLibrary/);
  assert.match(home, /projectCardGrid/);
  assert.match(home, /topbarPrimary/);
  assert.match(creation, /createProjectForm/);
  assert.match(chrome, /appChrome/);
  assert.doesNotMatch(home, /创建连通测试任务|Sites 控制面/);
});

test("foundation execution controls stay visible but cannot enqueue fake work", () => {
  const actions = readFileSync("app/projects/[projectId]/foundation-actions.tsx", "utf8");
  assert.match(actions, /本地 Runner 执行将在下一阶段接通/);
  assert.doesNotMatch(actions, /runFoundationStageAction|startProjectFoundationAction/);
});

test("episode execution controls are explicit placeholders while edits and exports remain", () => {
  const page = readFileSync("app/projects/[projectId]/episodes/[episodeId]/page.tsx", "utf8");
  const pipelineButton = readFileSync("app/projects/[projectId]/episodes/[episodeId]/episode-pipeline-button.tsx", "utf8");
  assert.match(page, /执行引擎将在 API\/Runner 阶段接通/);
  assert.match(page, /acknowledgeIssueAction/);
  assert.match(page, /resetEpisodeShotsAction/);
  assert.match(pipelineButton, /disabled/);
  assert.doesNotMatch(page, /runSingleStageAction|repairOpenIssuesAction|stopPipelineAction/);
  assert.equal(existsSync("app/api/episodes/[episodeId]/final/route.ts"), true);
  assert.equal(existsSync("app/api/task-packages/[taskPackageId]/prompt/route.ts"), true);
});

test("the one-time hosted import endpoint is removed after migration", () => {
  assert.equal(existsSync("app/api/admin/import/route.ts"), false);
  assert.doesNotMatch(readFileSync("db/env.d.ts", "utf8"), /DIRECTOR_IMPORT_TOKEN/);
});
