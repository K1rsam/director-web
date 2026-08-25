# Original Project Sites Replica Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the control-plane prototype with the original application's login, data, routes, and UI on Sites/D1, while making every not-yet-connected execution control explicit.

**Architecture:** Keep `/Users/yue/Documents/CL` as the immutable UI and behavior reference. Copy its UI files verbatim where they are runtime-neutral, replace Prisma with focused D1 repositories, and import the existing SQLite rows through a one-time authenticated HTTPS importer. Sites owns accounts, pages, CRUD, and D1; `/runner` remains a settings surface, while API execution and CLI result synchronization are separate follow-up plans.

**Tech Stack:** Vinext/Next.js 16, React 19, Cloudflare D1, raw D1 prepared statements plus Drizzle for Runner tables, Web Crypto, Node test runner, Sites hosting.

---

## Scope boundary

This plan delivers a complete, independently deployable replica for login, old data, project creation, project library, project detail, episode detail, exports, and non-model CRUD. Model/API execution and Codex CLI result synchronization are excluded from this phase; their existing buttons remain visually faithful but disabled with a visible reason. They receive two separate plans only after this phase is live.

## File map

- `drizzle/0001_original_business_schema.sql`: the 21 original business tables and indexes, copied from the existing SQLite schema.
- `drizzle/0002_runner_project_fk.sql`: preserves prototype rows as legacy tables and reconnects active Runner jobs to `Project`.
- `db/business-schema.ts`: table/column allowlists used by import and repositories.
- `lib/d1-query.ts`: bounded helpers for prepared D1 queries and batches.
- `lib/repositories/auth.ts`: users, sessions, and project authorization.
- `lib/repositories/projects.ts`: project library, creation, archive, restore, delete, and mode changes.
- `lib/repositories/project-studio.ts`: project-detail read model and ordinary project actions.
- `lib/repositories/episode-studio.ts`: episode-detail read model, issue/prompt edits, and exports.
- `app/api/admin/import/route.ts`, `scripts/import-original-database.mjs`: one-time authenticated data transfer; disabled when the import secret is absent.
- Original `app/**` UI files and `app/globals.css`: copied from `/Users/yue/Documents/CL` and changed only at data/execution boundaries.
- `app/runner/**`, `lib/runner-*.ts`: retained, rebased from anonymous identity to the original application account.

### Task 1: Prove and create full D1 schema parity

