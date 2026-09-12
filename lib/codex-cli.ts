import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatExecutionErrorForUser } from "@/lib/execution-errors";

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

export type CodexCliStatusWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CodexCliStatusCredits = {
  balance: string | null;
  hasCredits: boolean;
  unlimited: boolean;
};

export type CodexCliStatusIndividualLimit = {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number | null;
};

export type CodexCliStatusLimit = {
  id: string;
  name: string | null;
  planType: string | null;
  primary: CodexCliStatusWindow | null;
  secondary: CodexCliStatusWindow | null;
  credits: CodexCliStatusCredits | null;
  individualLimit: CodexCliStatusIndividualLimit | null;
  rateLimitReachedType: string | null;
};

export type CodexCliStatus = {
  version: string;
  account: {
    type: string;
    email: string | null;
    planType: string | null;
  };
  limits: CodexCliStatusLimit[];
  usage: {
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
    latestDailyUsage: { date: string; tokens: number } | null;
  };
  checkedAt: string;
  warnings: string[];
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
  try {
    const status = await readCodexCliStatus();
    return { executable, version: status.version };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/not logged in|login required|unauthorized|authentication|尚未完成登录|尚未登录/i.test(detail)) {
      throw new Error("Codex CLI 尚未完成登录，请在本机终端运行 codex 并按提示完成登录后再试。");
    }
    if (/找不到 Codex CLI|ENOENT|不可用/i.test(detail)) {
      throw new Error(`Codex CLI 不可用：${detail}`);
    }
    throw new Error(`Codex CLI 状态检查失败：${detail}`);
  }
}

/**
 * 读取本机 Codex 的账户状态，不发起模型调用。
 * app-server 的 account/read、account/rateLimits/read、account/usage/read
 * 对应交互式 CLI 的 `/status` 信息；这里只返回页面需要的脱敏摘要。
 */
