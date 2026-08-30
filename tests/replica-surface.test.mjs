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

test("foundation execution controls enqueue a scoped D1 task for the personal runner", () => {
  const actions = readFileSync("app/projects/[projectId]/foundation-actions.tsx", "utf8");
  assert.match(actions, /startProjectFoundationAction/);
  assert.match(actions, /线上数据库/);
  assert.doesNotMatch(actions, /下一阶段接通/);
});

test("episode execution controls enqueue real D1 snapshot jobs while edits and exports remain", () => {
  const page = readFileSync("app/projects/[projectId]/episodes/[episodeId]/page.tsx", "utf8");
  const pipelineButton = readFileSync("app/projects/[projectId]/episodes/[episodeId]/episode-pipeline-button.tsx", "utf8");
  assert.match(page, /startEpisodePipelineAction|执行代码/);
  assert.match(page, /acknowledgeIssueAction/);
  assert.match(page, /resetEpisodeShotsAction/);
  assert.match(pipelineButton, /startEpisodePipelineAction/);
  assert.match(pipelineButton, /disabled={active}/);
  assert.equal(existsSync("app/api/episodes/[episodeId]/final/route.ts"), true);
  assert.equal(existsSync("app/api/task-packages/[taskPackageId]/prompt/route.ts"), true);
});

test("the one-time hosted import endpoint is removed after migration", () => {
  assert.equal(existsSync("app/api/admin/import/route.ts"), false);
  assert.doesNotMatch(readFileSync("db/env.d.ts", "utf8"), /DIRECTOR_IMPORT_TOKEN/);
});

test("shared chrome keeps a responsive scale on a continuous viewport background", () => {
  const css = readFileSync("app/vision-studio.css", "utf8");
  const marker = "/* Responsive display framework */";
  const responsiveLayer = css.slice(css.indexOf(marker));
  assert.match(css, /--vision-font-body:\s*clamp\(14px,/);
  assert.match(css, /--vision-content-max:\s*2200px/);
  assert.match(responsiveLayer, /--vision-workspace-offset:\s*calc\(var\(--vision-sidebar-width\) \+ 28px\)/);
  assert.match(responsiveLayer, /:root\s*\{[^}]*background:\s*var\(--vision-canvas-deep\);/s);
  assert.match(css, /html\s*\{[^}]*background:\s*var\(--vision-canvas-deep\);/s);
  assert.match(css, /body\s*\{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.visionRouteFrame\s*\{[^}]*position:\s*relative;[^}]*isolation:\s*isolate;[^}]*background:\s*transparent;/s);
  assert.match(css, /\.visionRouteFrame::before\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*-1;[^}]*inset:\s*0;[^}]*background:\s*var\(--vision-page-backdrop\);/s);
  assert.match(css, /\.visionRouteFrame > div\s*\{[^}]*background:\s*transparent;/s);
  assert.match(responsiveLayer, /\.appChrome\s*\{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.loginShell\s*\{[^}]*background:\s*transparent;/s);
  assert.doesNotMatch(css, /html, body\s*\{[^}]*background:\s*var\(--vision-page-backdrop\);/s);
  assert.doesNotMatch(responsiveLayer, /\.appChrome::before\s*\{[^}]*display:\s*block;/s);
  assert.match(responsiveLayer, /\.appChrome \.appTopbar\s*\{[^}]*top:\s*var\(--vision-topbar-inset\);[^}]*width:\s*auto;[^}]*margin:\s*var\(--vision-topbar-inset\) var\(--vision-page-gutter\) 0;[^}]*border-radius:\s*20px;/s);
  assert.match(css, /\.sceneStructureScroll\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
  assert.match(css, /\.sceneStructureScroll \.studioTableScroll\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*clip;/s);
  assert.doesNotMatch(responsiveLayer, /\bzoom\s*:|transform:\s*scale\(/);
});

test("login and workspace use the L brand glyph", () => {
  const login = readFileSync("app/login/page.tsx", "utf8");
  const chrome = readFileSync("app/ui/app-chrome.tsx", "utf8");
  assert.match(login, /<span>L<\/span>/);
  assert.match(chrome, /<span aria-hidden="true">L<\/span>/);
  assert.doesNotMatch(login, /<span>镜<\/span>/);
  assert.doesNotMatch(chrome, /<span aria-hidden="true">镜<\/span>/);
});

