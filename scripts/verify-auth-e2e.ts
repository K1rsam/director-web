import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Browser } from "playwright";
import { seedTestAccounts } from "@/lib/account-seed";
import { migrateDatabase } from "@/lib/database-migration";

const TEST_PASSWORD = "private-e2e-password";

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForServer(baseUrl: string, server: ChildProcess, readLogs: () => string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`测试网站提前退出。\n${readLogs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // 网站仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待测试网站启动超时。\n${readLogs()}`);
}

function browserLaunchOptions() {
  if (existsSync(chromium.executablePath())) return {};
  for (const executablePath of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ]) {
    if (existsSync(executablePath)) return { executablePath };
  }
  throw new Error("未找到 Chromium/Chrome；请先安装 Playwright Chromium 后重试。");
}

async function stopServer(server: ChildProcess) {
  if (!server.pid || server.exitCode !== null) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => server.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000))
  ]);
  if (server.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      server.kill("SIGKILL");
    }
  }
}

async function main() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "director-auth-e2e-"));
  const databaseUrl = `file:${join(temporaryDirectory, "e2e.db")}`;
  let browser: Browser | null = null;
  let server: ChildProcess | null = null;
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  let serverLogs = "";

  try {
    await migrateDatabase({
      databaseUrl,
      schemaPath: join(process.cwd(), "prisma/schema.prisma"),
      quiet: true
    });
    await seedTestAccounts(db, TEST_PASSWORD);
    const tester01 = await db.user.findUniqueOrThrow({ where: { username: "tester01" } });
    const tester02 = await db.user.findUniqueOrThrow({ where: { username: "tester02" } });
    const owned = await db.project.create({
      data: {
        title: "账号一专属项目",
        roles: { create: { userId: tester01.id, role: "ADMIN" } },
        episodes: { create: { number: 1, title: "账号一第一集", content: "测试正文" } }
      },
      include: { episodes: true }
    });
    const foreign = await db.project.create({
      data: {
        title: "账号二专属项目",
        roles: { create: { userId: tester02.id, role: "ADMIN" } },
        episodes: { create: { number: 1, title: "账号二第一集", content: "私有正文" } }
      },
      include: { episodes: true }
    });
    const ownedEpisode = owned.episodes[0];
    const foreignEpisode = foreign.episodes[0];
    assert.ok(ownedEpisode && foreignEpisode);
    const foreignTaskPackage = await db.taskPackage.create({
      data: {
        projectId: foreign.id,
        episodeId: foreignEpisode.id,
        title: "账号二任务包",
        payload: "{}"
      }
    });
    await db.finalScript.createMany({
      data: [
        {
          projectId: owned.id,
          episodeId: ownedEpisode.id,
          version: 1,
          content: "账号一最终稿"
        },
        {
          projectId: foreign.id,
          episodeId: foreignEpisode.id,
          version: 1,
          content: "账号二最终稿"
        }
      ]
    });

    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [require.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          NEXT_TELEMETRY_DISABLED: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    for (const output of [server.stdout, server.stderr]) {
      output?.on("data", (chunk) => {
        serverLogs = `${serverLogs}${String(chunk)}`.slice(-12_000);
      });
    }
    await waitForServer(baseUrl, server, () => serverLogs);

    browser = await chromium.launch({ headless: true, ...browserLaunchOptions() });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(baseUrl);
    assert.equal(new URL(page.url()).pathname, "/login");
    assert.equal(
      (await context.request.get(
        `${baseUrl}/api/episodes/${foreignEpisode.id}/final`
      )).status(),
      401
    );

    await page.getByLabel("账号").fill("tester01");
    await page.getByLabel("密码").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "进入工作台" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    assert.equal(await page.getByText("账号一专属项目", { exact: true }).count(), 1);
    assert.equal(await page.getByText("账号二专属项目", { exact: true }).count(), 0);

    const sessionCookie = (await context.cookies()).find(
      (cookie) => cookie.name === "director_session"
    );
    assert.ok(sessionCookie?.httpOnly);
    assert.equal(sessionCookie.sameSite, "Lax");
    assert.ok(sessionCookie.expires * 1_000 - Date.now() > 29 * 24 * 60 * 60 * 1_000);

    const foreignPageResponse = await page.goto(`${baseUrl}/projects/${foreign.id}`);
    assert.equal(foreignPageResponse?.status(), 404);
    assert.equal(
      (await context.request.get(
        `${baseUrl}/api/task-packages/${foreignTaskPackage.id}/prompt`
      )).status(),
      404
    );
    assert.equal(
      (await context.request.get(
        `${baseUrl}/api/episodes/${foreignEpisode.id}/final`
      )).status(),
      404
    );
    const ownedDownload = await context.request.get(
      `${baseUrl}/api/episodes/${ownedEpisode.id}/final`
    );
    assert.equal(ownedDownload.status(), 200);
    assert.equal(await ownedDownload.text(), "账号一最终稿");

    await page.goto(baseUrl);
    const ownedCard = page.locator("article.projectCard").filter({ hasText: "账号一专属项目" });
    await ownedCard.locator("summary").click();
    await ownedCard.locator('input[name="projectId"]').evaluate(
      (input, projectId) => {
        (input as HTMLInputElement).value = projectId;
      },
      foreign.id
    );
    await ownedCard.getByRole("button", { name: "归档项目" }).click();
    await page.waitForTimeout(500);
    assert.equal(
      (await db.project.findUniqueOrThrow({ where: { id: foreign.id } })).archivedAt,
      null
    );
    assert.equal(
      (await db.project.findUniqueOrThrow({ where: { id: owned.id } })).archivedAt,
      null
    );

    await page.goto(baseUrl);
    const refreshedOwnedCard = page
      .locator("article.projectCard")
      .filter({ hasText: "账号一专属项目" });
    await refreshedOwnedCard.locator("summary").click();
    await refreshedOwnedCard.getByRole("button", { name: "归档项目" }).click();
    await page.waitForTimeout(500);
    assert.ok((await db.project.findUniqueOrThrow({ where: { id: owned.id } })).archivedAt);

    await page.getByRole("button", { name: "退出登录" }).first().click();
    await page.waitForURL((url) => url.pathname === "/login");
    assert.equal(
      (await context.cookies()).some((cookie) => cookie.name === "director_session"),
      false
    );
    assert.equal(await db.session.count({ where: { userId: tester01.id } }), 0);

    console.log("auth end-to-end verification passed");
  } catch (error) {
    if (serverLogs) console.error(serverLogs);
    throw error;
  } finally {
    await browser?.close();
    if (server) await stopServer(server);
    await db.$disconnect();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
