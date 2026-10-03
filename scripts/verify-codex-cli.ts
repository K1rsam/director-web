import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCodexExecutable, runCodexJson } from "@/lib/codex-cli";
import { PRODUCTION_CLI_MODEL, PRODUCTION_CLI_REASONING } from "@/lib/production-model";
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
    model: PRODUCTION_CLI_MODEL,
    reasoningEffort: PRODUCTION_CLI_REASONING,
    executable: process.execPath,
    executableArgs: [path.join(process.cwd(), "scripts/fixtures/fake-codex.mjs")],
    cwd: process.cwd()
  });

  assert.deepEqual(result.data, { ok: true, promptReceived: true });
  assert.equal(result.sessionId, "fake-session-001");
  assert.ok(result.durationMs >= 0);
  const freshArgs = readFakeArgs(result.stdout);
  assert.equal(freshArgs[freshArgs.indexOf("--model") + 1], "gpt-6.1-sol");
  assert.ok(freshArgs.includes('model_reasoning_effort="medium"'));
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

  await verifyFoundationSourceProfile();
  console.log("codex cli adapter verification passed");
})();

async function verifyFoundationSourceProfile() {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "foundation-cli-profile-test-"));
  const globalConfigPath = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
  const fingerprint = async () => readFile(globalConfigPath).then(value => createHash("sha256").update(value).digest("hex")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const before = await fingerprint();
  const request = {
    prompt: "测试输入（自包含资料岗）", schema: null, model: "fake-model", reasoningEffort: "medium" as const,
    executable: process.execPath, cwd: process.cwd(), ephemeral: true, minimalRuntime: true,
  };
  const fixture = path.join(process.cwd(), "scripts/fixtures/fake-codex.mjs");
  const configArgs = (args: string[]) => args.filter((_, index) => args[index - 1] === "--config");
  try {
    const callsPath = path.join(scratch, "source-calls.jsonl");
    const result = await runCodexJson({ ...request, instructionProfile: "foundation-source", executableArgs: [fixture, `--fixture-calls=${callsPath}`] });
    const args = readFakeArgs(result.stdout);
    assert.deepEqual(configArgs(args), [
      "skills.include_instructions=false", "project_doc_max_bytes=0",
      "features.plugins=false", "features.memories=false",
      "mcp_servers.node_repl.enabled=false", "mcp_servers.custom-server_2.enabled=false",
      'model_reasoning_effort="medium"',
    ]);
    assert.equal(args[args.indexOf("--model") + 1], "fake-model");
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--full-auto"]) assert.ok(!args.includes(flag));
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret-inventory-token|fixture\.invalid/);
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.equal(calls.length, 2, "资料岗只增加一次零模型清单查询");
    assert.deepEqual(calls[0], [`--fixture-calls=${callsPath}`, "--config", "features.plugins=false", "mcp", "list", "--json"]);
    assert.ok(calls[1].includes("exec"));

    for (const instructionProfile of [undefined, "foundation"] as const) {
      const oldCallsPath = path.join(scratch, `${instructionProfile ?? "default"}-calls.jsonl`);
      const old = await runCodexJson({ ...request, instructionProfile, executableArgs: [fixture, `--fixture-calls=${oldCallsPath}`] });
      assert.deepEqual(configArgs(readFakeArgs(old.stdout)), [
        ...(instructionProfile ? ["skills.include_instructions=false", "project_doc_max_bytes=0"] : []),
        'model_reasoning_effort="medium"',
      ], "普通与原 foundation 配置不变");
      assert.equal((await readFile(oldCallsPath, "utf8")).trim().split("\n").length, 1, "旧配置不查询 MCP");
    }
    const savedMinimalRuntime = process.env.CODEX_CLI_MINIMAL_RUNTIME;
    try {
      for (const minimalRuntime of [false, undefined]) {
        if (minimalRuntime === undefined) process.env.CODEX_CLI_MINIMAL_RUNTIME = "0";
        const optOutCallsPath = path.join(scratch, `opt-out-${minimalRuntime}-calls.jsonl`);
        const optOut = await runCodexJson({ ...request, instructionProfile: "foundation-source", minimalRuntime, executableArgs: [fixture, `--fixture-calls=${optOutCallsPath}`] });
        const optOutArgs = readFakeArgs(optOut.stdout);
        assert.ok(!optOutArgs.includes("--disable"), "保留显式和环境变量的精简模式退出选择");
        assert.deepEqual(configArgs(optOutArgs), ["skills.include_instructions=false", "project_doc_max_bytes=0", 'model_reasoning_effort="medium"']);
        assert.equal((await readFile(optOutCallsPath, "utf8")).trim().split("\n").length, 1, "关闭精简模式时不查询 MCP、不覆盖插件/记忆");
      }
    } finally {
      if (savedMinimalRuntime === undefined) delete process.env.CODEX_CLI_MINIMAL_RUNTIME;
      else process.env.CODEX_CLI_MINIMAL_RUNTIME = savedMinimalRuntime;
    }
    for (const session of [{ ephemeral: false }, { ephemeral: false, sessionId: "legacy-session" }, { ephemeral: true, sessionId: "legacy-session" }]) {
      const sessionCallsPath = path.join(scratch, `session-${session.ephemeral}-${session.sessionId}-calls.jsonl`);
      await assert.rejects(runCodexJson({ ...request, ...session, instructionProfile: "foundation-source", executableArgs: [fixture, `--fixture-calls=${sessionCallsPath}`] }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { requestOutcome?: string }).requestOutcome, "NOT_SENT");
        assert.match(error.message, /临时/);
        return true;
      });
      await assert.rejects(readFile(sessionCallsPath), { code: "ENOENT" }, "非临时或续接 source profile 在任何子进程启动前拒绝");
    }

    for (const mode of ["bad-json", "bad-shape", "bad-entry", "unsafe-name", "exit", "large", "timeout"]) {
      const failureCallsPath = path.join(scratch, `${mode}-calls.jsonl`);
      let captured = false;
      await assert.rejects(runCodexJson({
        ...request, instructionProfile: "foundation-source", timeoutMs: mode === "timeout" ? 500 : 5_000,
        executableArgs: [fixture, `--fixture-calls=${failureCallsPath}`, `--fixture-mcp=${mode}`],
        onRawOutput: () => { captured = true; },
      }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { requestOutcome?: string }).requestOutcome, "NOT_SENT");
        assert.match(error.message, /MCP.*未发送/);
        assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /fixture-secret-inventory-token|fixture\.invalid/);
        return true;
      });
      assert.equal(captured, false, "预检清单不能进入模型正文回调");
      const failureCalls = (await readFile(failureCallsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
      assert.equal(failureCalls.length, 1, `${mode} 清单失败不得启动 exec`);
      assert.ok(!failureCalls[0].includes("exec"));
    }
    assert.equal(await fingerprint(), before, "调用前后全局配置保持原样（仅比较摘要）");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

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