**Files:**
- Create: `tests/schema-parity.test.mjs`
- Create: `scripts/export-original-schema.mjs`
- Create: `drizzle/0001_original_business_schema.sql`
- Create: `drizzle/0002_runner_project_fk.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `db/business-schema.ts`

- [ ] **Step 1: Write the failing schema-parity test**

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("D1 migration contains every original business table", () => {
  const source = execFileSync("sqlite3", ["-readonly", "../CL/prisma/dev.db",
    "SELECT name FROM sqlite_master WHERE type='table' AND name <> '_prisma_migrations' ORDER BY name;"],
    { encoding: "utf8" }).trim().split("\n");
  const sql = readFileSync("drizzle/0001_original_business_schema.sql", "utf8");
  for (const table of source) assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS "${table}"`), table);
  assert.equal(source.length, 21);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/schema-parity.test.mjs`

Expected: FAIL because `drizzle/0001_original_business_schema.sql` does not exist.

- [ ] **Step 3: Add the deterministic schema exporter and generate migration 0001**

`scripts/export-original-schema.mjs` must read `sqlite_master.sql`, tables first and indexes second, exclude `_prisma_migrations`, replace only the first `CREATE TABLE` with `CREATE TABLE IF NOT EXISTS`, and write no row data. Run it against `/Users/yue/Documents/CL/prisma/dev.db` to generate `drizzle/0001_original_business_schema.sql`.

Create `db/business-schema.ts` with the exact 21-name allowlist:

```ts
export const BUSINESS_TABLES = [
  "ApiRoleSession", "Asset", "CliRoleSession", "CompiledPromptVersion", "Episode",
  "FinalScript", "GenerationRun", "PipelineRun", "PresentationContract", "Project",
  "ProjectRole", "ReviewRound", "SceneSnapshot", "ScriptScene", "SeedanceUnit",
  "SeedanceUnitShot", "Session", "StoryboardShot", "TaskPackage", "User", "WorkflowIssue",
] as const;
export type BusinessTable = (typeof BUSINESS_TABLES)[number];
```

`0002_runner_project_fk.sql` must first rename `runner_jobs` to `prototype_runner_jobs`, then rename `projects` to `prototype_projects`, and finally recreate `runner_jobs` with `project_id TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE`. Preserve `runner_tokens`. Add both migration tags to `drizzle/meta/_journal.json` in ascending order.

- [ ] **Step 4: Verify GREEN and migration safety**

Run: `node --test tests/schema-parity.test.mjs`

Expected: PASS with 21 source tables found.

Run: `rg -n 'INSERT INTO|passwordHash' drizzle/0001_original_business_schema.sql`

Expected: no output; migrations contain schema only.

- [ ] **Step 5: Commit**

```bash
git add tests/schema-parity.test.mjs scripts/export-original-schema.mjs drizzle db/business-schema.ts
git commit -m "feat: mirror original schema in D1"
```

### Task 2: Add a secure, removable data importer

**Files:**
- Create: `lib/import-contract.ts`
- Create: `tests/import-contract.test.ts`
- Create: `app/api/admin/import/route.ts`
- Create: `scripts/import-original-database.mjs`
- Modify: `db/env.d.ts`

- [ ] **Step 1: Write failing import-contract tests**

Test that only names in `BUSINESS_TABLES` are accepted, batches over 50 rows are rejected, row values must be JSON scalars/null, and the token never appears in errors.

```ts
assert.deepEqual(parseImportBatch({ table: "Project", rows: [{ id: "p1", title: "A" }] }), {
  table: "Project", rows: [{ id: "p1", title: "A" }],
});
assert.throws(() => parseImportBatch({ table: "runner_tokens", rows: [] }), /不允许导入/);
assert.throws(() => parseImportBatch({ table: "Project", rows: Array(51).fill({ id: "p" }) }), /最多 50/);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/import-contract.test.ts`

Expected: FAIL because `parseImportBatch` is missing.

- [ ] **Step 3: Implement the contract, endpoint, and local sender**

`POST /api/admin/import` must return 404 when `DIRECTOR_IMPORT_TOKEN` is unset, compare only SHA-256 token hashes, validate the table allowlist, obtain permitted columns from `PRAGMA table_info(<allowlisted table>)`, quote identifiers, and execute `INSERT OR REPLACE` through `D1Database.batch`. `GET` with the same bearer token returns per-table counts.

`scripts/import-original-database.mjs` must use `sqlite3 -readonly -json`, send at most 50 rows per request, preserve values unchanged, and process tables in this exact foreign-key-safe order: `User`, `Project`, `Episode`, `ProjectRole`, `Session`, `ScriptScene`, `StoryboardShot`, `SeedanceUnit`, `SeedanceUnitShot`, `CompiledPromptVersion`, `WorkflowIssue`, `PipelineRun`, `PresentationContract`, `CliRoleSession`, `ApiRoleSession`, `Asset`, `SceneSnapshot`, `TaskPackage`, `GenerationRun`, `ReviewRound`, `FinalScript`. Within `Asset`, rows with `parentId = null` are sent before descendants. It then compares every remote count with its local count. It receives only:

```text
DIRECTOR_SITE_URL
DIRECTOR_IMPORT_TOKEN
DIRECTOR_SOURCE_DB
```

- [ ] **Step 4: Run tests and a local dry run**

Run: `node --test tests/import-contract.test.ts`

Expected: PASS.

Run: `DIRECTOR_SOURCE_DB=/Users/yue/Documents/CL/prisma/dev.db node scripts/import-original-database.mjs --dry-run`

Expected: `21 tables, 4568 rows, no data sent`.

- [ ] **Step 5: Commit**

```bash
git add lib/import-contract.ts tests/import-contract.test.ts app/api/admin/import/route.ts scripts/import-original-database.mjs db/env.d.ts
git commit -m "feat: add authenticated D1 importer"
```

### Task 3: Restore original application authentication

**Files:**
- Copy from original and adapt: `lib/auth-crypto.ts`, `lib/auth.ts`, `app/auth-actions.ts`, `app/login/page.tsx`, `app/login/login-form.tsx`, `app/auth/clear-session/route.ts`, `app/ui/account-menu.tsx`
- Create: `lib/repositories/auth.ts`
- Create: `tests/auth-d1.test.ts`
- Remove after replacement: `lib/public-session.ts`, `lib/site-user.ts`, `app/chatgpt-auth.ts`, `app/session/start/route.ts`, `tests/public-session.test.ts`

- [ ] **Step 1: Write failing tests for an existing password hash and session lifecycle**

Use one existing `pbkdf2-sha256$600000$...` test fixture created inside the test, a fake prepared-statement D1 adapter, and assert: normalized username lookup, five failed attempts lock for 15 minutes, session tokens are stored only as SHA-256 hashes, expired sessions resolve to null, and project access requires `ProjectRole`.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/auth-d1.test.ts`

