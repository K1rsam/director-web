import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runDeepSeekJson } from "@/lib/deepseek-api";
import {
  decryptSecret,
  deleteDeepSeekCredential,
  encryptSecret,
  getDeepSeekCredentialStatus,
  getProjectDeepSeekCredential,
  maskApiKey,
  normalizeDeepSeekBase,
  saveDeepSeekCredential,
  testDeepSeekConnection
} from "@/lib/provider-credentials";
import { prisma } from "@/lib/prisma";

process.env.DIRECTOR_CREDENTIAL_KEY ||= "provider-credential-verifier-only-key-2026";

async function main(): Promise<void> {
const apiKey = "sk-test-provider-key-1234567890";
const encrypted = encryptSecret(apiKey);
const encryptedAgain = encryptSecret(apiKey);
assert.notEqual(encrypted, encryptedAgain, "加密凭证必须使用随机 IV");
assert.equal(decryptSecret(encrypted), apiKey, "加密凭证无法正确解密");
assert(!encrypted.includes(apiKey), "密文不能包含明文 API Key");
assert.equal(maskApiKey(apiKey), "••••••7890");
assert.equal(normalizeDeepSeekBase("https://api.deepseek.com///"), "https://api.deepseek.com");
assert.throws(() => normalizeDeepSeekBase("file:///tmp/key"), /http\(s\)/);

const successfulFetch: typeof fetch = async (input, init) => {
  assert(String(input).endsWith("/models"), "连接测试必须请求 /models");
  assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${apiKey}`);
  return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
const connection = await testDeepSeekConnection(
  { apiKey, apiBase: "https://api.deepseek.com/", model: "deepseek-chat" },
  successfulFetch
);
assert.deepEqual(connection.models, ["deepseek-chat", "deepseek-reasoner"]);

await assert.rejects(
  () => testDeepSeekConnection({ apiKey, apiBase: "https://api.deepseek.com" }, async () => new Response("", { status: 401 })),
  /无效或没有访问权限/
);

const testUserId = randomUUID();
const testProjectId = randomUUID();
const otherUserId = randomUUID();
const otherProjectId = randomUUID();
try {
  await prisma.user.create({
    data: {
      id: testUserId,
      email: `${testUserId}@provider-test.local`,
      username: `provider_${testUserId.replaceAll("-", "").slice(0, 20)}`,
      passwordHash: "test-only",
      name: "provider credential verifier"
    }
  });
  await prisma.project.create({ data: { id: testProjectId, title: "provider credential verifier" } });
  await prisma.projectRole.create({ data: { userId: testUserId, projectId: testProjectId, role: "ADMIN" } });
  await saveDeepSeekCredential(
    testUserId,
    { apiKey, apiBase: connection.apiBase, model: "deepseek-chat" },
    connection
  );

  const status = await getDeepSeekCredentialStatus(testUserId);
  assert.equal(status.connected, true);
  assert.equal(status.keyHint, "••••••7890");
  assert.equal(status.apiBase, "https://api.deepseek.com");
  const projectCredential = await getProjectDeepSeekCredential(testProjectId);
  assert.deepEqual(projectCredential, { apiKey, apiBase: "https://api.deepseek.com", model: "deepseek-chat" });
  const stored = await prisma.userProviderCredential.findUnique({ where: { userId_provider: { userId: testUserId, provider: "DEEPSEEK" } } });
  assert(stored && !stored.apiKeyCiphertext.includes(apiKey), "数据库不能保存 API Key 明文");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert(String(input) === "https://api.deepseek.com/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${apiKey}`);
    return new Response(JSON.stringify({
      id: "provider-test",
      choices: [{ message: { content: '{"connected":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const execution = await runDeepSeekJson<{ connected: boolean }>({
      projectId: testProjectId,
      prompt: "return a JSON object",
      model: "deepseek-chat"
    });
    assert.deepEqual(execution.data, { connected: true }, "项目 API 执行没有读取账号凭证");
  } finally {
    globalThis.fetch = originalFetch;
  }

  await prisma.user.create({
    data: {
      id: otherUserId,
      email: `${otherUserId}@provider-test.local`,
      username: `provider_other_${otherUserId.replaceAll("-", "").slice(0, 16)}`,
      passwordHash: "test-only",
      name: "other provider verifier"
    }
  });
  await prisma.project.create({ data: { id: otherProjectId, title: "other provider verifier" } });
  await prisma.projectRole.create({ data: { userId: otherUserId, projectId: otherProjectId, role: "ADMIN" } });
  assert.equal(await getProjectDeepSeekCredential(otherProjectId), null, "账号之间不能共享 API 凭证");
} finally {
  await deleteDeepSeekCredential(testUserId).catch(() => undefined);
  await prisma.project.deleteMany({ where: { id: testProjectId } });
  await prisma.project.deleteMany({ where: { id: otherProjectId } });
  await prisma.user.deleteMany({ where: { id: testUserId } });
  await prisma.user.deleteMany({ where: { id: otherUserId } });
  await prisma.$disconnect();
}

console.log("provider credentials: encryption, validation, mocked /models, account storage and project lookup passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

