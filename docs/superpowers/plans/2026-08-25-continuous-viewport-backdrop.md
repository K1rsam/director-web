# Continuous Viewport Backdrop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the 14px floating chrome while removing perimeter seams and aligning the topbar with the main content.

**Architecture:** Paint the page gradient once on a fixed route-frame pseudo-element, leave all structural wrappers transparent, and keep a shallow `html` fallback color for overscroll. Use the existing CSS source-contract test to lock the shared layout without touching data or runtime behavior.

**Tech Stack:** Next.js 16, React 19, CSS, Node test runner, OpenAI Sites.

---

### Task 1: Define the viewport-background contract

**Files:**
- Modify: `tests/replica-surface.test.mjs`
- Test: `tests/replica-surface.test.mjs`

- [ ] **Step 1: Replace the old repeated-background assertions**

Replace the shared-chrome test with these background and alignment assertions while retaining the existing typography, table-scroll and no-scale assertions:

```js
assert.match(css, /html\s*\{[^}]*background:\s*var\(--vision-canvas-deep\);/s);
assert.match(css, /body\s*\{[^}]*background:\s*transparent;/s);
assert.match(css, /\.visionRouteFrame\s*\{[^}]*position:\s*relative;[^}]*isolation:\s*isolate;[^}]*background:\s*transparent;/s);
assert.match(css, /\.visionRouteFrame::before\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*-1;[^}]*inset:\s*0;[^}]*background:\s*var\(--vision-page-backdrop\);/s);
assert.match(css, /\.visionRouteFrame > div\s*\{[^}]*background:\s*transparent;/s);
assert.match(responsiveLayer, /\.appChrome\s*\{[^}]*background:\s*transparent;/s);
assert.match(css, /\.loginShell\s*\{[^}]*background:\s*transparent;/s);
assert.doesNotMatch(css, /html, body\s*\{[^}]*background:\s*var\(--vision-page-backdrop\);/s);
assert.match(responsiveLayer, /\.appChrome \.appTopbar\s*\{[^}]*top:\s*var\(--vision-topbar-inset\);[^}]*width:\s*auto;[^}]*margin:\s*var\(--vision-topbar-inset\) var\(--vision-page-gutter\) 0;[^}]*border-radius:\s*20px;/s);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/replica-surface.test.mjs`

Expected: FAIL because the current CSS repeats the gradient and uses fixed 14px horizontal topbar margins.

- [ ] **Step 3: Commit the failing contract**

Run: `git add tests/replica-surface.test.mjs && git commit -m "test: define continuous viewport backdrop"`

### Task 2: Implement the single fixed background

**Files:**
- Modify: `app/vision-studio.css`
- Test: `tests/replica-surface.test.mjs`

- [ ] **Step 1: Add the fixed backdrop and transparent wrappers**

Replace the repeated root backgrounds with:

```css
html {
  min-height: 100%;
  color-scheme: light;
  background: var(--vision-canvas-deep);
}
body {
  min-height: 100vh;
  background: transparent;
  color: var(--vision-text);
}
.visionRouteFrame {
  position: relative;
  isolation: isolate;
  min-height: 100vh;
  background: transparent;
}
.visionRouteFrame::before {
  position: fixed;
  z-index: -1;
  inset: 0;
  pointer-events: none;
  background: var(--vision-page-backdrop);
  content: "";
}
.visionRouteFrame > div {
  min-height: 100vh;
  background: transparent;
}
.appChrome,
.loginShell {
  background: transparent;
}
```

In the responsive layer, keep only the margin and sizing declaration on `html, body`, then explicitly retain the shallow `html` fallback and transparent `body`/`.appChrome` backgrounds.

- [ ] **Step 2: Align the topbar with the content gutter**

Use the following responsive topbar block:

```css
.appChrome .appTopbar {
  top: var(--vision-topbar-inset);
  width: auto;
  min-height: clamp(68px, 4.3vw, 76px);
  margin: var(--vision-topbar-inset) var(--vision-page-gutter) 0;
  border-radius: 20px;
  padding: 10px var(--vision-page-gutter);
}
```

- [ ] **Step 3: Run the focused test and confirm GREEN**

Run: `node --test tests/replica-surface.test.mjs`

Expected: all focused tests pass.

- [ ] **Step 4: Commit the implementation**

Run: `git add app/vision-studio.css && git commit -m "fix: unify viewport backdrop"`

### Task 3: Validate and publish

**Files:**
- No database or migration changes.

- [ ] **Step 1: Run the complete verification**

Run: `npm test && npm run build && git diff --check`

Expected: all tests pass, the production build succeeds, and no whitespace errors are reported.

- [ ] **Step 2: Publish the exact validated source**

Deploy the new version to the existing public Sites project without changing D1 or access settings.

- [ ] **Step 3: Verify the live shared shell**

Check the unchanged public URL at the top of the project library and project workbench. Expected: continuous top/perimeter background and aligned topbar/content edges.