Expected: FAIL because `lib/repositories/auth.ts` is missing.

- [ ] **Step 3: Implement D1 auth and port the original UI**

Preserve cookie name `director_session`, 30-day expiry, PBKDF2-SHA256 with 600,000 iterations, safe `returnTo`, generic login failures, and the original `/login` visuals. Replace Node `Buffer` base64url helpers with `btoa`/`atob` helpers compatible with Workers. No code may import `app/chatgpt-auth.ts` or use `/signin-with-chatgpt`.

Runner server actions must call `requireSessionUser()` and use `user.id` as `ownerUserId`.

- [ ] **Step 4: Verify auth and remove anonymous identity**

Run: `node --test tests/auth-d1.test.ts tests/runner-auth.test.ts`

Expected: PASS.

Run: `rg -n 'signin-with-chatgpt|requireSiteUser|director_visitor' app lib`

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add app lib tests
git commit -m "feat: restore application accounts on D1"
```

### Task 4: Restore original shared UI, library, and project creation

**Files:**
- Copy verbatim from original: `app/globals.css`, `app/vision-studio.css`, `app/layout.tsx`, `app/delete-project-button.tsx`, `app/mode-switch.tsx`, `app/ui/app-chrome.tsx`, `app/ui/page-transition.tsx`, `app/ui/workflow-guidance.tsx`, `app/projects/new/page.tsx`, `app/projects/new/project-create-form.tsx`
- Replace from original then adapt data boundary: `app/page.tsx`, `app/actions.ts`, `lib/project-entry.ts`, `lib/import-script.ts`, `lib/project-library.ts`
- Create: `lib/d1-query.ts`, `lib/repositories/projects.ts`, `tests/project-repository.test.ts`, `tests/replica-surface.test.mjs`

- [ ] **Step 1: Write failing repository and surface tests**

Assert `listProjectLibrary(userId)` returns only projects joined through `ProjectRole`, with episode/asset/snapshot counts and archived separation. Assert `createProjectFromText` writes `Project`, `ProjectRole`, `Episode`, and parsed `ScriptScene` rows in one `D1.batch`, then returns `/projects/<id>`. Surface assertions require the original classes `projectLibrary`, `projectCardGrid`, `topbarPrimary`, and the four main route files.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/project-repository.test.ts tests/replica-surface.test.mjs`

Expected: FAIL because repositories and original UI are absent.

- [ ] **Step 3: Port files and implement project D1 operations**

Use prepared statements only. `createProjectFromText` reuses the original pure parsing functions and writes the same IDs/defaults/relations as the Prisma implementation. Preserve archive, restore, delete, execution-mode validation, and project-role checks. Plain text paste and `.txt` uploads work in this phase; `.docx` submission returns the explicit original-form error `DOCX 导入将在本地 Runner 接通后开放，请先粘贴剧本文本。` rather than silently failing.