export async function readCodexCliStatus(): Promise<CodexCliStatus> {
  const executable = resolveCodexExecutable();
  let versionResult: { stdout: string; stderr: string };
  try {
    versionResult = await runCommand(executable, ["--version"], process.cwd(), 10_000);
  } catch (error) {
    throw new Error(`Codex CLI 不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  if (!/codex-cli/i.test(versionText)) {
    throw new Error("Codex CLI 版本检查未通过，请确认本机终端中的 codex --version 可用。");
  }

  const version = versionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /codex-cli/i.test(line))
    ?? "Codex CLI";
  const responses = await runCodexAppServerStatus(executable, process.cwd(), 15_000);
  const warnings: string[] = [];

  const accountPayload = readRpcResult(responses, "2", "账号状态", warnings);
  const account = asRecord(accountPayload)?.account;
  const accountRecord = asRecord(account);
  if (!accountRecord) {
    throw new Error("Codex CLI 尚未完成登录，请在本机终端运行 codex 并按提示完成登录。");
  }

  const ratePayload = readRpcResult(responses, "3", "额度状态", warnings);
  const usagePayload = readRpcResult(responses, "4", "用量状态", warnings);
  return {
    version,
    account: {
      type: asString(accountRecord.type) ?? "unknown",
      email: asString(accountRecord.email),
      planType: asString(accountRecord.planType)
    },
    limits: normalizeRateLimits(ratePayload),
    usage: normalizeUsage(usagePayload),
    checkedAt: new Date().toISOString(),
    warnings
  };
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
  const configured = normalizeConfiguredExecutable(process.env.CODEX_CLI_PATH ?? "");
  if (configured) return configured;

  // Windows 上 PATH 里可能同时存在 npm 生成的 codex.cmd 和 Codex 自带的
  // 原生 codex.exe。优先原生可执行文件，避免 cmd.exe 再启动 node.exe 时弹出
  // 独立控制台窗口；没有原生版本时再使用 npm 的 codex.cmd。
  if (process.platform === "win32") {
    const pathValue = process.env.Path ?? process.env.PATH ?? "";
    const directories = pathValue
      .split(path.delimiter)
      .map((directory) => directory.trim())
      .filter(Boolean);
    const names = ["codex.exe", "codex.cmd", "codex.bat"];
    for (const name of names) {
      const candidate = directories
        .map((directory) => path.join(directory, name))
        .find((entry) => existsSync(entry));
      if (candidate) return candidate;
    }

    const userProfile = process.env.USERPROFILE ?? os.homedir();
    const appData = process.env.APPDATA ?? path.join(userProfile, "AppData", "Roaming");
    const npmCandidates = [
      path.join(appData, "npm", "codex.cmd"),
      path.join(appData, "npm", "codex.bat"),
      path.join(userProfile, "AppData", "Roaming", "npm", "codex.cmd"),
      path.join(userProfile, "AppData", "Roaming", "npm", "codex.bat")
    ];
    const npmExecutable = npmCandidates.find((candidate) => existsSync(candidate));
    if (npmExecutable) return npmExecutable;
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const local = path.join(home, ".local", "bin", "codex");
  return local && existsSync(local) ? local : "codex";
}

function normalizeConfiguredExecutable(value: string): string {
  let normalized = value.trim();
  for (let index = 0; index < 3; index += 1) {
    const before = normalized;
    if (normalized.startsWith("&")) normalized = normalized.slice(1).trim();
    if (
      (normalized.startsWith("'") && normalized.endsWith("'")) ||
      (normalized.startsWith('"') && normalized.endsWith('"'))
    ) {
      normalized = normalized.slice(1, -1).trim();
    }
    if (normalized === before) break;
  }
  return normalized;
}

function resolveSpawnInvocation(executable: string, args: string[]): { executable: string; args: string[] } {
  // An absent absolute target is known not sent, even when Windows would successfully
  // spawn cmd.exe first. Bare PATH commands remain the operating system's responsibility.
  if (path.isAbsolute(executable)) {
    const candidates = [executable];
    if (process.platform === "win32" && !path.extname(executable)) {
      candidates.push(...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(extension => `${executable}${extension}`));
    }
    if (!candidates.some(candidate => existsSync(candidate))) {
      throw Object.assign(new Error(`找不到 Codex CLI 启动程序（${executable}）。`), { code: "ENOENT", requestOutcome: "NOT_SENT" });
    }
  }
  if (process.platform !== "win32") return { executable, args };

  // Node 在 Windows 上不能像终端一样直接 spawn .cmd/.bat；显式使用隐藏的
  // cmd.exe，避免 shell:true 的拼接警告，也避免用户看到额外的黑色窗口。
  const isBatchFile = /\.(?:cmd|bat)$/i.test(executable);
  const isBareCommand = !path.extname(executable);
  if (!isBatchFile && !isBareCommand) return { executable, args };

  const commandShell = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  return {
    executable: commandShell,
    args: ["/d", "/s", "/c", executable, ...args]
  };
}

function formatSpawnError(error: unknown, executable: string): Error {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (code === "ENOENT") {
    return new Error(
      `找不到 Codex CLI 启动程序（${executable}）。请确认 CLI 启动程序只填写可执行文件路径，` +
      "不要填写 `& '路径'` 或整段带外层引号的命令。"
    );
  }
  if (code === "EINVAL" && process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    return new Error(`Windows 无法直接启动 ${executable}，请使用 codex.cmd 或让系统自动解析 Codex CLI。`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function resolveCliTimeoutMs(): number {
  const configured = Number(process.env.CODEX_CLI_TIMEOUT_MS ?? "");
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : 30 * 60_000;
}

type CodexRpcResponse = {
  id?: string | number;
  result?: unknown;
  error?: { message?: unknown } | unknown;
};

async function runCodexAppServerStatus(executable: string, cwd: string, timeoutMs: number) {
  return new Promise<Map<string, CodexRpcResponse>>((resolve, reject) => {
    const invocation = resolveSpawnInvocation(executable, ["app-server", "--stdio"]);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const responses = new Map<string, CodexRpcResponse>();
    const expectedIds = new Set(["1", "2", "3", "4"]);
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("读取 Codex CLI 状态超时，请稍后重试。"));
    }, timeoutMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(responses);
    };

    const consumeLine = (line: string) => {
      const normalized = line.trim();
      if (!normalized) return;
      try {
        const response = JSON.parse(normalized) as CodexRpcResponse;
        if (response.id === undefined || response.id === null) return;
        const id = String(response.id);
        if (expectedIds.has(id)) responses.set(id, response);
        if ([...expectedIds].every((expectedId) => responses.has(expectedId))) {
          child.kill();
          finish();
        }
      } catch {
        // app-server 可能输出非协议行；不把原始内容交给页面。
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-200_000);
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on("error", (error) => finish(formatSpawnError(error, executable)));
    child.on("close", (code, signal) => {
      if (settled) return;
      const detail = stderr.trim() || stdout.trim();
      finish(new Error(
        detail && /not logged in|login|unauthorized|authentication/i.test(detail)
          ? "Codex CLI 尚未完成登录，请在本机终端运行 codex 并按提示完成登录。"
          : `Codex CLI 状态读取失败（code=${code ?? "null"}, signal=${signal ?? "none"}）。`
      ));
    });
    child.stdin.on("error", () => {
      // 子进程提前退出时由 close/error 事件统一处理。
    });

    const send = (value: unknown) => {
      try {
        child.stdin.write(`${JSON.stringify(value)}\n`);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("无法发送 Codex CLI 状态请求。"));
      }
    };
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "director-workbench", title: "Director Workbench", version: "0.1.0" },
        capabilities: { experimentalApi: false }
      }
    });
    send({ method: "initialized", params: {} });
    send({ id: 2, method: "account/read", params: { refreshToken: false } });
    send({ id: 3, method: "account/rateLimits/read", params: null });
    send({ id: 4, method: "account/usage/read", params: null });
  });
}

function readRpcResult(responses: Map<string, CodexRpcResponse>, id: string, label: string, warnings: string[]) {
  const response = responses.get(id);
  if (!response) {
    warnings.push(`${label}未返回，请重新检测。`);
    return null;
  }
  if (response.error) {
    warnings.push(`${label}暂时无法读取，请重新检测。`);
    return null;
  }
  return response.result ?? null;
}

function normalizeRateLimits(payload: unknown): CodexCliStatusLimit[] {
  const record = asRecord(payload);
  if (!record) return [];
  const byId = asRecord(record.rateLimitsByLimitId);
  const entries = byId
    ? Object.entries(byId)
    : record.rateLimits
      ? [[asString(asRecord(record.rateLimits)?.limitId) ?? "codex", record.rateLimits] as [string, unknown]]
      : [];
  return entries.map(([fallbackId, value]) => {
    const limit = asRecord(value) ?? {};
    return {
      id: asString(limit.limitId) ?? fallbackId,
      name: asString(limit.limitName),
      planType: asString(limit.planType),
      primary: normalizeWindow(limit.primary),
      secondary: normalizeWindow(limit.secondary),
      credits: normalizeCredits(limit.credits),
      individualLimit: normalizeIndividualLimit(limit.individualLimit),
      rateLimitReachedType: asString(limit.rateLimitReachedType)
    };
  });
}

function normalizeWindow(value: unknown): CodexCliStatusWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const usedPercent = asNumber(record.usedPercent);
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    windowDurationMins: asNumber(record.windowDurationMins),
    resetsAt: asNumber(record.resetsAt)
  };
}

function normalizeCredits(value: unknown): CodexCliStatusCredits | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    balance: asString(record.balance),
    hasCredits: asBoolean(record.hasCredits) ?? false,
    unlimited: asBoolean(record.unlimited) ?? false
  };
}

function normalizeIndividualLimit(value: unknown): CodexCliStatusIndividualLimit | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    limit: asString(record.limit) ?? "",
    used: asString(record.used) ?? "",
    remainingPercent: asNumber(record.remainingPercent) ?? 0,
    resetsAt: asNumber(record.resetsAt)
  };
}

function normalizeUsage(payload: unknown): CodexCliStatus["usage"] {
  const record = asRecord(payload);
  const summary = asRecord(record?.summary);
  const buckets = Array.isArray(record?.dailyUsageBuckets)
    ? record.dailyUsageBuckets
      .map((value) => {
        const bucket = asRecord(value);
        const date = asString(bucket?.startDate);
        const tokens = asNumber(bucket?.tokens);
        return date && tokens !== null ? { date, tokens } : null;
      })
      .filter((value): value is { date: string; tokens: number } => Boolean(value))
    : [];
  return {
    lifetimeTokens: asNumber(summary?.lifetimeTokens),
    peakDailyTokens: asNumber(summary?.peakDailyTokens),
    currentStreakDays: asNumber(summary?.currentStreakDays),
    longestStreakDays: asNumber(summary?.longestStreakDays),
    latestDailyUsage: buckets.at(-1) ?? null
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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
    const invocation = resolveSpawnInvocation(input.executable, input.args);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: input.cwd,
      env: process.env,
      windowsHide: true,
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
      reject(formatSpawnError(error, input.executable));
    });
    child.on("close", (code, signal) => {
      clearTimers();
      if (timedOut) {
        reject(new Error(`CLI执行超过${Math.round(input.timeoutMs / 60_000)}分钟，已停止本岗位。`));
      } else if (code === 0) resolve({ stdout, stderr });
      else {
        const structuredError = readCliError(stdout);
        const rawDetail = structuredError ?? (stderr.trim().slice(-1200) || "CLI 未返回错误详情");
        const detail = formatExecutionErrorForUser(rawDetail, { source: "cli" });
        const failure = new Error(`CLI执行失败（code=${code ?? "null"}, signal=${signal ?? "none"}）：${detail}`) as Error & { rawDetail?: string };
        // 页面展示 friendly message；原始 CLI 文本交给上层写入技术日志，不丢失排查信息。
        failure.rawDetail = rawDetail;
        reject(failure);
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
    const invocation = resolveSpawnInvocation(executable, args);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: process.env,
      windowsHide: true,
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
      reject(formatSpawnError(error, executable));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`命令超过${Math.round(timeoutMs / 1000)}秒。`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `退出码 ${code ?? "null"}`).trim()));
    });
  });
}
