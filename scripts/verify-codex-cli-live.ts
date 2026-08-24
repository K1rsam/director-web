/**
 * 显式真实冒烟：会消耗一次很小的 Codex CLI 调用，因此不加入 verify:all。
 * 只验证登录、结构化输出与临时会话，不读写项目数据库。
 */
import assert from "node:assert/strict";
import { assertCodexCliReady, runCodexJson } from "@/lib/codex-cli";

void (async () => {
  const readiness = await assertCodexCliReady();
  const result = await runCodexJson<{ ok: boolean; transport: string }>({
    prompt: "这是 Codex CLI 真实冒烟测试。不要调用工具，只返回符合 schema 的 JSON。transport 必须为 cli。",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "transport"],
      properties: {
        ok: { type: "boolean", const: true },
        transport: { type: "string", const: "cli" }
      }
    },
    model: process.env.CLI_SMOKE_MODEL ?? "gpt-5.6-luna",
    reasoningEffort: "low",
    cwd: process.cwd(),
    timeoutMs: 3 * 60_000,
    ephemeral: true
  });

  assert.deepEqual(result.data, { ok: true, transport: "cli" });
  console.log(JSON.stringify({
    ok: true,
    version: readiness.version,
    model: process.env.CLI_SMOKE_MODEL ?? "gpt-5.6-luna",
    durationMs: result.durationMs,
    ephemeral: true
  }, null, 2));
})();
