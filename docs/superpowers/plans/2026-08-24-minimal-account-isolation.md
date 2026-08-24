# Minimal Account Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add login/logout, five seeded private-test accounts, thirty-day sessions, and server-side project isolation without changing the existing production workflow or visual language.

**Architecture:** Prisma stores users, password hashes, sessions, and project membership. Pure crypto and database services sit below a thin Next.js cookie adapter; every page, action, and download route authorizes the current session and project membership before reading or mutating data. The existing `ProjectRole` relation remains the ownership boundary so future sharing can be added without another ownership migration.

**Tech Stack:** Next.js 16 server components/actions, React 19, Prisma 6.19 with SQLite, Web Crypto PBKDF2/SHA-256, TypeScript verification scripts.

---

## File map

- `prisma/schema.prisma`: user credentials, lock state, and sessions.
- `prisma/migrations/20260824000000_minimal_account_isolation/migration.sql`: durable SQLite migration.
- `lib/auth-crypto.ts`: password hashing, session token hashing, username and return-path normalization.
- `lib/auth-service.ts`: credential validation, lockout, session lifecycle, and resource membership checks.
- `lib/auth.ts`: Next.js Cookie/redirect/not-found adapter.
- `lib/account-seed.ts`: idempotent five-account initialization and legacy-project assignment.
- `lib/project-library.ts`: user-scoped project-library query.
- `app/auth-actions.ts`: login and logout server actions.
- `app/auth/clear-session/route.ts`: remove invalid or expired browser cookies before returning to login.
- `app/login/page.tsx`, `app/login/login-form.tsx`: login surface.
- `app/ui/account-menu.tsx`, `app/ui/app-chrome.tsx`: signed-in identity and logout.
- `app/page.tsx`, project pages, `lib/studio.ts`, `lib/workflow.ts`: scoped reads and owner creation.
- `app/actions.ts`, `app/api/**/route.ts`: server-side authorization for all writes/downloads.
- `scripts/verify-auth-*.ts`, `scripts/verify-account-*.ts`: red/green verification.
- `package.json`, `.env.example`, `README.md`, `app/vision-studio.css`: scripts, operator instructions, and matching UI.

### Task 1: Add credential and session schema

**Files:**
- Create: `scripts/verify-auth-schema.ts`
- Modify: `package.json`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260824000000_minimal_account_isolation/migration.sql`

- [ ] **Step 1: Write the failing schema verification**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = readFileSync("prisma/schema.prisma", "utf8");
for (const token of [
  "username         String       @unique",
  "passwordHash     String",
  "failedLoginCount Int",
  "lockedUntil      DateTime?",
  "sessions         Session[]",
  "model Session",
  "tokenHash String   @unique",
  "expiresAt DateTime"
]) {
  assert.ok(schema.includes(token), `missing auth schema token: ${token}`);
}
console.log("auth schema verification passed");
```

Add `"verify:auth-schema": "tsx scripts/verify-auth-schema.ts"`.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm run verify:auth-schema`

Expected: FAIL with `missing auth schema token`.

- [ ] **Step 3: Add the Prisma models**

```prisma
model User {
  id               String        @id @default(cuid())
  email            String        @unique
  username         String        @unique
  passwordHash     String
  name             String?
  failedLoginCount Int           @default(0)
  lockedUntil      DateTime?
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt
  roles            ProjectRole[]
  sessions         Session[]
}

model Session {
  id        String   @id @default(cuid())
  userId    String
  tokenHash String   @unique
  createdAt DateTime @default(now())
  expiresAt DateTime
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
}
```

Generate the SQLite migration with `npx prisma migrate dev --create-only --name minimal_account_isolation`. Inspect that it rebuilds existing `User` rows with unique `legacy-<id>` usernames and an unusable empty hash, preserves `ProjectRole` references, creates `Session`, and adds all unique/index definitions before generating Prisma Client.

- [ ] **Step 4: Run schema verification and Prisma validation**

Run: `npm run verify:auth-schema && npx prisma validate && npm run prisma:generate`

Expected: all commands exit 0 and print `auth schema verification passed`.

- [ ] **Step 5: Commit**

```bash
git add package.json prisma/schema.prisma prisma/migrations/20260824000000_minimal_account_isolation scripts/verify-auth-schema.ts
git commit -m "feat: add account session schema"
```

### Task 2: Implement portable password and session primitives

**Files:**
- Create: `scripts/verify-auth-crypto.ts`
- Create: `lib/auth-crypto.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing crypto verification**