Remove the control-plane project form and every “创建连通测试任务” control from `/`; the original project card is a real link to `/projects/[projectId]`.

- [ ] **Step 4: Verify project behavior**

Run: `node --test tests/project-repository.test.ts tests/replica-surface.test.mjs`

Expected: PASS.

Run: `npm run build`

Expected: successful build containing `/login`, `/`, `/projects/new`, and `/projects/[projectId]`.

- [ ] **Step 5: Commit**

```bash
git add app lib tests
git commit -m "feat: restore project library and creation"
```

### Task 5: Restore the original project-detail workspace

**Files:**
- Copy verbatim from original: `app/projects/[projectId]/asset-index-tabs.tsx`, `foundation-actions.tsx`, `presentation-contracts.tsx`, `project-bible-viewer.tsx`, `scene-structure-table.tsx`, `stop-foundation-button.tsx`
- Replace from original then adapt reads: `app/projects/[projectId]/page.tsx`
- Create: `lib/repositories/project-studio.ts`, `tests/project-studio.test.ts`
- Adapt pure helpers from original: `lib/studio.ts`, `lib/ui-guidance.ts`, `lib/scene-structure.ts`, `lib/assets.ts`

- [ ] **Step 1: Write the failing project-studio shape test**

For a fixed D1 fixture, assert the returned read model contains project metadata, episodes/scenes, asset index, P1/P2 runs, pending/confirmed presentation contracts, phase readiness, and counts in exactly the keys consumed by the original page.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/project-studio.test.ts`

Expected: FAIL because `getProjectStudio` is missing.

- [ ] **Step 3: Port UI and implement bounded D1 queries**

Keep original JSX and CSS unchanged. Replace only Prisma calls with `getProjectStudio`, `listPresentationContracts`, `confirmAllAssets`, `decidePresentationContract`, and `skipPresentationContract`. Foundation/P1/P2 controls render in their original positions but are disabled with `title="本地 Runner 执行将在下一阶段接通"`; they must not submit a fake task.

- [ ] **Step 4: Verify project workspace**

Run: `node --test tests/project-studio.test.ts tests/replica-surface.test.mjs`

Expected: PASS.

Run: `npm run build`

Expected: successful dynamic `/projects/[projectId]` route.

- [ ] **Step 5: Commit**

```bash
git add app/projects lib tests/project-studio.test.ts
git commit -m "feat: restore project workspace"
```

### Task 6: Restore episode workspace, edits, and exports

**Files:**
- Copy verbatim from original: `copy-prompt-button.tsx`, `episode-info-panel.tsx`, `episode-pipeline-button.tsx`, `export-episode.tsx`, `reset-episode-button.tsx`, `stop-pipeline-button.tsx`, `unit-prompt-card.tsx`, `workspace-grid.tsx` under `app/projects/[projectId]/episodes/[episodeId]/`
- Replace then adapt reads: `app/projects/[projectId]/episodes/[episodeId]/page.tsx`
- Copy then adapt: `app/api/episodes/[episodeId]/final/route.ts`, `app/api/task-packages/[taskPackageId]/prompt/route.ts`
- Create: `lib/repositories/episode-studio.ts`, `tests/episode-studio.test.ts`
- Reuse original pure helpers: `lib/shot-cells.ts`, `lib/task-package.ts`, `lib/episode-pipeline-contracts.ts`

- [ ] **Step 1: Write the failing episode-studio shape and mutation tests**

Assert the read model contains episode navigation, scenes/shots, units/unit-shots, prompt versions, task packages, issues, runs, assets, and info package. Assert ordinary mutations enforce project/episode ownership and correctly update issue status, prompt selection/manual versions, and reset-related rows.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/episode-studio.test.ts`

Expected: FAIL because the episode repository is missing.

- [ ] **Step 3: Port UI and implement D1 reads/mutations**

Keep the original workspace grid, tabs, prompt cards, issue cards, and export controls. Connect read-only exports and ordinary D1 edits. Disable E0–E5 run/repair/stop buttons with `title="执行引擎将在 API/Runner 阶段接通"`; preserve active historical run/status display from imported data.

