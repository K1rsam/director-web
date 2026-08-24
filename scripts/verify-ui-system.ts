import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveProjectGuidance } from "../lib/ui-guidance";

const root = join(import.meta.dirname, "..");
const chrome = readFileSync(join(root, "app/ui/app-chrome.tsx"), "utf8");
const styles = readFileSync(join(root, "app/globals.css"), "utf8");
const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
const projectPage = readFileSync(join(root, "app/projects/[projectId]/page.tsx"), "utf8");
const foundationActions = readFileSync(join(root, "app/projects/[projectId]/foundation-actions.tsx"), "utf8");
const homePage = readFileSync(join(root, "app/page.tsx"), "utf8");
const newPage = readFileSync(join(root, "app/projects/new/page.tsx"), "utf8");
const episodePage = readFileSync(join(root, "app/projects/[projectId]/episodes/[episodeId]/page.tsx"), "utf8");
const workspaceGrid = readFileSync(join(root, "app/projects/[projectId]/episodes/[episodeId]/workspace-grid.tsx"), "utf8");
const resetButton = readFileSync(join(root, "app/projects/[projectId]/episodes/[episodeId]/reset-episode-button.tsx"), "utf8");
const sceneTable = readFileSync(join(root, "app/projects/[projectId]/scene-structure-table.tsx"), "utf8");
const currentWorkflowSources = [
  projectPage,
  readFileSync(join(root, "app/projects/new/project-create-form.tsx"), "utf8"),
  readFileSync(join(root, "lib/project-entry.ts"), "utf8"),
  readFileSync(join(root, "lib/project-foundation.ts"), "utf8"),
  readFileSync(join(root, "lib/deepseek-api.ts"), "utf8"),
  readFileSync(join(root, "scripts/context-export.ts"), "utf8")
];

for (const source of currentWorkflowSources) {
  if (/E1[–—-]E7|E6\/E7|E6 问题|E7 裁定/.test(source)) {
    throw new Error("Current product copy still references the retired E1-E7 workflow");
  }
}

for (const token of ["appChrome", "appSidebar", "appTopbar", "appMain"]) {
  if (!chrome.includes(token)) throw new Error(`Shared chrome is missing ${token}`);
}

if (!styles.includes("--ui-canvas") || !styles.includes("position: sticky") || !styles.includes("position: fixed")) {
  throw new Error("Light UI tokens or fixed navigation behavior are missing");
}

if (!projectPage.includes("WorkflowGuidance") || projectPage.includes("advancedPanel")) {
  throw new Error("Project page must expose one guidance action without the retired advanced settings panel");
}

if (!layout.includes("vision-studio.css") || !layout.includes("PageTransition")) {
  throw new Error("Root layout must load the Vision Studio design layer and shared-axis transition");
}

for (const token of ["foundationStageForm", "foundationCardHitArea", "foundationCardAction", "maintenancePanel", "StopFoundationButton"]) {
  if (!foundationActions.includes(token) && !projectPage.includes(token)) {
    throw new Error(`Foundation controls are missing the unified interaction ${token}`);
  }
}

for (const [name, source] of [["home", homePage], ["new", newPage], ["episode", episodePage]] as const) {
  if (!source.includes("AppChrome")) throw new Error(`${name} page has not migrated to shared chrome`);
}

if (!projectPage.includes("compact") || !projectPage.includes("ModeSwitch")) {
  throw new Error("Project topbar must show the current CLI/API execution mode");
}

for (const selector of [".appChrome .bibleEpisode", ".appChrome .bibleLine", ".appChrome .studioTableScroll thead"]) {
  if (!styles.includes(selector)) throw new Error(`Legacy dark surface is not overridden: ${selector}`);
}

if (!workspaceGrid.includes("infoPanelBackdrop")) {
  throw new Error("Episode information must open as an overlay instead of shrinking the workspace");
}

