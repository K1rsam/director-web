# Floating Chrome Background Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the floating sidebar/topbar on Win and Mac, keep the background continuous from the viewport top, and change the two brand glyphs to “L”.

**Architecture:** Keep the current React structure and responsive typography. Replace only the conflicting final CSS overrides, update the two existing brand literals, and protect the result with the existing source-contract test.

**Tech Stack:** Next.js 16, React 19, CSS, Node test runner, OpenAI Sites.

---

### Task 1: Add a failing shell-and-brand contract

**Files:**
- Modify: `tests/replica-surface.test.mjs`
- Test: `tests/replica-surface.test.mjs`

- [ ] **Step 1: Replace the responsive chrome assertions and add the brand assertions**

```js
test("shared chrome keeps a responsive scale on a continuous viewport background", () => {
  const css = readFileSync("app/vision-studio.css", "utf8");
  const marker = "/* Responsive display framework */";
  const responsiveLayer = css.slice(css.indexOf(marker));
  assert.match(css, /--vision-font-body:\s*clamp\(14px,/);
  assert.match(css, /--vision-content-max:\s*2200px/);
  assert.match(responsiveLayer, /--vision-workspace-offset:\s*calc\(var\(--vision-sidebar-width\) \+ 28px\)/);
  assert.match(responsiveLayer, /html, body\s*\{[^}]*margin:\s*0;[^}]*background:\s*var\(--vision-page-backdrop\);/s);
  assert.match(responsiveLayer, /\.appChrome\s*\{[^}]*background:\s*var\(--vision-page-backdrop\);/s);
  assert.doesNotMatch(responsiveLayer, /\.appChrome::before\s*\{[^}]*display:\s*block;/s);
  assert.match(responsiveLayer, /\.appChrome \.appTopbar\s*\{[^}]*top:\s*var\(--vision-topbar-inset\);[^}]*width:\s*calc\(100% - 28px\);[^}]*margin:\s*var\(--vision-topbar-inset\) 14px 0;[^}]*border-radius:\s*20px;/s);
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
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/replica-surface.test.mjs`

Expected: FAIL because the current topbar is flush, the gray overlay is enabled, the workspace gap is fluid, and both glyphs are still “镜”.

- [ ] **Step 3: Commit the failing contract**

```bash
git add tests/replica-surface.test.mjs
git commit -m "test: define floating chrome contract"
```

### Task 2: Restore the floating shell and L branding

**Files:**
- Modify: `app/vision-studio.css:808-848`
- Modify: `app/vision-studio.css:939-942`
- Modify: `app/ui/app-chrome.tsx:33-35`
- Modify: `app/login/page.tsx:21-23`
- Test: `tests/replica-surface.test.mjs`

- [ ] **Step 1: Apply the minimal final-layer CSS correction**

Use these declarations in the final responsive layer:

```css
:root {
  --vision-workspace-offset: calc(var(--vision-sidebar-width) + 28px);
}

.appChrome {
  min-height: 100dvh;
  background: var(--vision-page-backdrop);
  font-size: var(--vision-font-body);
}

.appChrome .appTopbar {
  top: var(--vision-topbar-inset);
  width: calc(100% - 28px);
  min-height: clamp(68px, 4.3vw, 76px);
  margin: var(--vision-topbar-inset) 14px 0;
  border-radius: 20px;
  padding: 10px var(--vision-page-gutter);
}

@media (max-width: 980px) {
  .appWorkspace { margin-left: 0; }
  .appChrome .appTopbar { border-radius: 16px; }
}
```

Delete the final responsive `.appChrome::before` block so the earlier `display: none` rule remains authoritative. Keep the existing `html, body { margin: 0; background: var(--vision-page-backdrop); }` rule unchanged.

- [ ] **Step 2: Change only the two brand literals**

```tsx
// app/ui/app-chrome.tsx
<span aria-hidden="true">L</span>

// app/login/page.tsx
<span>L</span>
```

- [ ] **Step 3: Run the focused test and confirm GREEN**

Run: `node --test tests/replica-surface.test.mjs`

Expected: all tests in the file pass.

- [ ] **Step 4: Commit the implementation**

```bash
git add app/vision-studio.css app/ui/app-chrome.tsx app/login/page.tsx
git commit -m "fix: restore floating workspace chrome"
```

### Task 3: Verify the exact release source

**Files:**
- No source changes expected.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Build production output**

Run: `npm run build`

Expected: Vinext production build succeeds.

- [ ] **Step 3: Check patch integrity**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and no uncommitted files.

### Task 4: Publish and verify the existing public site

**Files:**
- No source changes expected.

- [ ] **Step 1: Validate Sites readiness**

Validate `/Users/yue/Documents/CL-sites` with the Sites hosting workflow.

Expected: the project is recognized as deployable without database migration.

- [ ] **Step 2: Deploy to the existing Sites project**

Deploy `/Users/yue/Documents/CL-sites` to project `appgprj_6a8cf6302f808191a099a61f7806abee`.

Expected: a new active version is created at the unchanged public URL.

- [ ] **Step 3: Verify the live release**

Open `https://director-workbench-yue.a8197772.chatgpt.site/`, sign in through the existing app login if needed, and inspect the shared shell.

Expected: the topbar and sidebar float over a continuous light background, no top strip appears, the wide-screen gap stays fixed, and both brand surfaces show “L”.