```ts
import assert from "node:assert/strict";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
  sanitizeReturnTo,
  verifyPassword
} from "@/lib/auth-crypto";

assert.equal(normalizeUsername(" Tester01 "), "tester01");
const testPassword = "private-test-password";
const first = await hashPassword(testPassword);
const second = await hashPassword(testPassword);
assert.notEqual(first, second);
assert.equal(first.includes(testPassword), false);
assert.equal(await verifyPassword(testPassword, first), true);
assert.equal(await verifyPassword("wrong", first), false);
const token = createSessionToken();
assert.notEqual(token, createSessionToken());
assert.equal(await hashSessionToken(token), await hashSessionToken(token));
assert.equal(sanitizeReturnTo("/projects/a?view=units"), "/projects/a?view=units");
for (const unsafe of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
  assert.equal(sanitizeReturnTo(unsafe), "/");
}
console.log("auth crypto verification passed");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm run verify:auth-crypto`

Expected: FAIL because `@/lib/auth-crypto` does not exist.

- [ ] **Step 3: Implement the primitives**

Implement `PBKDF2-HMAC-SHA-256` with 600,000 iterations, 16-byte salts, and the self-describing format `pbkdf2-sha256$600000$<salt>$<digest>`. Use `crypto.getRandomValues`, `crypto.subtle`, a constant-time byte comparison, 32-byte random session tokens, SHA-256 token digests, lowercase trimmed usernames, and same-origin relative return-path validation.

The exported constants are:

```ts
export const PASSWORD_ITERATIONS = 600_000;
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
```

- [ ] **Step 4: Run the verification and typecheck**

Run: `npm run verify:auth-crypto && npm run typecheck`

Expected: PASS and zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add package.json lib/auth-crypto.ts scripts/verify-auth-crypto.ts
git commit -m "feat: add account cryptography primitives"
```

### Task 3: Implement credential validation and database sessions

**Files:**
- Create: `scripts/verify-auth-service.ts`
- Create: `lib/auth-service.ts`
- Modify: `package.json`

- [ ] **Step 1: Write a failing database-service verification**

Create a temporary SQLite database with `prisma db push`, instantiate `PrismaClient({ datasourceUrl })`, and assert these behaviors against real rows:

```ts
const user = await authenticateCredentials(db, "TESTER01", "private-test-password", now);
assert.equal(user?.username, "tester01");
const session = await createSession(db, user!.id, now);
assert.equal(session.expiresAt.getTime(), now.getTime() + SESSION_DURATION_MS);
assert.equal((await resolveSessionUser(db, session.token, now))?.id, user!.id);
await revokeSession(db, session.token);
assert.equal(await resolveSessionUser(db, session.token, now), null);
```

Also assert five consecutive bad passwords set a fifteen-minute lock, errors return `null`, successful login clears prior failures, an expired session is deleted, an unknown username returns `null`, project membership is required, and an episode must belong to the authorized project.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm run verify:auth-service`

Expected: FAIL because `@/lib/auth-service` does not exist.

- [ ] **Step 3: Implement `lib/auth-service.ts`**

Export these stable interfaces:

```ts
export type SessionUser = { id: string; username: string; name: string | null };
export async function authenticateCredentials(db: PrismaClient, username: string, password: string, now?: Date): Promise<SessionUser | null>;
export async function createSession(db: PrismaClient, userId: string, now?: Date): Promise<{ token: string; expiresAt: Date }>;
export async function resolveSessionUser(db: PrismaClient, token: string, now?: Date): Promise<SessionUser | null>;
export async function revokeSession(db: PrismaClient, token: string): Promise<void>;
export async function userHasProjectAccess(db: PrismaClient, userId: string, projectId: string): Promise<boolean>;
export async function userHasEpisodeAccess(db: PrismaClient, userId: string, projectId: string, episodeId: string): Promise<boolean>;
```

