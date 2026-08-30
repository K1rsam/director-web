import assert from "node:assert/strict";
import path from "node:path";
import { resolveCodexExecutable, runCodexJson } from "@/lib/codex-cli";
import { classifyExecutionError, formatExecutionErrorForUser, isQuotaError } from "@/lib/execution-errors";

void (async () => {
  const quotaError = "You've hit your usage limit. Please try again at 1:43 PM, or go to https://chatgpt.com/codex/settings/usage for more.";
  assert.equal(classifyExecutionError(quotaError), "quota");
  assert.equal(isQuotaError(quotaError), true);
  const friendlyQuotaError = formatExecutionErrorForUser(quotaError, { source: "cli" });
  assert.equal(
    friendlyQuotaError,
    "Codex CLI 额度不足，当前无法继续调用模型。请等待 Codex CLI 额度恢复，或切换到 API 执行方式后重试。预计可再次尝试时间：1:43 PM。"
  );
  assert.equal(formatExecutionErrorForUser(friendlyQuotaError, { source: "cli" }), friendlyQuotaError);
  assert.equal(classifyExecutionError("DeepSeek API 请求失败（HTTP 402）：insufficient balance"), "quota");
  assert.match(formatExecutionErrorForUser("HTTP 429: rate limit exceeded", { source: "cli" }), /批量任务遇到该情况会暂停/);
  assert.match(formatExecutionErrorForUser("not logged in", { source: "cli" }), /未登录/);
  assert.match(formatExecutionErrorForUser("ECONNRESET", { source: "cli" }), /网络/);

  const result = await runCodexJson<{ ok: boolean; promptReceived: boolean }>({
    prompt: "测试输入",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "promptReceived"],
      properties: {
        ok: { type: "boolean" },
        promptReceived: { type: "boolean" }
      }
    },
    model: "fake-model",
    reasoningEffort: "medium",
    executable: process.execPath,
    executableArgs: [path.join(process.cwd(), "scripts/fixtures/fake-codex.mjs")],
    cwd: process.cwd()
  });

  assert.deepEqual(result.data, { ok: true, promptReceived: true });
  assert.equal(result.sessionId, "fake-session-001");
  assert.ok(result.durationMs >= 0);
  const freshArgs = readFakeArgs(result.stdout);
  assert.ok(freshArgs.includes("--disable"), "岗位调用应启用精简运行参数");
  assert.ok(freshArgs.includes("apps"), "岗位调用应关闭 Apps");
  assert.ok(freshArgs.includes("--sandbox"), "新会话应使用只读沙箱");

  if (process.platform === "win32") {
    const batchExecutable = path.join(process.cwd(), "scripts/fixtures/fake-codex.cmd");
    const previousConfiguredPath = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = `& '${batchExecutable}'`;
    try {
      assert.equal(resolveCodexExecutable(), batchExecutable, "应清理 PowerShell 调用符与外层引号");
    } finally {
      if (previousConfiguredPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousConfiguredPath;
    }

    const batchResult = await runCodexJson<{ ok: boolean; promptReceived: boolean }>({
      prompt: "测试输入（Windows codex.cmd）",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok", "promptReceived"],
        properties: {
          ok: { type: "boolean" },
          promptReceived: { type: "boolean" }
        }
      },
      model: "fake-model",
      reasoningEffort: "medium",
      executable: batchExecutable,
      cwd: process.cwd()
    });
    assert.deepEqual(batchResult.data, { ok: true, promptReceived: true });
    assert.ok(readFakeArgs(batchResult.stdout).includes("model_reasoning_effort=\"medium\""));
  }

  const resumed = await runCodexJson<{ ok: boolean; promptReceived: boolean }>({
    prompt: "测试输入（续接）",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "promptReceived"],
      properties: {
        ok: { type: "boolean" },
        promptReceived: { type: "boolean" }
      }
    },
    model: "fake-model",
    reasoningEffort: "medium",
    executable: process.execPath,
    executableArgs: [path.join(process.cwd(), "scripts/fixtures/fake-codex.mjs")],
    cwd: process.cwd(),
    sessionId: "fake-session-001"
  });
  const resumeArgs = readFakeArgs(resumed.stdout);
  assert.equal(resumeArgs[resumeArgs.indexOf("exec") + 1], "resume", "续接应使用 codex exec resume");
  assert.ok(!resumeArgs.includes("--sandbox"), "resume 沿用原会话沙箱，不重复传不支持的参数");

  const ephemeral = await runCodexJson<{ ok: boolean; promptReceived: boolean }>({
    prompt: "测试输入（临时）",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "promptReceived"],
      properties: {
        ok: { type: "boolean" },
        promptReceived: { type: "boolean" }
      }
    },
    model: "fake-model",
    reasoningEffort: "medium",
    executable: process.execPath,
    executableArgs: [path.join(process.cwd(), "scripts/fixtures/fake-codex.mjs")],
    cwd: process.cwd(),
    ephemeral: true
  });
  assert.ok(readFakeArgs(ephemeral.stdout).includes("--ephemeral"), "临时会话应传 --ephemeral");

  const promptJson = await runCodexJson<{ ok: boolean; promptReceived: boolean }>({
    prompt: "测试输入（岗位提示词约束 JSON，不使用严格 schema）",
    schema: null,
    model: "fake-model",
    reasoningEffort: "medium",
    executable: process.execPath,
    executableArgs: [path.join(process.cwd(), "scripts/fixtures/fake-codex.mjs")],
    cwd: process.cwd()
  });
  assert.ok(!readFakeArgs(promptJson.stdout).includes("--output-schema"), "岗位模式不应发送不完整的通用 schema");

  console.log("codex cli adapter verification passed");
})();

function readFakeArgs(stdout: string): string[] {
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: string; args?: unknown };
      if (event.type === "fake.args" && Array.isArray(event.args)) return event.args.map(String);
    } catch {
      // 忽略非 JSON 日志。
    }
  }
  throw new Error("fake codex 没有返回参数事件");
}