test("episode production text is readable without enlarging the project workbench", () => {
  const css = readFileSync("app/vision-studio.css", "utf8");
  const marker = "/* Episode workspace legibility */";
  const legibilityLayer = css.slice(css.indexOf(marker));

  assert.notEqual(css.indexOf(marker), -1);
  assert.match(legibilityLayer, /\.episodeShell \.viewTabs a[^{]*\{[^}]*font-size:\s*var\(--vision-font-body\)/s);
  assert.match(legibilityLayer, /\.episodeShell \.episodeRoleDeck \.roleProgress strong[^{]*\{[^}]*font-size:\s*var\(--vision-font-body\)/s);
  assert.match(legibilityLayer, /\.episodeShell \.unitCard h3[^{]*\{[^}]*font-size:\s*var\(--vision-font-body\)/s);
  assert.match(legibilityLayer, /\.episodeShell \.logRow strong[^{]*\{[^}]*font-size:\s*var\(--vision-font-body\)/s);
  assert.match(legibilityLayer, /\.episodeShell \.issueRow b[^{]*\{[^}]*font-size:\s*var\(--vision-font-body\)/s);
  assert.match(legibilityLayer, /\.episodeShell \.exportEpisodeBar span[^{]*\{[^}]*font-size:\s*var\(--vision-font-body\)/s);
  assert.match(legibilityLayer, /\.episodeShell \.seedancePromptTag[^{]*\{[^}]*font-size:\s*var\(--vision-font-body\)/s);
  assert.match(legibilityLayer, /\.episodeShell \.seedancePrompt pre[^{]*\{[^}]*font-size:\s*var\(--vision-font-unit\)/s);
  assert.match(legibilityLayer, /\.appChrome \.archiveSection > summary[^{]*\{[^}]*font-size:\s*var\(--vision-font-body\)/s);
  assert.match(legibilityLayer, /\.accountMenu > div strong[^{]*\{[^}]*font-size:\s*var\(--vision-font-small\)/s);
  assert.match(legibilityLayer, /\.accountMenu button[^{]*\{[^}]*font-size:\s*var\(--vision-font-caption\)/s);
  assert.doesNotMatch(legibilityLayer, /\.foundationRole[^,{]*\{[^}]*font-size:/s);
});

test("DeepSeek uses each user's browser key without server-side persistence", () => {
  const setup = readFileSync("app/runner/deepseek-key-setup.tsx", "utf8");
  const route = readFileSync("app/api/providers/deepseek/test/route.ts", "utf8");

  assert.match(setup, /localStorage\.setItem/);
  assert.match(setup, /只保存在当前设备/);
  assert.match(route, /api\.deepseek\.com\/models/);
  assert.match(route, /authorization:\s*`Bearer \$\{apiKey\}`/);
  assert.match(route, /getCurrentUser/);
  assert.doesNotMatch(route, /getDb|getD1|process\.env|DEEPSEEK_API_KEY/);
});

test("personal runner uses each device's own CLI and a D1 task snapshot", () => {
  const page = readFileSync("app/runner/page.tsx", "utf8");
  const statusPanel = readFileSync("app/runner/codex-status-panel.tsx", "utf8");
  const statusRoute = readFileSync("app/api/runner/status/route.ts", "utf8");
  const statusContract = readFileSync("lib/runner-status.ts", "utf8");
  const form = readFileSync("app/runner/token-form.tsx", "utf8");
  const runner = readFileSync("public/runner/director-runner.mjs", "utf8");

  assert.match(page, /自己的 Codex CLI、账号和额度/);
  assert.match(page, /网站只保存线上项目数据与任务结果/);
  assert.match(page, /CodexStatusPanel/);
  assert.match(statusPanel, /本机账号与额度/);
  assert.match(statusPanel, /刷新线上状态/);
  assert.match(statusRoute, /authenticateRunner/);
  assert.match(statusRoute, /reportRunnerStatus/);
  assert.match(statusContract, /normalizeRunnerStatus/);
  assert.match(form, /本地执行代码目录/);
  assert.match(form, /一次性临时工作库/);
  assert.match(form, /下载 Windows 启动器/);
  assert.match(form, /复制 Mac 启动命令/);
  assert.match(runner, /codex_prompt/);
  assert.match(runner, /codexCommand[^;]*"codex"/);
  assert.match(runner, /spawnSpec\(command, commandArgs\)/);
  assert.match(runner, /process\.env\.ComSpec/);
  assert.match(runner, /本机 Codex CLI 检测失败/);
  assert.match(runner, /const commandArgs = \[\s*"exec"/s);
  assert.match(runner, /DIRECTOR_PROJECT_DIR/);
  assert.match(runner, /api\/runner\/jobs\/input/);
  assert.match(runner, /api\/runner\/status/);
  assert.match(runner, /account\/read/);
  assert.match(runner, /account\/rateLimits\/read/);
  assert.match(runner, /account\/usage\/read/);
  assert.match(runner, /refreshCodexStatus/);
  assert.match(runner, /run-runner-job\.ts/);
  assert.doesNotMatch(runner, /run-episode-pipeline|run-project-foundation/);
});

test("legacy runner entry delegates to the snapshot bridge", () => {
  const entry = readFileSync("runner/index.mjs", "utf8");
  assert.match(entry, /public\/runner\/director-runner\.mjs/);
  assert.doesNotMatch(entry, /buildRunnerCommand|dev\.db|run-episode-pipeline|run-project-foundation/);
});

test("runner settings reuse the shared workbench chrome", () => {
  const page = readFileSync("app/runner/page.tsx", "utf8");
  const chrome = readFileSync("app/ui/app-chrome.tsx", "utf8");
  const apiSetup = readFileSync("app/runner/deepseek-key-setup.tsx", "utf8");
  const cliSetup = readFileSync("app/runner/token-form.tsx", "utf8");
  const css = readFileSync("app/vision-studio.css", "utf8");

  assert.match(page, /<AppChrome/);
  assert.match(page, /activeSection="runner"/);
  assert.match(page, /runnerSettingsPage/);
  assert.doesNotMatch(page, /min-h-screen bg-\[#f2f5ff\]/);
  assert.match(chrome, /"runner"/);
  assert.match(chrome, /API 与 CLI/);
  assert.match(apiSetup, /runnerConnectionCard/);
  assert.match(cliSetup, /runnerConnectionCard/);
  assert.match(css, /\.runnerConnectionGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.doesNotMatch(page, /bg-\[#171d35\]/);
});

test("episode unit copy uses a middle text scale and matching lower corners", () => {
  const css = readFileSync("app/vision-studio.css", "utf8");
  const marker = "/* Episode workspace legibility */";
  const legibilityLayer = css.slice(css.indexOf(marker));

  assert.match(css, /--vision-font-unit:\s*clamp\(13px,[^;]*15px\)/);
  assert.match(legibilityLayer, /\.episodeShell \.seedancePrompt pre[^{]*\{[^}]*font-size:\s*var\(--vision-font-unit\)/s);
  assert.match(css, /\.episodeShell \.storyboardCanvas\s*\{[^}]*clip-path:\s*inset\(0 round 26px\)/s);
});