Unknown, locked, and invalid-password paths perform a password verification workload and return the same result. The fifth consecutive failure stores `lockedUntil = now + 15 minutes`; a successful login clears the counters.

- [ ] **Step 4: Run RED→GREEN verification**

Run: `npm run verify:auth-service && npm run typecheck`

Expected: PASS with the temporary database removed in `finally`.

- [ ] **Step 5: Commit**

```bash
git add package.json lib/auth-service.ts scripts/verify-auth-service.ts
git commit -m "feat: add database authentication service"
```

### Task 4: Seed five accounts and assign legacy projects

**Files:**
- Create: `scripts/verify-account-seed.ts`
- Create: `lib/account-seed.ts`
- Create: `scripts/seed-test-accounts.ts`
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing seed verification**

Against a temporary database, create one project without roles, invoke `seedTestAccounts(db, "private-test-password")`, and assert:

```ts
assert.deepEqual(
  (await db.user.findMany({ orderBy: { username: "asc" } })).map((user) => user.username),
  ["tester01", "tester02", "tester03", "tester04", "tester05"]
);
assert.equal(await verifyPassword("private-test-password", tester01.passwordHash), true);
assert.equal((await db.projectRole.count({ where: { projectId, userId: tester01.id, role: "ADMIN" } })), 1);
```

Run the seed twice and prove it remains five users and one role. Create a session, rotate only `tester01`, and prove its sessions are deleted while other password hashes remain unchanged.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm run verify:account-seed`

Expected: FAIL because the seed module does not exist.

- [ ] **Step 3: Implement idempotent seeding and the operator wrapper**

```ts
export const TEST_USERNAMES = ["tester01", "tester02", "tester03", "tester04", "tester05"] as const;
export async function seedTestAccounts(db: PrismaClient, password: string, rotateUsername?: string): Promise<{ created: number; assignedProjects: number }>;
```

The wrapper requires `TEST_ACCOUNT_INITIAL_PASSWORD`, accepts optional `--rotate tester01`, never prints the password or hash, and exits nonzero for missing input or an unknown account. Add:

```json
"accounts:seed": "tsx --env-file=.env scripts/seed-test-accounts.ts"
```

Document only `TEST_ACCOUNT_INITIAL_PASSWORD=""` in `.env.example`; do not commit the real initial password.

- [ ] **Step 4: Run verification**

Run: `npm run verify:account-seed && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json .env.example lib/account-seed.ts scripts/seed-test-accounts.ts scripts/verify-account-seed.ts
git commit -m "feat: seed private test accounts"
```

### Task 5: Add login, logout, and matching account UI

**Files:**
- Create: `scripts/verify-auth-ui.ts`
- Replace: `lib/auth.ts`
- Create: `app/auth-actions.ts`
- Create: `app/auth/clear-session/route.ts`
- Create: `app/login/page.tsx`
- Create: `app/login/login-form.tsx`
- Create: `app/ui/account-menu.tsx`
- Modify: `app/ui/app-chrome.tsx`
- Modify: `app/vision-studio.css`
- Modify: `package.json`

- [ ] **Step 1: Write the failing UI/source contract verification**

Read the listed source files and assert that the login form has username/password labels, `loginAction`, a generic error region, `director_session`, `HttpOnly`, thirty-day session creation, `logoutAction`, `AccountMenu`, and `.loginShell` styles. Assert `lib/auth.ts` no longer contains `x-user-role`, `CURRENT_USER_EMAIL`, or `operator@lan.local`.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm run verify:auth-ui`

Expected: FAIL because the login files do not exist.

- [ ] **Step 3: Implement the Next.js session adapter and actions**

`lib/auth.ts` exports:

```ts
export const SESSION_COOKIE_NAME = "director_session";
export async function getCurrentUser(): Promise<SessionUser | null>;
export async function requireSessionUser(returnTo?: string): Promise<SessionUser>;
export async function requireProjectAccess(projectId: string, returnTo?: string): Promise<SessionUser>;
export async function requireEpisodeAccess(projectId: string, episodeId: string, returnTo?: string): Promise<SessionUser>;
```

