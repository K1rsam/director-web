import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type JsonSchema = Record<string, unknown>;

export type CodexJsonRequest = {
  prompt: string;
  /** 严格输出 schema；岗位复杂对象可传 null，改由提示词约束并防御性解析 JSON。 */
  schema?: JsonSchema | null;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  cwd: string;
  sessionId?: string | null;
  timeoutMs?: number;
  executable?: string;
  executableArgs?: string[];
  /** 不持久化 Codex 会话；适合 E0 与真实冒烟。 */
  ephemeral?: boolean;
  /** 岗位只做结构化文本推理，默认关闭无关的 Apps/浏览器/图像/多代理能力。 */
  minimalRuntime?: boolean;
  /** 仅自包含F1/F2/Q1资料调用：关闭自动技能目录与项目开发说明注入，不改变权限或全局配置。 */
  instructionProfile?: "foundation";
  /** 可选捕获完整 -o 输出文件（解析前）；不等同于有长度上限的 stdout JSONL。 */
  onRawOutput?: (content: string) => void;
};

export type CodexJsonResult<T> = {
  data: T;
  sessionId: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
};

const MINIMAL_RUNTIME_ARGS = [
  "--disable", "apps",
  "--disable", "browser_use",
  "--disable", "computer_use",
  "--disable", "image_generation",
  "--disable", "in_app_browser",
  "--disable", "workspace_dependencies",
  "--disable", "multi_agent"
];

export const FOUNDATION_CLI_INSTRUCTION_PROFILE = {
  version: "FOUNDATION_SELF_CONTAINED_V1",
  overrides: { "skills.include_instructions": false, project_doc_max_bytes: 0 }
} as const;

/** 排队前的零 Token 预检：只检查本机 CLI 可执行文件、版本与登录态。 */
export async function assertCodexCliReady(): Promise<{ executable: string; version: string }> {
  const executable = resolveCodexExecutable();
  let versionResult: { stdout: string; stderr: string };
  try {
    versionResult = await runCommand(executable, ["--version"], process.cwd(), 10_000);
  } catch (error) {
    throw new Error(`Codex CLI 不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  if (!/codex-cli/i.test(version)) {
    throw new Error(`Codex CLI 版本输出异常：${version || "无输出"}`);
  }

  let loginResult: { stdout: string; stderr: string };
  try {
    loginResult = await runCommand(executable, ["login", "status"], process.cwd(), 10_000);
  } catch (error) {
    throw new Error(`无法确认 Codex CLI 登录状态：${error instanceof Error ? error.message : String(error)}`);
  }
  const loginText = `${loginResult.stdout}\n${loginResult.stderr}`.trim();
  if (/not logged in/i.test(loginText) || !/logged in/i.test(loginText)) {
    throw new Error("Codex CLI 尚未登录，请先在终端执行 codex login。");
  }
  return { executable, version: version.split("\n")[0] };
}

export async function runCodexJson<T>(request: CodexJsonRequest): Promise<CodexJsonResult<T>> {
  if (request.ephemeral && request.sessionId) {
    throw Object.assign(new Error("临时 CLI 会话不能续接已有 sessionId。"), { requestOutcome: "NOT_SENT" });
  }
  const startedAt = Date.now();
  const notSent = (error: unknown): never => { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { requestOutcome: "NOT_SENT" }); };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "seedance-codex-")).catch(notSent);
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "output.json");
  if (request.schema) await writeFile(schemaPath, JSON.stringify(request.schema), "utf8").catch(notSent);

  const executable = request.executable ?? resolveCodexExecutable();
  const useMinimalRuntime = request.minimalRuntime ?? (process.env.CODEX_CLI_MINIMAL_RUNTIME !== "0");
  const args = [
    ...(request.executableArgs ?? []),
    "exec",
    ...(request.sessionId ? ["resume"] : []),
    ...(useMinimalRuntime ? MINIMAL_RUNTIME_ARGS : []),
    ...(request.instructionProfile === "foundation"
      ? Object.entries(FOUNDATION_CLI_INSTRUCTION_PROFILE.overrides).flatMap(([key, value]) => ["--config", `${key}=${JSON.stringify(value)}`]) : []),
    "--model",
    request.model,
    "--config",
    `model_reasoning_effort="${request.reasoningEffort}"`,
    "--skip-git-repo-check",
    ...(request.schema ? ["--output-schema", schemaPath] : []),
    "--json",
    "-o",
    outputPath,
    ...(request.ephemeral ? ["--ephemeral"] : []),
    ...(request.sessionId ? [request.sessionId] : ["--sandbox", "read-only", "--cd", request.cwd]),
    "-"
  ];

  let processResult: { stdout: string; stderr: string } | undefined;
  let rawOutputCaptured = false;
  try {
    processResult = await runProcess({
      executable,
      args,
      prompt: request.prompt,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs ?? resolveCliTimeoutMs(),
      captureDiagnostics: Boolean(request.onRawOutput)
    });
    const rawOutput = await readFile(outputPath, "utf8");
    rawOutputCaptured = true;
    request.onRawOutput?.(rawOutput);
    const data = parseJsonOutput<T>(rawOutput);
    return {
      data,
      sessionId: readSessionId(processResult.stdout) ?? request.sessionId ?? null,
      durationMs: Date.now() - startedAt,
      stdout: processResult.stdout,
      stderr: processResult.stderr
    };
  } catch (error) {
    if (error instanceof Error) Object.assign(error, {
      requestOutcome: rawOutputCaptured ? "RESPONDED" : (error as Error & { requestOutcome?: string }).requestOutcome ?? "UNKNOWN"
    });
    if (request.onRawOutput) {
      if (!rawOutputCaptured) {
        const rawOutput = await readFile(outputPath, "utf8").catch(() => null);
        if (rawOutput !== null) request.onRawOutput(rawOutput);
      }
      if (processResult && error instanceof Error) Object.assign(error, processResult);
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function resolveCodexExecutable(): string {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  const local = process.env.HOME ? path.join(process.env.HOME, ".local", "bin", "codex") : "";
  return local && existsSync(local) ? local : "codex";
}

function resolveCliTimeoutMs(): number {
  const configured = Number(process.env.CODEX_CLI_TIMEOUT_MS ?? "");
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : 30 * 60_000;
}

function parseJsonOutput<T>(value: string): T {
  let normalized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start >= 0 && end > start) normalized = normalized.slice(start, end + 1);
  try {
    return JSON.parse(normalized) as T;
  } catch (error) {
    throw new Error(`CLI返回内容不是合法JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readSessionId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const value = event.thread_id ?? event.session_id;
      if (typeof value === "string" && value) return value;
    } catch {
      // Non-event output is preserved in logs and ignored here.
    }
  }
  return null;
}

