import { seedTestAccounts, TEST_USERNAMES } from "@/lib/account-seed";
import { normalizeUsername } from "@/lib/auth-crypto";
import { prisma } from "@/lib/prisma";

function readRotationArgument(): string | undefined {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    return undefined;
  }
  if (args.length !== 2 || args[0] !== "--rotate") {
    throw new Error("用法：npm run accounts:seed -- [--rotate tester01]");
  }

  const username = normalizeUsername(args[1]);
  if (!TEST_USERNAMES.includes(username as (typeof TEST_USERNAMES)[number])) {
    throw new Error(`未知测试账号：${args[1]}`);
  }
  return username;
}

async function main() {
  const password = process.env.TEST_ACCOUNT_INITIAL_PASSWORD;
  if (!password) {
    throw new Error("请先设置 TEST_ACCOUNT_INITIAL_PASSWORD");
  }

  const result = await seedTestAccounts(prisma, password, readRotationArgument());
  console.log(
    `测试账号已准备：共 ${TEST_USERNAMES.length} 个，新建 ${result.created} 个，接管历史项目 ${result.assignedProjects} 个。`
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