`app/auth-actions.ts` validates credentials, writes an opaque `HttpOnly`, `SameSite=Lax`, production-`Secure`, 30-day Cookie, safely redirects to `returnTo`, revokes on logout, and always returns `账号或密码错误` for rejected credentials.

Database failures return `暂时无法登录，请稍后重试`. When a protected request presents an invalid or expired Cookie, `requireSessionUser` redirects through `/auth/clear-session`, whose route handler expires the Cookie and returns to `/login` with the same sanitized relative destination.

- [ ] **Step 4: Implement the login page and account menu**

Use `useActionState` in `login-form.tsx`. Preserve the existing `--vision-*` backdrop, glass, radius, shadow, primary gradient, focus states, reduced-motion behavior, and mobile width. Add `AccountMenu` to the existing sidebar footer without moving the navigation or project content.

- [ ] **Step 5: Run UI verification and build-time checks**

Run: `npm run verify:auth-ui && npm run typecheck && npm run build`

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json lib/auth.ts app/auth-actions.ts app/login app/ui/account-menu.tsx app/ui/app-chrome.tsx app/vision-studio.css scripts/verify-auth-ui.ts
git commit -m "feat: add private account login UI"
```

### Task 6: Scope project creation and reads to the signed-in user

**Files:**
- Create: `scripts/verify-account-isolation.ts`
- Create: `lib/project-library.ts`
- Modify: `lib/workflow.ts`
- Modify: `lib/studio.ts`
- Modify: `app/page.tsx`
- Modify: `app/projects/new/page.tsx`
- Modify: `app/projects/[projectId]/page.tsx`
- Modify: `app/projects/[projectId]/episodes/[episodeId]/page.tsx`
- Modify: `app/actions.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing two-user isolation verification**

Build a temporary database with two users and two projects. Assert `getProjectLibrary(userA.id, db)` lists only A, `getProjectStudio(projectB.id, userA.id, db)` returns `null`, and `getEpisodeStudio(projectB.id, episodeB.id, userA.id, db)` returns `null`. Create a project through `importProjectFromText({ ownerUserId: userA.id, ... }, db)` and assert its `ADMIN` role is committed with the project.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm run verify:account-isolation`

Expected: FAIL because the current queries are global and `ownerUserId` is absent.

- [ ] **Step 3: Implement scoped query boundaries**

```ts
export async function getProjectLibrary(userId: string, db: PrismaClient = prisma) {
  const ownership = { roles: { some: { userId } } };
  const select = {
    id: true, title: true, description: true, style: true, aspectRatio: true,
    updatedAt: true, archivedAt: true,
    _count: { select: { episodes: true, assets: true, sceneSnapshots: true } },
    episodes: {
      orderBy: { number: "asc" as const },
      select: { id: true, number: true, title: true, _count: { select: { seedanceUnits: true } } }
    }
  };
  const [projects, archivedProjects] = await Promise.all([
    db.project.findMany({ where: { ...ownership, archivedAt: null }, orderBy: { updatedAt: "desc" }, select }),
    db.project.findMany({ where: { ...ownership, archivedAt: { not: null } }, orderBy: { archivedAt: "desc" }, select })
  ]);
  return { projects, archivedProjects };
}
```

Require `ownerUserId` in both import input types and create `roles: { create: { userId: ownerUserId, role: "ADMIN" } }` in the same transaction. Add `userId` and optional `db` to both studio loaders and include the membership predicate in their first database query.

- [ ] **Step 4: Protect all page entry points**

Project library and new-project pages call `requireSessionUser`. Project and episode pages obtain the user, call the scoped studio loader, and use `notFound()` for missing or unauthorized records. The project page performs contract queries only after the scoped studio lookup succeeds.

- [ ] **Step 5: Run isolation verification**

Run: `npm run verify:account-isolation && npm run verify:project-entry && npm run verify:studio && npm run typecheck`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add package.json lib/project-library.ts lib/workflow.ts lib/studio.ts app/page.tsx app/projects app/actions.ts scripts/verify-account-isolation.ts
git commit -m "feat: isolate project reads by account"
```