async function runProcess(input: {
  executable: string;
  args: string[];
  prompt: string;
  cwd: string;
  timeoutMs: number;
  captureDiagnostics?: boolean;
}) {
  let stdout = "";
  let stderr = "";
  let spawned = false;
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const maxLogLength = 2_000_000;
    child.on("spawn", () => { spawned = true; });
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, input.timeoutMs);

    const clearTimers = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-maxLogLength); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-maxLogLength); });
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimers();
      if (timedOut) {
        reject(new Error(`CLI执行超过${Math.round(input.timeoutMs / 60_000)}分钟，已停止本岗位。`));
      } else if (code === 0) resolve({ stdout, stderr });
      else {
        const structuredError = readCliError(stdout);
        const detail = structuredError ?? (stderr.trim().slice(-1200) || "CLI 未返回错误详情");
        reject(new Error(`CLI执行失败（code=${code ?? "null"}, signal=${signal ?? "none"}）：${detail}`));
      }
    });
    child.stdin.on("error", () => {
      // 子进程提前退出时由 close 事件统一给出真实错误，忽略 stdin EPIPE。
    });
    child.stdin.end(input.prompt);
  }).catch((error: unknown) => {
    if (error instanceof Error) Object.assign(error, { requestOutcome: spawned ? "UNKNOWN" : "NOT_SENT" });
    if (input.captureDiagnostics && error instanceof Error) Object.assign(error, { stdout, stderr });
    throw error;
  });
}

/** `codex exec --json` 的真实失败通常在 stdout JSONL；stderr 可能只有无关启动警告。 */
function readCliError(stdout: string): string | null {
  const lines = stdout.split("\n").reverse();
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = String(event.type ?? "");
      if (type !== "error" && !type.includes("fail")) continue;
      const raw = event.error ?? event.message;
      if (typeof raw === "string" && raw.trim()) return raw.trim().slice(-2_000);
      if (raw && typeof raw === "object") {
        const message = (raw as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message.trim().slice(-2_000);
        return JSON.stringify(raw).slice(-2_000);
      }
      return JSON.stringify(event).slice(-2_000);
    } catch {
      // 忽略非事件行。
    }
  }
  return null;
}

async function runCommand(executable: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`命令超过${Math.round(timeoutMs / 1000)}秒。`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `退出码 ${code ?? "null"}`).trim()));
    });
  });
}