if (!chrome.includes("所有项目") || !chrome.includes("?projectId=")) {
  throw new Error("Project library navigation must retain the active project context");
}

if (!homePage.includes("activeProject") || !homePage.includes("projectCardMenu")) {
  throw new Error("Home must preserve recent project navigation and move archive into an overflow menu");
}

if (homePage.includes("?? projects[0]") || !/requestedProjectId\s*\?/.test(homePage)) {
  throw new Error("Project library must not invent a recent-project context when no projectId was requested");
}

if (projectPage.includes('href="#next-action"') || !projectPage.includes("guidanceHref")) {
  throw new Error("Project top action must open the recommended destination directly instead of scrolling");
}

if (homePage.includes("episodes={activeProject?.episodes") || !homePage.includes("projectLabel={activeProject?.title}")) {
  throw new Error("Project library must hide episode navigation and label the recent project explicitly");
}

if (!chrome.includes("projectLabel") || !chrome.includes('activeSection !== "projects"')) {
  throw new Error("Shared navigation must distinguish project library context from project workspace context");
}

for (const token of ["roleStageForm", "roleCardHitArea", "roleCardAction", "episodeTopbarAction", "topbarStopForm"]) {
  if (!episodePage.includes(token)) throw new Error(`Episode workspace is missing the direct interaction ${token}`);
}

if (episodePage.includes('<i aria-hidden="true">↗</i>')) {
  throw new Error("Role cards must use plain action words without decorative arrows");
}

const pipelineButton = readFileSync(join(root, "app/projects/[projectId]/episodes/[episodeId]/episode-pipeline-button.tsx"), "utf8");
for (const label of ["一键生成本集分镜", "自动运行 E0–E5", "重新生成整集"]) {
  if (!pipelineButton.includes(label)) throw new Error(`Episode pipeline button is missing the clear state label: ${label}`);
}

if (!pipelineButton.includes("activeLabel") || episodePage.includes('studio.pipelineActive ? "执行中" : actionLabel')) {
  throw new Error("Episode UI must display the actual active scope instead of labeling every role as running");
}

if (episodePage.includes("advancedPanel episodeAdvanced") || episodePage.includes("manualStageGrid")) {
  throw new Error("Episode workspace must not duplicate stage actions in an advanced panel");
}

if (!resetButton.includes("window.confirm")) {
  throw new Error("Episode reset must require an explicit destructive-action confirmation");
}

if (resetButton.includes('const busy = active || pending') || resetButton.includes('{busy ? "重置中…"')) {
  throw new Error("An active pipeline must not falsely label reset as in progress");
}

for (const selector of [".appChrome .exportEpisodeBar", ".appChrome .issueGroupBlockers", ".appChrome .episodeWorkspace .dangerQuietButton", ".appChrome .phaseStep.done i"]) {
  if (!styles.includes(selector)) throw new Error(`Visible legacy surface is not neutralized: ${selector}`);
}

for (const selector of [".appChrome .roleStageForm:hover .roleProgress", ".appChrome .roleCardHitArea", ".appChrome .episodePageTools", ".appChrome .unitCard", ".appChrome .logView > section", ".appChrome .seedancePrompt pre"]) {
  if (!styles.includes(selector)) throw new Error(`Episode interaction or clean surface style is missing: ${selector}`);
}

if (!styles.includes(".appChrome::before")) {
  throw new Error("The top navigation backdrop must span the full viewport behind the floating sidebar");
}

const visionStylesPath = join(root, "app/vision-studio.css");
if (!existsSync(visionStylesPath)) {
  throw new Error("Vision Studio final style layer is missing");
}
const visionStyles = readFileSync(visionStylesPath, "utf8");
for (const token of ["visionRouteForward", "visionRouteBack", "prefers-reduced-motion", "--vision-glass", "--motion-route"]) {
  if (!visionStyles.includes(token)) throw new Error(`Vision Studio style layer is missing ${token}`);
}

