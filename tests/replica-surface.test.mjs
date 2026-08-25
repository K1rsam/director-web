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
  assert.match(legibilityLayer, /\.episodeShell \.seedancePrompt pre[^{]*\{[^}]*font-size:\s*var\(--vision-font-body\)/s);
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

test("personal runner starts without a CL-sites source directory", () => {
  const page = readFileSync("app/runner/page.tsx", "utf8");
  const form = readFileSync("app/runner/token-form.tsx", "utf8");
  const runner = readFileSync("public/runner/director-runner.mjs", "utf8");

  assert.doesNotMatch(page, /打开\s*<code[^>]*>CL-sites|DIRECTOR_PROJECT_DIR/);
  assert.match(form, /下载 Windows 启动器/);
  assert.match(form, /复制 Mac 启动命令/);
  assert.match(runner, /codex_prompt/);
  assert.match(runner, /codexCommand[^;]*"codex"/);
  assert.match(runner, /const commandArgs = \[\s*"exec"/s);
  assert.doesNotMatch(runner, /CL-sites|DIRECTOR_PROJECT_DIR|run-episode-pipeline|run-project-foundation/);
});
