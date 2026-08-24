/**
 * DeepSeek API 适配器验证：真实调用一次 DeepSeek API，
 * 验证 Key 有效、端点可达、JSON 模式可用、正文解析正确。
 *
 * 需要 .env 中配置 DEEPSEEK_API_KEY；未配置时给出明确提示（不发起调用）。
 */
import assert from "node:assert/strict";
import { runDeepSeekJson } from "@/lib/deepseek-api";

void (async () => {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY：请在 .env 中配置 DeepSeek 开放平台 Key 后重试。");
    console.error("配置示例：DEEPSEEK_API_KEY=sk-...");
    process.exitCode = 1;
    return;
  }

  const result = await runDeepSeekJson<{ ok: boolean; echo: string }>({
    prompt: '请只返回一个 JSON 对象：{"ok":true,"echo":"deepseek-api-ok"}',
    model: "deepseek-chat",
    maxTokens: 512
  });

  assert.equal(result.data.ok, true, "返回 JSON 缺少 ok=true");
  assert.ok(String(result.data.echo).includes("deepseek-api-ok"), `echo 与预期不符：${result.data.echo}`);
  assert.equal(result.sessionId, null);

  console.log("deepseek api adapter verification passed");
  console.log(result.stderr);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
