import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RoleConfig } from "@/lib/role-runner";

// Offline only: no .env loader, no real Codex, no Prisma client or database access.
const systemPrompt = "  你是基础工程岗位。\n完整保留这份规则，只返回 JSON。\n";
const taskPrompt = "处理本轮基础工程：\n{\"source\":\"测试原文\"}";
const fakeApiKey = "foundation-transport-test-key-not-real";
const validApiOutput = '  \n{"ok":true}\n  ';
const invalidApiOutput = `  {"broken":"${fakeApiKey}${"x".repeat(900)}\nAPI_COMPLETE_OUTPUT_TAIL`;
const invalidCliOutput = `  {"broken":"${fakeApiKey}${"x".repeat(900)}\nCLI_COMPLETE_OUTPUT_TAIL`;
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
let databaseAccesses = 0;
let failures = 0;

void (async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "foundation-transport-"));
  const originalFetch = globalThis.fetch;
  const fakeCliPath = path.join(tempDir, "fake-codex.mjs");
  const skillsDir = path.join(tempDir, "skills");
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(tempDir, "unused.db")}`,
    CODEX_CLI_PATH: fakeCliPath,
    CODEX_CLI_TIMEOUT_MS: "5000",
    CODEX_SKILLS_DIR: skillsDir,
    FOUNDATION_TRANSPORT_FAIL_CLI: "0",
    DEEPSEEK_API_BASE: "https://foundation-transport.invalid",
    DEEPSEEK_API_KEY: fakeApiKey,
    DEEPSEEK_API_MODEL: "deepseek-chat",
    DEEPSEEK_API_SKILL_REFERENCES: "0"
  });
  // Install before importing role-runner so even constructing a real client is avoided.
  const prismaGlobal = globalThis as unknown as { prisma?: unknown };
  const originalPrisma = prismaGlobal.prisma;
  prismaGlobal.prisma = new Proxy({}, {
    get() {
      databaseAccesses += 1;
      throw new Error("ephemeral transport must not access any database session");
    }
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://foundation-transport.invalid/chat/completions");
    assert.equal(init?.method, "POST");
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      id: "fake-request",
      choices: [{ message: { role: "assistant", content: validApiOutput }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    await writeFile(fakeCliPath, `#!${process.execPath}
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const outputPath = args[args.indexOf("-o") + 1];
if (!outputPath) throw new Error("missing output path");
if (process.env.FOUNDATION_TRANSPORT_FAIL_CLI === "1") {
  await writeFile(outputPath, ${JSON.stringify(invalidCliOutput)}, "utf8");
  process.stderr.write(${JSON.stringify(`foundation-cli-stderr: ${fakeApiKey}; preserve this diagnostic`)});
  process.stdout.write(JSON.stringify({ type: "error", message: ${JSON.stringify(`foundation-cli-detail: ${fakeApiKey}; preserve this diagnostic`)} }) + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-foundation-session" }) + "\\n");
await writeFile(outputPath, process.env.FOUNDATION_TRANSPORT_FAIL_CLI === "invalid"
  ? ${JSON.stringify(invalidCliOutput)}
  : "  \\n" + JSON.stringify({ ok: true, prompt, args }) + "\\n  ", "utf8");
`, "utf8");
    await chmod(fakeCliPath, 0o700);
    const { runRoleByProvider } = await import("@/lib/role-runner");
    const baseRole: RoleConfig = {
      code: "F1", skill: "must-not-be-looked-up", model: "fake-model", reasoningEffort: "medium"
    };
    // Structural assignment also lets the red test run before RoleConfig gains the field.
    const explicitRole = { ...baseRole, systemPrompt };
    const call = (provider: "API" | "CLI", role = explicitRole, prompt = taskPrompt) => runRoleByProvider({
      provider, projectId: "offline-project", episodeId: "offline-episode", role, prompt,
      sessionMode: "ephemeral"
    });

    await check("API explicit prompt reaches actual messages without skill lookup", async () => {
      const before = requests.length;
      await assert.doesNotReject(async () => {
        const result = await call("API");
        assert.deepEqual(result.data, { ok: true });
        assert.equal(result.rawOutput, validApiOutput);
        assert.equal(result.stdout, validApiOutput);
        assert.ok(!JSON.stringify(result).includes(fakeApiKey));
      }, "explicit systemPrompt must bypass missing Skill lookup");
      assert.equal(requests.length, before + 1);
      assert.deepEqual(requests.at(-1)?.messages, [
        { role: "system", content: systemPrompt },
        { role: "user", content: taskPrompt }
      ]);
      assert.ok(!JSON.stringify(requests.at(-1)).includes(fakeApiKey));
    });

    await check("CLI child receives the same explicit rules and task, without a skill path", async () => {
      const result = await call("CLI");
      const prompt = String(result.data.prompt);
      assert.ok(prompt.includes(systemPrompt), "CLI stdin must contain unmodified systemPrompt");
      assert.ok(prompt.includes(taskPrompt), "CLI stdin must contain the complete task prompt");
      assert.ok(prompt.indexOf(systemPrompt) < prompt.indexOf(taskPrompt));
      assert.ok(!prompt.includes(baseRole.skill));
      assert.ok(!/SKILL\.md|\.agents\/skills|\.codex\/skills/.test(prompt));
      assert.ok(!prompt.includes(fakeApiKey));
      assert.equal(result.rawOutput, `  \n${JSON.stringify(result.data)}\n  `);
      const args = result.data.args as string[];
      assert.ok(args.includes("--ephemeral"));
      assert.ok(!args.includes("resume"));
      assert.ok(!args.includes("--output-schema"));
      assert.equal(result.sessionId, "fake-foundation-session");
    });

    await check("all foundation codes use explicit prompts without an installed skill", async () => {
      for (const code of ["F1", "F2", "Q1"]) {
        await assert.doesNotReject(() => call("API", { ...explicitRole, code, skill: "" }));
        const result = await call("CLI", { ...explicitRole, code, skill: "" });
        assert.ok(String(result.data.prompt).includes(systemPrompt));
      }
    });

    await check("only self-contained foundation CLI calls opt out of automatic skill and project-doc injection", async () => {
      for (const code of ["F1", "F2", "Q1", "E1"]) {
        const result = await call("CLI", { ...explicitRole, code, skill: "" });
        const args = result.data.args as string[];
        const closed = code !== "E1";
        assert.equal(args.includes("skills.include_instructions=false"), closed);
        assert.equal(args.includes("project_doc_max_bytes=0"), closed);
        assert.equal(args[args.indexOf("--model") + 1], "fake-model");
        assert.ok(args.includes('model_reasoning_effort="medium"'));
        assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
        assert.equal(args[args.indexOf("--cd") + 1], process.cwd());
        assert.ok(!args.some(arg => arg.startsWith("skills.config=")), "preserve the user's per-skill configuration array");
        assert.ok(String(result.data.prompt).includes(systemPrompt) && String(result.data.prompt).includes(taskPrompt));
      }
    });

    await check("an explicitly empty prompt bypasses Skill loading and stays verbatim", async () => {
      await assert.doesNotReject(() => call("API", { ...explicitRole, systemPrompt: "" }));
      assert.deepEqual(requests.at(-1)?.messages, [
        { role: "system", content: "" }, { role: "user", content: taskPrompt }
      ]);
    });

    await check("legacy roles retain API skill loading and unchanged CLI task input", async () => {
      const legacySkill = "e1-legacy-fixture";
      const legacySystem = "旧 E1 规则，仍然从 Skill 加载。";
      await mkdir(path.join(skillsDir, legacySkill), { recursive: true });
      await writeFile(path.join(skillsDir, legacySkill, "SKILL.md"), legacySystem, "utf8");
      const role: RoleConfig = { ...baseRole, code: "E1", skill: legacySkill };
      const prompt = `使用 $${legacySkill} 完成当前E1岗位任务。\n旧任务输入。`;
      for (const provider of ["API", "CLI"] as const) {
        const result = await runRoleByProvider({
          provider, projectId: "offline-project", episodeId: "offline-episode", role, prompt,
          sessionMode: "ephemeral"
        });
        if (provider === "API") {
          assert.deepEqual(requests.at(-1)?.messages, [
            { role: "system", content: legacySystem }, { role: "user", content: prompt }
          ]);
          assert.equal(result.stdout, "");
        } else assert.equal(result.data.prompt, prompt);
        assert.ok(!Object.hasOwn(result, "rawOutput"), "legacy roles must not opt into raw capture");
      }
    });

    await check("ephemeral calls never read, write or delete session records", async () => {
      assert.equal(databaseAccesses, 0);
    });

    await check("explicit API errors redact the known key but retain response diagnostics", async () => {
      const successFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(`foundation-api-detail: ${fakeApiKey}; preserve this diagnostic`, { status: 429 });
      try {
        await assert.rejects(() => call("API", { ...explicitRole, skill: "e1-legacy-fixture" }), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes("foundation-api-detail:"));
          assert.ok(error.message.includes("preserve this diagnostic"));
          assert.ok(!error.message.includes(fakeApiKey), "API error must redact the known key");
          assert.ok(!error.stack?.includes(fakeApiKey), "API error stack must redact the known key");
          const captured = error as Error & { rawOutput?: string; stdout?: string };
          assert.equal(captured.rawOutput, "foundation-api-detail: [REDACTED]; preserve this diagnostic");
          assert.equal(captured.stdout, captured.rawOutput);
          return true;
        });
      } finally {
        globalThis.fetch = successFetch;
      }
    });

    await check("explicit CLI errors redact the known key but retain process diagnostics", async () => {
      process.env.FOUNDATION_TRANSPORT_FAIL_CLI = "1";
      try {
        await assert.rejects(() => call("CLI"), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes("foundation-cli-detail:"));
          assert.ok(error.message.includes("preserve this diagnostic"));
          assert.ok(!error.message.includes(fakeApiKey), "CLI error must redact the known key");
          assert.ok(!error.stack?.includes(fakeApiKey), "CLI error stack must redact the known key");
          const captured = error as Error & { rawOutput?: string; stdout?: string; stderr?: string };
          assert.equal(captured.rawOutput, invalidCliOutput.replaceAll(fakeApiKey, "[REDACTED]"));
          assert.ok(captured.stdout?.includes("foundation-cli-detail:"));
          assert.ok(captured.stderr?.includes("foundation-cli-stderr:"));
          assert.ok(!JSON.stringify(captured).includes(fakeApiKey));
          return true;
        });
      } finally {
        delete process.env.FOUNDATION_TRANSPORT_FAIL_CLI;
      }
      assert.equal(databaseAccesses, 0, "failed ephemeral calls must not access session records either");
    });

    await check("new API parse failures make one attempt and retain the complete raw tail", async () => {
      const successFetch = globalThis.fetch;
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: invalidApiOutput }, finish_reason: "stop" }]
        }), { status: 200 });
      };
      try {
        await assert.rejects(() => call("API"), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(attempts, 1, "new foundation calls must not silently retry failed JSON");
          const captured = error as Error & { rawOutput?: string; stdout?: string };
          assert.equal(captured.rawOutput, invalidApiOutput.replaceAll(fakeApiKey, "[REDACTED]"));
          assert.equal(captured.stdout, captured.rawOutput);
          assert.ok(error.message.includes("finish_reason=stop"));
          assert.ok(!error.message.includes(fakeApiKey));
          return true;
        });
      } finally {
        globalThis.fetch = successFetch;
      }
    });

    await check("new CLI parse failures retain the entire output file and event diagnostics", async () => {
      process.env.FOUNDATION_TRANSPORT_FAIL_CLI = "invalid";
      try {
        await assert.rejects(() => call("CLI"), (error: unknown) => {
          assert.ok(error instanceof Error);
          const captured = error as Error & { rawOutput?: string; stdout?: string; stderr?: string };
          assert.equal(captured.rawOutput, invalidCliOutput.replaceAll(fakeApiKey, "[REDACTED]"));
          assert.ok(captured.stdout?.includes("thread.started"));
          assert.equal(captured.stderr, "");
          assert.ok(error.message.includes("不是合法JSON"));
          assert.ok(!JSON.stringify(captured).includes(fakeApiKey));
          return true;
        });
      } finally {
        delete process.env.FOUNDATION_TRANSPORT_FAIL_CLI;
      }
    });

    await check("an invalid API response envelope retains its entire body for diagnosis", async () => {
      const successFetch = globalThis.fetch;
      const responseBody = `upstream-error ${fakeApiKey} ${"x".repeat(900)} COMPLETE_RESPONSE_TAIL`;
      globalThis.fetch = async () => new Response(responseBody, { status: 200 });
      try {
        await assert.rejects(() => call("API"), (error: unknown) => {
          assert.ok(error instanceof Error);
          const captured = error as Error & { rawOutput?: string; stdout?: string };
          assert.equal(captured.rawOutput, responseBody.replaceAll(fakeApiKey, "[REDACTED]"));
          assert.equal(captured.stdout, captured.rawOutput);
          return true;
        });
      } finally {
        globalThis.fetch = successFetch;
      }
    });

    await check("legacy API roles retain retry behavior and do not expose raw capture fields", async () => {
      const successFetch = globalThis.fetch;
      let attempts = 0;
      globalThis.fetch = async (url, init) => {
        attempts += 1;
        if (attempts === 1) return new Response(JSON.stringify({
          choices: [{ message: { content: "invalid-first-attempt" }, finish_reason: "stop" }]
        }), { status: 200 });
        return successFetch(url, init);
      };
      try {
        const result = await runRoleByProvider({
          provider: "API", projectId: "offline-project", episodeId: "offline-episode",
          role: { ...baseRole, code: "E1", skill: "e1-legacy-fixture" }, prompt: taskPrompt,
          sessionMode: "ephemeral"
        });
        assert.equal(attempts, 2);
        assert.deepEqual(result.data, { ok: true });
        assert.equal(result.stdout, "");
        assert.ok(!Object.hasOwn(result, "rawOutput"));
      } finally {
        globalThis.fetch = successFetch;
      }
      assert.equal(databaseAccesses, 0);
    });

    await check("JSON-shaped API errors and empty messages retain the complete response envelope", async () => {
      const successFetch = globalThis.fetch;
      try {
        for (const responseBody of ["null", "[]", JSON.stringify({ error: { message: `COMPLETE_ENVELOPE_DIAGNOSTIC ${fakeApiKey}` } }), JSON.stringify({ choices: [{ message: { content: 42 } }] }), JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { completion_tokens: 8192 } })]) {
          let attempts = 0;
          globalThis.fetch = async () => { attempts++; return new Response(responseBody, { status: 200 }); };
          await assert.rejects(() => call("API"), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(attempts, 1);
            const captured = error as Error & { rawOutput?: string; stdout?: string };
            assert.equal(captured.rawOutput, responseBody.replaceAll(fakeApiKey, "[REDACTED]"));
            assert.equal(captured.stdout, captured.rawOutput);
            return true;
          });
        }
      } finally { globalThis.fetch = successFetch; }
    });

    await check("parsed model data cannot reintroduce the known key through nested fields", async () => {
      const successFetch = globalThis.fetch;
      const data = { overview: fakeApiKey, nested: { diagnostic: `before ${fakeApiKey} after`, values: [null, 42, true, fakeApiKey] } };
      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), { status: 200 });
      try {
        const result = await call("API");
        assert.deepEqual(result.data, { overview: "[REDACTED]", nested: { diagnostic: "before [REDACTED] after", values: [null, 42, true, "[REDACTED]"] } });
        assert.ok(!JSON.stringify(result).includes(fakeApiKey));
      } finally { globalThis.fetch = successFetch; }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPrisma === undefined) delete prismaGlobal.prisma;
    else prismaGlobal.prisma = originalPrisma;
    await rm(tempDir, { recursive: true, force: true });
  }
  assert.equal(failures, 0, `${failures} foundation transport checks failed`);
  console.log("foundation transport verification passed (offline; no live CLI/API or database)");
})().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message.replaceAll(fakeApiKey, "[REDACTED]") : "transport verification failed");
  process.exitCode = 1;
});

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`FAIL ${name}: ${message.replaceAll(fakeApiKey, "[REDACTED]")}`);
  }
}
