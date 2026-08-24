import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const actions = readFileSync("app/actions.ts", "utf8");
const taskPackageRoute = readFileSync(
  "app/api/task-packages/[taskPackageId]/prompt/route.ts",
  "utf8"
);
const finalScriptRoute = readFileSync("app/api/episodes/[episodeId]/final/route.ts", "utf8");

for (const insecureToken of ["headers()", "getPermissions", "requirePermission", "x-user-"]) {
  assert.equal(actions.includes(insecureToken), false, `insecure action boundary remains: ${insecureToken}`);
}

function actionSource(name: string): string {
  const start = actions.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing server action: ${name}`);
  const next = actions.indexOf("\nexport async function ", start + 1);
  return actions.slice(start, next === -1 ? undefined : next);
}

const importProjectSource = actionSource("importProjectAction");
assert.ok(importProjectSource.includes("requireSessionUser"));
assert.ok(
  importProjectSource.indexOf("requireSessionUser") < importProjectSource.indexOf("try {"),
  "importProjectAction must not swallow the login redirect"
);

for (const name of [
  "archiveProjectAction",
  "restoreProjectAction",
  "deleteProjectAction",
  "setProjectExecutionModeAction",
  "preprocessProjectAction",
  "startProjectFoundationAction",
  "confirmAllAssetsAction",
  "decidePresentationContractAction",
  "skipPresentationContractAction",
  "runFoundationStageAction",
  "stopProjectFoundationAction"
]) {
  assert.ok(actionSource(name).includes("requireProjectAccess"), `${name} lacks project access guard`);
}

for (const name of [
  "prepareEpisodeAction",
  "startEpisodePipelineAction",
  "repairOpenIssuesAction",
  "stopPipelineAction",
  "acknowledgeIssueAction",
  "acknowledgeAllSuggestionsAction",
  "runSingleStageAction",
  "resetEpisodeShotsAction",
  "restorePromptVersionAction",
  "saveManualPromptVersionAction"
]) {
  const source = actionSource(name);
  assert.ok(source.includes("requireProjectAccess"), `${name} lacks project access guard`);
  assert.ok(source.includes("requireEpisodeAccess"), `${name} lacks episode access guard`);
}

for (const [label, source] of [
  ["task package", taskPackageRoute],
  ["final script", finalScriptRoute]
] as const) {
  for (const token of [
    "getCurrentUser",
    "status: 401",
    "roles: { some: { userId: user.id } }",
    "status: 404"
  ]) {
    assert.ok(source.includes(token), `${label} route lacks ${token}`);
  }
}

assert.equal(taskPackageRoute.includes("taskPackage.findUnique"), false);
assert.equal(finalScriptRoute.includes("where: { episodeId },"), false);

console.log("auth boundary verification passed");