### Task 7: Protect every mutation and download route

**Files:**
- Create: `scripts/verify-auth-boundaries.ts`
- Modify: `app/actions.ts`
- Modify: `app/api/task-packages/[taskPackageId]/prompt/route.ts`
- Modify: `app/api/episodes/[episodeId]/final/route.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing boundary audit**

The source audit must reject `headers()`, `getPermissions`, `requirePermission`, and `x-user-*` in `app/actions.ts`; reject `findUnique({ where: { id: taskPackageId } })` in the task-package route; and reject an episode-only final-script query. It must require `requireSessionUser`, `requireProjectAccess`, and `requireEpisodeAccess` in `app/actions.ts`, plus `project.roles.some.userId`, `401`, and `404` in both download routes.

- [ ] **Step 2: Run the audit and verify RED**

Run: `npm run verify:auth-boundaries`

Expected: FAIL on the current trusted-header and unscoped routes.

- [ ] **Step 3: Guard all server actions**

At the top of each project action, extract the submitted `projectId` and call `requireProjectAccess`; for episode actions additionally call `requireEpisodeAccess` before using `episodeId`, `issueId`, `unitId`, or `versionId`. `importProjectAction` requires only a session and passes `currentUser.id` as `ownerUserId`. Remove the global trusted-header role path completely.

Actions covered: archive, restore, delete, execution-mode change, episode preparation/start/repair/stop/reset, issue acknowledgement, single-stage runs, prompt restore/save, project preprocessing/foundation runs/stops, asset confirmation, and presentation-contract decisions.

- [ ] **Step 4: Scope download routes**

Both routes return `401` when no valid session exists. Task-package lookup uses `where: { id: taskPackageId, project: { roles: { some: { userId } } } }`; final-script lookup uses `where: { episodeId, project: { roles: { some: { userId } } } }`. Missing and unauthorized records share the existing `404` response.

- [ ] **Step 5: Run boundary and isolation tests**

Run: `npm run verify:auth-boundaries && npm run verify:account-isolation && npm run typecheck && npm run build`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add package.json app/actions.ts app/api scripts/verify-auth-boundaries.ts
git commit -m "fix: enforce account authorization boundaries"
```

### Task 8: Apply locally, seed accounts, document operation, and verify release

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `scripts/verify-ui-system.ts`

- [ ] **Step 1: Add auth checks to the full verification suite**

Append the auth verification commands to `verify:all` in dependency order: schema, crypto, service, seed, UI, isolation, boundaries. Extend UI verification to require `AccountMenu` while preserving all existing chrome tokens.

- [ ] **Step 2: Document private-test operation**

Document account names, the noncommitted seed variable, initial seeding, one-account rotation, thirty-day sessions, and the warning that the weak temporary password must be replaced before public access. Do not write the password value into tracked documentation.

- [ ] **Step 3: Back up and migrate the current local database**

Create a timestamped copy of `prisma/dev.db` outside tracked source if it exists. Run:

```bash
npx prisma migrate deploy
TEST_ACCOUNT_INITIAL_PASSWORD='<set-locally>' npm run accounts:seed
```

Expected: migrations apply, five accounts exist, legacy projects are assigned to `tester01`, and the seed output contains no password or hash.

- [ ] **Step 4: Run fresh full verification**

Run: `npm run verify:all && npm run typecheck && npm run build`

Expected: every verification prints its pass marker, TypeScript exits 0, and the production build exits 0.

- [ ] **Step 5: Inspect repository safety**

Run searches proving that the real initial password, raw session tokens, `.env`, and the database backup are not tracked; inspect `git diff --check` and `git status --short`.

- [ ] **Step 6: Commit**

```bash
git add README.md package.json scripts/verify-ui-system.ts
git commit -m "docs: document private account testing"
```

- [ ] **Step 7: Final requirements audit**

Re-read `docs/superpowers/specs/2026-08-24-minimal-account-isolation-design.md` and verify every completion criterion against fresh command output and the final diff before reporting completion.
