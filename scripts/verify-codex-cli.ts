import assert from "node:assert/strict";
import path from "node:path";
import { runCodexJson } from "@/lib/codex-cli";

void (async () => {
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
