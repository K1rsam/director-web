import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { getProjectLibrary } from "@/lib/project-library";
import { getEpisodeStudio, getProjectStudio } from "@/lib/studio";
import { importProjectFromText } from "@/lib/workflow";

async function main() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "director-account-isolation-"));
  const datasourceUrl = `file:${join(temporaryDirectory, "isolation.db")}`;
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: datasourceUrl, RUST_LOG: "info" },
    stdio: "pipe"
  });

  const db = new PrismaClient({ datasourceUrl });
  try {
    const [userA, userB] = await Promise.all([
      db.user.create({
        data: {
          username: "tester-a",
          email: "tester-a@local.invalid",
          passwordHash: "disabled"
        }
      }),
      db.user.create({
        data: {
          username: "tester-b",
          email: "tester-b@local.invalid",
          passwordHash: "disabled"
        }
      })
    ]);
    const projectA = await db.project.create({
      data: {
        title: "账号 A 项目",
        roles: { create: { userId: userA.id, role: "ADMIN" } },
        episodes: { create: { number: 1, title: "A 第一集", content: "第一场" } }
      },
      include: { episodes: true }
    });
    const projectB = await db.project.create({
      data: {
        title: "账号 B 项目",
        roles: { create: { userId: userB.id, role: "ADMIN" } },
        episodes: { create: { number: 1, title: "B 第一集", content: "第一场" } }
      },
      include: { episodes: true }
    });

    const libraryA = await getProjectLibrary(userA.id, db);
    assert.deepEqual(libraryA.projects.map((project) => project.id), [projectA.id]);
    assert.equal(await getProjectStudio(projectB.id, userA.id, db), null);
    assert.equal(
      await getEpisodeStudio(projectB.id, projectB.episodes[0].id, userA.id, db),
      null
    );
    assert.equal((await getProjectStudio(projectA.id, userA.id, db))?.project.id, projectA.id);

    const imported = await importProjectFromText(
      {
        ownerUserId: userA.id,
        title: "新导入项目",
        sourceName: "test.txt",
        sourceText: "第1集\n1-1 日 内 客厅\n角色甲走进房间。"
      },
      db
    );
    assert.equal(
      await db.projectRole.count({
        where: { projectId: imported.project.id, userId: userA.id, role: "ADMIN" }
      }),
      1
    );
    assert.equal(await db.projectRole.count({ where: { projectId: imported.project.id } }), 1);

    console.log("account isolation verification passed");
  } finally {
    await db.$disconnect();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
