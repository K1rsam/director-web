# Responsive Display Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed, undersized project UI scale with one fluid framework that remains readable and balanced from 1080P through 2K, removes the top black strip, and leaves the scene table with only page-level vertical scrolling.

**Architecture:** Keep the existing React structure and add one final responsive CSS layer in `app/vision-studio.css`, which is already imported after legacy styles. Protect the behavior with a small source contract test; no database, route, action, API, or Runner code changes.

**Tech Stack:** Next.js 16, React 19, Vinext, CSS, Node test runner, OpenAI Sites.

---

### Task 1: Add a failing responsive-framework contract

**Files:**
- Modify: `tests/replica-surface.test.mjs`

- [ ] **Step 1: Add the source contract**

```js
test("shared chrome uses a fluid readable scale and one vertical page scroll", () => {
  const css = readFileSync("app/vision-studio.css", "utf8");
  const marker = "/* Responsive display framework */";
  assert.match(css, /--vision-font-body:\s*clamp\(14px,/);
  assert.match(css, /--vision-content-max:\s*2200px/);
  assert.match(css, /\.appChrome \.appTopbar\s*\{[^}]*top:\s*0;[^}]*margin:\s*0;/s);
  assert.match(css, /\.sceneStructureScroll\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
  assert.match(css, /\.sceneStructureScroll \.studioTableScroll\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*clip;/s);
  const responsiveLayer = css.slice(css.indexOf(marker));
  assert.doesNotMatch(responsiveLayer, /\bzoom\s*:|transform:\s*scale\(/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/replica-surface.test.mjs`

Expected: the new test fails because the responsive marker and variables do not exist yet.

- [ ] **Step 3: Commit the failing contract**

```bash
git add tests/replica-surface.test.mjs
git commit -m "test: define responsive display contract"
```

### Task 2: Implement the shared responsive CSS layer

**Files:**
- Modify: `app/vision-studio.css`

- [ ] **Step 1: Append the final framework layer**

Append a final `/* Responsive display framework */` section that:

```css
/* Responsive display framework */
:root {
  --vision-font-caption: clamp(11px, calc(9.75px + .08vw), 13px);
  --vision-font-small: clamp(12px, calc(10.5px + .10vw), 14px);
  --vision-font-body: clamp(14px, calc(12.5px + .12vw), 16px);
  --vision-font-heading: clamp(18px, calc(16px + .25vw), 26px);
  --vision-sidebar-width: clamp(220px, 12.5vw, 252px);
  --vision-workspace-offset: calc(var(--vision-sidebar-width) + clamp(28px, 2vw, 40px));
  --vision-content-max: 2200px;
  --vision-page-gutter: clamp(16px, 1.5vw, 32px);
  --vision-section-gap: clamp(24px, 1.6vw, 36px);
  --vision-panel-padding: clamp(20px, 1.5vw, 32px);
  --vision-module-gap: clamp(12px, .9vw, 20px);
  color-scheme: light;
  background: #edf3fb;
}

html, body {
  min-width: 320px;
  margin: 0;
  background: var(--vision-page-backdrop);
}

body { font-size: var(--vision-font-body); }
.appChrome { min-height: 100dvh; font-size: var(--vision-font-body); }
.appChrome::before {
  display: block;
  inset: 0 0 auto;
  left: 0;
  height: clamp(68px, 4.3vw, 76px);
  background: rgba(243,247,253,.88);
}
.appSidebar { width: var(--vision-sidebar-width); }
.appWorkspace { min-width: 0; margin-left: var(--vision-workspace-offset); }
.appChrome .appTopbar {
  top: 0;
  width: 100%;
  min-height: clamp(68px, 4.3vw, 76px);
  margin: 0;
  border-radius: 0 0 20px 20px;
  padding: 10px var(--vision-page-gutter);
}
.appMain { width: 100%; padding: var(--vision-page-gutter) var(--vision-page-gutter) clamp(56px, 5vw, 88px); }
.projectLibrary, .projectDashboard, .episodeDashboard,
.appChrome .projectLibrary { width: 100%; max-width: var(--vision-content-max); }
.createPage, .newProjectPage, .appChrome .createProjectPage { width: 100%; max-width: 1600px; }

.chromeBrand strong { font-size: var(--vision-font-body); }
.chromeBrand small, .topbarIdentity small,
.libraryTopbarMeta, .projectTopbarMeta,
.sectionEyebrow, .projectHeroMeta p,
.cardHeader span, .posterFrame { font-size: var(--vision-font-caption); }
.sidebarNav a, .sidebarEpisodes a,
.sidebarFooter strong, .topbarStatus,
.guidanceMeta, .phaseStep small,
.foundationRole small, .foundationRole em,
.cardHeader em, .assetTabBar button,
.projectProgress > div, .projectProgress b,
.projectCardFooter > span, .aspectBadge,
.styleOptionCopy small, .createFormFooter p,
.episodeSummary p, .episodeCounts span { font-size: var(--vision-font-small); }
.topbarIdentity strong { font-size: clamp(16px, calc(14px + .18vw), 19px); }
.sidebarNav a { min-height: clamp(42px, 2.7vw, 48px); }

.libraryHeading h1, .createPageHeading h1,
.projectHeroMeta h2 { font-size: clamp(28px, calc(22px + .65vw), 40px); }
.guidanceCopy h1 { font-size: clamp(22px, calc(18px + .45vw), 32px); }
.sectionHeading h2, .formSectionHeader h2,
.projectTitleRow h2, .episodeSummary h3,
.cardHeader h3 { font-size: var(--vision-font-heading); }
.sectionLead, .createPageHeading > p:last-child,
.guidanceCopy > span, .sectionHeading p,
.formSectionHeader p, .scriptPasteField,
.styleFieldset > p, .biblePlaceholder p { font-size: var(--vision-font-body); }

.workflowGuidance { grid-template-columns: clamp(48px, 3vw, 60px) minmax(320px, 1fr) auto auto; gap: var(--vision-module-gap); padding: var(--vision-panel-padding); }
.foundationRail { grid-template-columns: repeat(4, minmax(220px, 1fr)); gap: var(--vision-module-gap); }
.foundationRole { min-height: clamp(82px, 5vw, 96px); height: auto; padding: 12px 14px !important; }
.foundationRole strong, .phaseStep strong,
.styleOptionCopy strong, .scriptDropzone strong,
.basicConfigGrid label, .styleFieldset legend { font-size: var(--vision-font-body); }
.foundationCardAction, .maintenancePanel > summary,
.maintenancePanel p { font-size: var(--vision-font-small); }

.cardHeader { min-height: 72px; padding: 18px var(--vision-panel-padding); }
.appChrome .studioCard, .appChrome .sceneStructureCard,
.appChrome .contractSection { padding: var(--vision-panel-padding); }
.appChrome .studioCard:has(> .cardHeader),
.appChrome .studioCard:has(> .sceneStructureHead) { padding: 0; }
.studioGrid.twoColumns { grid-template-columns: repeat(2, minmax(460px, 1fr)); }
.projectCardGrid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: var(--vision-module-gap); }

.bibleSectionHead, .bibleKeyValue b,
.bibleFactList li, .bibleEpisodeHead b,
.bibleEpisodeHead span, .bibleEpisodeStates,
.bibleLine b, .bibleLine span, .biblePlaceholder p,
.assetTabBar button, .quietButton, .primaryLink,
.continueLink { font-size: var(--vision-font-small); }
.bibleKeyValue span, .bibleFactList b,
.bibleEpisode small, .assetTabBar button b { font-size: var(--vision-font-caption); }

.appChrome .studioTableScroll table { font-size: var(--vision-font-body); }
.appChrome .studioTableScroll th { font-size: var(--vision-font-small); }
.appChrome .studioTableScroll td { font-size: var(--vision-font-small); line-height: 1.7; }
.appChrome .studioTableScroll th,
.appChrome .studioTableScroll td { padding: clamp(11px, .8vw, 16px); }
.sceneStructureScroll { max-height: none; overflow: visible; }
.sceneStructureScroll .studioTableScroll {
  max-height: none;
  overflow-x: auto;
  overflow-y: clip;
  scrollbar-gutter: stable;
}
.sceneStructureScroll .sceneTable { max-height: none; }
.sceneStructureTable { min-width: 1120px; }

.basicConfigGrid input, .basicConfigGrid select,
.scriptPasteField textarea, .sourceTabs button { font-size: var(--vision-font-body); }
.scriptDropzone small, .scriptDropzone em,
.styleOptionCopy small, .createFooterInfo p { font-size: var(--vision-font-small); }

.episodeStudioList > article { min-height: 108px; gap: var(--vision-module-gap); padding: 18px var(--vision-panel-padding); }
.episodeNumber { font-size: clamp(28px, 2vw, 36px); }
.episodeCounts b { font-size: var(--vision-font-heading); }

@media (max-width: 1320px) {
  .workflowGuidance { grid-template-columns: 54px minmax(280px, 1fr) auto; }
  .workflowGuidance .guidanceMeta { display: none; }
  .foundationRail { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
  .studioGrid.twoColumns { grid-template-columns: 1fr; }
}

@media (max-width: 980px) {
  .appWorkspace { margin-left: 0; }
  .appChrome .appTopbar { border-radius: 0 0 16px 16px; }
}

@media (max-width: 760px) {
  .workflowGuidance { grid-template-columns: 1fr; }
  .foundationRail { grid-template-columns: 1fr; }
  .sectionHeading { align-items: flex-start; flex-direction: column; }
  .sectionHeading p { max-width: none; text-align: left; }
}
```

- [ ] **Step 2: Run focused test and confirm GREEN**

Run: `node --test tests/replica-surface.test.mjs`

Expected: all tests in the file pass.

- [ ] **Step 3: Check formatting and commit**

Run: `git diff --check`

Expected: no output.

```bash
git add app/vision-studio.css
git commit -m "fix: add responsive display framework"
```

### Task 3: Verify the application

**Files:**
- No source changes expected.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: exit code 0.

- [ ] **Step 3: Build the exact Sites source**

Run: `npm run build`

Expected: Vinext completes the production build successfully.

- [ ] **Step 4: Review the working tree**

Run: `git status --short`

Expected: empty output.

### Task 4: Publish the verified build

**Files:**
- No source changes expected.

- [ ] **Step 1: Validate Sites readiness**

Use the Sites hosting validation workflow against `/Users/yue/Documents/CL-sites/.worktrees/original-sites-replica-phase1` and confirm it is the exact validated source.

- [ ] **Step 2: Deploy to the existing project**

Deploy the validated directory to Sites project `appgprj_6a8cf6302f808191a099a61f7806abee` so the existing public URL remains unchanged.

- [ ] **Step 3: Confirm deployment state**

Confirm the new version is active at `https://director-workbench-yue.a8197772.chatgpt.site/` and report the version number.