for (const token of ["--vision-sidebar-width", "--vision-sidebar-edge", ".sidebarNav a.active::before"]) {
  if (!visionStyles.includes(token)) throw new Error(`Compact seamless sidebar is missing ${token}`);
}

for (const token of ["--vision-section-gap", "--vision-panel-padding", "--vision-module-gap", "--motion-expand", "--motion-route: 460ms"]) {
  if (!visionStyles.includes(token)) throw new Error(`Vision Studio hierarchy is missing ${token}`);
}

for (const selector of [".projectDashboard > .studioSection", ".episodeRoleDeck > .roleProgressRail", ".episodeDashboard .storyboardCanvas", ".projectLibrary .projectCardGrid"]) {
  if (!visionStyles.includes(selector)) throw new Error(`Large-panel hierarchy is missing ${selector}`);
}

for (const selector of [".episodeShell .appWorkspace", ".episodeShell .appMain", ".episodeRoleDeck", ".episodeShell .unitList", ".episodeShell .seedancePrompt pre"]) {
  if (!visionStyles.includes(selector)) throw new Error(`Single-scroll episode workspace is missing ${selector}`);
}

if (!/\.appChrome::after\s*\{[^}]*display:\s*none/s.test(visionStyles) || !/html\s*\{[^}]*color-scheme:\s*light/s.test(visionStyles)) {
  throw new Error("Legacy dark page texture must not leak above the floating light chrome");
}

if (!visionStyles.includes("--vision-page-backdrop") || !/html,\s*body\s*\{[^}]*background:\s*var\(--vision-page-backdrop\)/s.test(visionStyles)) {
  throw new Error("Elastic overscroll must reveal the same continuous gradient as the workspace");
}

if (!/\.viewTabs a::after\s*\{[^}]*bottom:\s*0/s.test(visionStyles)) {
  throw new Error("The active view underline must align with the tab bar instead of the next panel");
}

if (!/\.episodeShell \.episodeRoleDeck \.roleProgress\s*\{[^}]*height:\s*68px/s.test(visionStyles) || !visionStyles.includes(".roleProgress::before")) {
  throw new Error("Episode role status cards must use a compact glass hierarchy with a restrained state accent");
}

if (!/\.foundationRole\s*\{[^}]*height:\s*76px/s.test(visionStyles) || !visionStyles.includes(".foundationRole::before")) {
  throw new Error("Foundation role cards must share the compact glass status language used by episode roles");
}

if (!/\.episodeShell \.storyboardCanvas\s*\{[^}]*clip-path:\s*inset\(0 round 22px\)/s.test(visionStyles)) {
  throw new Error("The fixed episode canvas must clip its rounded lower edge without leaking a corner artifact");
}

if (visionStyles.includes(".appChrome:not(.episodeShell) .appTopbar") || visionStyles.includes(".appChrome:not(.episodeShell) .appSidebar")) {
  throw new Error("First-level pages must retain the same floating chrome geometry as episode pages");
}

if (!chrome.includes("episodeShell") || !episodePage.includes("episodeRoleDeck") || !episodePage.includes("episodeTopbarMeta")) {
  throw new Error("Episode page must merge duplicate heading controls into the topbar and expose a collapsible role deck");
}

if (episodePage.includes('className="episodePageHeading"')) {
  throw new Error("Episode page must not repeat its title and controls below the shared topbar");
}

if (!episodePage.includes('<details className="episodeRoleDeck" open>') || /episodeRoleDeck"\s+open=\{/.test(episodePage)) {
  throw new Error("Episode role status must default open without changing its initial state by pipeline status");
}

if (!/\.episodeShell \.unitList\s*\{[^}]*grid-auto-rows:\s*max-content/s.test(visionStyles)) {
  throw new Error("Seedance unit rows must grow to their full content height instead of clipping nested prompts");
}

for (const token of ["--vision-topbar-inset", ".projectCardHitArea", ".projectCard:has(.projectCardHitArea:focus-visible)"]) {
  if (!visionStyles.includes(token)) throw new Error(`Direct project navigation is missing ${token}`);
}