- [ ] **Step 4: Verify episode workspace and exports**

Run: `node --test tests/episode-studio.test.ts tests/replica-surface.test.mjs`

Expected: PASS.

Run: `npm run build`

Expected: successful episode route plus both export API routes.

- [ ] **Step 5: Commit**

```bash
git add app/projects app/api lib tests/episode-studio.test.ts
git commit -m "feat: restore episode workspace"
```

### Task 7: Rebase Runner settings onto application accounts

**Files:**
- Modify: `app/runner/page.tsx`, `app/runner/token-form.tsx`, `app/actions.ts`
- Modify: `db/schema.ts`, `db/ensure-schema.ts`, `lib/runner-api.ts`, `runner/index.mjs`, `runner/commands.mjs`
- Modify: `tests/runner-auth.test.ts`, `tests/runner-contract.test.ts`, `tests/runner-commands.test.mjs`

- [ ] **Step 1: Add a failing ownership test**

Assert a Runner bearer token resolves to an original `User.id`, can claim only that user's `ProjectRole` projects, and cannot claim prototype or another account's jobs.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/runner-*.test.*`

Expected: FAIL while the control plane still assumes its prototype project table/identity.

- [ ] **Step 3: Implement account-bound Runner settings**

Use `requireSessionUser("/runner")`; list and revoke only the signed-in user's tokens; validate job project ownership through `ProjectRole`; keep fixed command allowlists and shell-free spawning. Put the Runner link in the original account menu instead of replacing the project homepage.

- [ ] **Step 4: Verify Runner security**

Run: `node --test tests/runner-*.test.*`

Expected: PASS with unknown commands rejected and cross-user claims denied.

- [ ] **Step 5: Commit**

```bash
git add app/runner app/actions.ts db/schema.ts db/ensure-schema.ts lib/runner-api.ts runner tests
git commit -m "feat: bind Runner settings to app accounts"
```

### Task 8: Deploy schema, import old data, and verify the replica

**Files:**
- Modify only if verification finds a real defect: files from Tasks 1–7

- [ ] **Step 1: Run the complete local gate**

Run: `npm test`

Expected: all tests pass with zero failures.

Run: `npm run build`

Expected: build succeeds and lists all original routes plus `/runner` and the importer.

- [ ] **Step 2: Save and deploy the validated version publicly**

Use the existing Sites project from `.openai/hosting.json`, package the successful build, save one version, and deploy it to the already-public access policy. Do not create another Site.

- [ ] **Step 3: Perform the one-time authenticated import**

Generate a random one-time `DIRECTOR_IMPORT_TOKEN`, set it as a Sites secret, then run:

```bash
DIRECTOR_SOURCE_DB=/Users/yue/Documents/CL/prisma/dev.db \
DIRECTOR_SITE_URL=https://director-workbench-yue.a8197772.chatgpt.site \
DIRECTOR_IMPORT_TOKEN="$DIRECTOR_IMPORT_TOKEN" \
node scripts/import-original-database.mjs
```

Expected: `21 tables, 4568 rows, counts match`.

Remove the hosted `DIRECTOR_IMPORT_TOKEN` immediately after the count check so the endpoint returns 404.

- [ ] **Step 4: Run the user-visible acceptance path**

In a fresh browser session verify: public URL opens the original `/login` rather than ChatGPT; an original test account sees only its projects; a project card navigates to project detail; an episode navigates to its workspace; creating a text project redirects to its detail page; disabled execution controls explain their exact next phase; `/runner` is reachable only after app login.

- [ ] **Step 5: Final verification commit if needed**

If verification required source changes, rerun `npm test` and `npm run build`, commit only those verified fixes, save one new version, and redeploy. If no source change was needed, do not create an empty commit or redundant deployment.

## Follow-up plans after Phase 1

1. `api-execution-on-sites`: server-side API Provider calls, persisted stage checkpoints, retries, and API-mode UI controls.
2. `cli-runner-result-sync`: project snapshot handoff, Codex CLI execution, validated D1 mutation payloads, cancellation, and resumable status.