if (!homePage.includes('className="projectCardHitArea"') || !homePage.includes("aria-label={`进入项目")) {
  throw new Error("Each active project card must expose an accessible full-card link");
}

if (homePage.includes('className="libraryHeading"') || !homePage.includes('title="我的剧本项目"') || !homePage.includes('className="libraryTopbarMeta"')) {
  throw new Error("Project library must move its repeated hero information into the compact topbar");
}

if (projectPage.includes('className="projectHeroMeta"') || !projectPage.includes('className="projectTopbarMeta"')) {
  throw new Error("Project workspace must move its repeated project summary into the compact topbar");
}

for (const selector of [".libraryTopbarMeta", ".projectTopbarMeta"]) {
  if (!visionStyles.includes(selector)) throw new Error(`Compact topbar metadata is missing ${selector}`);
}

if (!/\.appChrome::before\s*\{[^}]*left:\s*var\(--vision-sidebar-edge\)/s.test(visionStyles)) {
  throw new Error("The topbar glass backdrop must start after the sidebar instead of showing through it");
}

if (!styles.includes(".appChrome .projectCardBody > * { min-width: 0; }") || !styles.includes("box-sizing: border-box;")) {
  throw new Error("Project card content must shrink inside its card instead of clipping the right edge");
}

if (!sceneTable.includes("useState(false)") || !sceneTable.includes("sceneStructureTable") || !sceneTable.includes("<colgroup>")) {
  throw new Error("Scene structure must default closed and declare readable column proportions");
}

if (!styles.includes(".sceneStructureTable") || !styles.includes("table-layout: fixed")) {
  throw new Error("Scene structure table must keep short columns readable at every desktop width");
}

for (const token of ["shotColKey", "shotColDuration", "shotColPicture", "shotColCamera", "shotColLighting", "shotColSound", "shotColDialogue", "shotColTransition", "shotColRevision"]) {
  if (!episodePage.includes(token)) throw new Error(`Storyboard table is missing ${token} column sizing`);
}

if (!styles.includes(".storyboardTable .shotColPicture") || !styles.includes("min-width: 1080px")) {
  throw new Error("Storyboard table must fit all columns on desktop and preserve readable widths on narrow screens");
}

if (!episodePage.includes('title={shot.revision}') || !episodePage.includes('shot.revision.split("_")[0]')) {
  throw new Error("Storyboard version labels must remain compact while preserving the full value on hover");
}

const contractFirst = deriveProjectGuidance({
  pendingContracts: 2,
  planningReady: false,
  assetsReady: false,
  episodes: []
});
if (contractFirst.kind !== "contracts") throw new Error("Pending contracts must be the first action");

const foundationNext = deriveProjectGuidance({
  pendingContracts: 0,
  planningReady: false,
  assetsReady: false,
  episodes: []
});
if (foundationNext.kind !== "foundation") throw new Error("Incomplete foundation must be recommended");

const failedEpisode = deriveProjectGuidance({
  pendingContracts: 0,
  planningReady: true,
  assetsReady: true,
  episodes: [
    { id: "running", number: 1, shotCount: 10, running: true, failed: false, finished: false },
    { id: "failed", number: 2, shotCount: 4, running: false, failed: true, finished: false }
  ]
});
if (failedEpisode.kind !== "running" || failedEpisode.episodeId !== "running") {
  throw new Error("Running work must remain visible before failed work");
}

const continueEpisode = deriveProjectGuidance({
  pendingContracts: 0,
  planningReady: true,
  assetsReady: true,
  episodes: [{ id: "e3", number: 3, shotCount: 8, running: false, failed: false, finished: false }]
});
if (continueEpisode.kind !== "continue" || continueEpisode.episodeId !== "e3") {
  throw new Error("Incomplete episode must be continued");
}

console.log("light UI system verification passed");
