import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = parseArgs(process.argv.slice(2));
const siteUrl = requiredUrl(args.site);
const runnerToken = required(args.token, "缺少设备连接令牌。请从网站重新生成启动器。");
const deviceId = args.device || hostname();
const projectDir = args["project-dir"] || process.env.DIRECTOR_PROJECT_DIR || "";
const siteBypassToken = args["site-bypass-token"] || process.env.DIRECTOR_SITE_BYPASS_TOKEN || "";
const headers = {
  authorization: `Bearer ${runnerToken}`,
  "content-type": "application/json",
  ...(siteBypassToken ? { "OAI-Sites-Authorization": `Bearer ${siteBypassToken}` } : {}),
};
const codexCommand = process.platform === "win32" ? "codex.cmd" : "codex";
const STATUS_REFRESH_MS = 5 * 60_000;
let lastStatusAttemptAt = 0;

await verifyCodex();
const initialStatusSynced = await refreshCodexStatus(true);
console.log(`\n✓ 本机 Codex CLI 已就绪（登录状态由本机 app-server 检查）`);
console.log(initialStatusSynced ? "✓ 本机账号、额度与用量状态已同步到线上" : "! 本机账号已就绪，但线上额度状态暂未同步");
console.log(`✓ 分镜工作台已连接：${deviceId}`);
console.log("保持此窗口打开即可使用 CLI；按 Ctrl+C 可停止。\n");

while (true) {
  try {
    await refreshCodexStatus();
    const job = await claim();
    if (!job) {
      await delay(5_000);
      continue;
    }
    console.log(`收到任务：${job.kind}`);
    await executeAndReport(job);
  } catch (error) {
    console.error(`连接异常：${messageOf(error)}`);
    if (isFatalRunnerError(error)) {
      console.error("Runner 已停止：请回网站“API 与 CLI”重新生成这台设备的启动器，再重新打开。\n");
      process.exitCode = 1;
      break;
    }
    await delay(10_000);
  }
}

async function verifyCodex() {
  if (Number(process.versions.node.split(".")[0]) < 18) {
    throw new Error("Node.js 版本过低，请安装 Node.js 18 或更高版本。");
  }
  try {
    await runProcess(codexCommand, ["--version"], null, 20_000);
  } catch (error) {
    throw new Error(`本机 Codex CLI 检测失败：${messageOf(error)}。请在本机终端运行 codex，按提示完成登录后重新打开启动器。`);
  }
}

/** 只读取本机 CLI 的状态，不调用模型；读取失败不阻塞任务领取。 */
async function refreshCodexStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastStatusAttemptAt < STATUS_REFRESH_MS) return;
  lastStatusAttemptAt = now;
  try {
    const status = await readCodexStatus();
    const response = await fetch(`${siteUrl}/api/runner/status`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status }),
    });
    if (!response.ok) throw await runnerHttpError(response, "回传本机状态");
    return true;
  } catch (error) {
    if (isLocalCodexAuthError(error)) {
      throw new Error("本机 Codex 尚未完成登录。请在本机终端运行 codex，按提示完成登录后重新打开启动器。");
    }
    if (isFatalRunnerError(error)) throw error;
    console.warn(`本机额度状态暂时未同步：${messageOf(error)}`);
    return false;
  }
}

async function readCodexStatus() {
  let versionResult;
  try {
    versionResult = await runProcess(codexCommand, ["--version"], null, 20_000);
  } catch (error) {
    throw new Error(`Codex CLI 不可用：${messageOf(error)}`);
  }
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  if (!/codex-cli/i.test(versionText)) {
    throw new Error("Codex CLI 版本检查未通过，请确认本机终端中的 codex --version 可用。");
  }
  const version = versionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /codex-cli/i.test(line)) || "Codex CLI";

  const responses = await runCodexAppServerStatus(20_000);
  const warnings = [];
  const accountPayload = readRpcResult(responses, "2", "账号状态", warnings);
  const accountRecord = asRecord(asRecord(accountPayload)?.account);
  if (!accountRecord) throw new Error("Codex CLI 尚未完成登录，请在本机终端运行 codex 并按提示完成登录。");

  const ratePayload = readRpcResult(responses, "3", "额度状态", warnings);
  const usagePayload = readRpcResult(responses, "4", "用量状态", warnings);
  return {
    version,
    account: {
      type: asString(accountRecord.type) || "unknown",
      email: asString(accountRecord.email),
      planType: asString(accountRecord.planType),
    },
    limits: normalizeRateLimits(ratePayload),
    usage: normalizeUsage(usagePayload),
    checkedAt: new Date().toISOString(),
    warnings,
  };
}

function runCodexAppServerStatus(timeoutMs) {
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(codexCommand, ["app-server", "--stdio"]);
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`启动 Codex 状态读取失败：${messageOf(error)}`));
      return;
    }

    const responses = new Map();
    const expectedIds = new Set(["1", "2", "3", "4"]);
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(responses);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("读取 Codex CLI 状态超时，请稍后重试。"));
    }, timeoutMs);

    const consumeLine = (line) => {
      const normalized = line.trim();
      if (!normalized) return;
      try {
        const response = JSON.parse(normalized);
        if (response.id === undefined || response.id === null) return;
        const id = String(response.id);
        if (expectedIds.has(id)) responses.set(id, response);
        if ([...expectedIds].every((expectedId) => responses.has(expectedId))) {
          child.kill("SIGTERM");
          finish();
        }
      } catch {
        // 忽略 app-server 的非协议行，不把原始输出回传到网站。
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = tail(stdout + chunk, 200_000);
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => { stderr = tail(stderr + chunk, 20_000); });
    child.on("error", (error) => finish(new Error(`启动 Codex 状态读取失败：${messageOf(error)}`)));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (buffer.trim()) consumeLine(buffer);
      if (settled) return;
      const detail = stderr.trim() || stdout.trim();
      finish(detail && /not logged in|login|unauthorized|authentication/i.test(detail)
        ? new Error("Codex CLI 尚未完成登录，请在本机终端运行 codex 并按提示完成登录。")
        : new Error(`Codex CLI 状态读取失败（code=${code ?? "null"}, signal=${signal ?? "none"}）。`));
    });
    child.stdin.on("error", () => {
      // 子进程提前退出时由 close/error 事件统一处理。
    });

    const send = (value) => {
      try {
        child.stdin.write(`${JSON.stringify(value)}\n`);
      } catch (error) {
        finish(new Error(`无法发送 Codex CLI 状态请求：${messageOf(error)}`));
      }
    };
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "director-workbench", title: "Director Workbench", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      },
    });
    send({ method: "initialized", params: {} });
    send({ id: 2, method: "account/read", params: { refreshToken: false } });
    send({ id: 3, method: "account/rateLimits/read", params: null });
    send({ id: 4, method: "account/usage/read", params: null });
  });
}

function readRpcResult(responses, id, label, warnings) {
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

function normalizeRateLimits(payload) {
  const value = asRecord(payload);
  if (!value) return [];
  const byId = asRecord(value.rateLimitsByLimitId);
  const entries = byId
    ? Object.entries(byId)
    : value.rateLimits
      ? [[asString(asRecord(value.rateLimits)?.limitId) || "codex", value.rateLimits]]
      : [];
  return entries.slice(0, 8).map(([fallbackId, raw]) => {
    const limit = asRecord(raw) || {};
    return {
      id: asString(limit.limitId) || fallbackId,
      name: asString(limit.limitName),
      planType: asString(limit.planType),
      primary: normalizeWindow(limit.primary),
      secondary: normalizeWindow(limit.secondary),
      credits: normalizeCredits(limit.credits),
      individualLimit: normalizeIndividualLimit(limit.individualLimit),
      rateLimitReachedType: asString(limit.rateLimitReachedType),
    };
  });
}

function normalizeWindow(value) {
  const item = asRecord(value);
  if (!item) return null;
  const usedPercent = asNumber(item.usedPercent);
  const remainingPercent = asNumber(item.remainingPercent);
  return {
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(remainingPercent === null && usedPercent !== null ? 100 - usedPercent : remainingPercent),
    windowDurationMins: asNumber(item.windowDurationMins),
    resetsAt: asNumber(item.resetsAt),
  };
}

function normalizeCredits(value) {
  const item = asRecord(value);
  if (!item) return null;
  return {
    balance: asString(item.balance),
    hasCredits: asBoolean(item.hasCredits) || false,
    unlimited: asBoolean(item.unlimited) || false,
  };
}

function normalizeIndividualLimit(value) {
  const item = asRecord(value);
  if (!item) return null;
  return {
    limit: asString(item.limit) || "",
    used: asString(item.used) || "",
    remainingPercent: clampPercent(asNumber(item.remainingPercent)) ?? 0,
    resetsAt: asNumber(item.resetsAt),
  };
}

function normalizeUsage(payload) {
  const item = asRecord(payload);
  const summary = asRecord(item?.summary);
  const buckets = Array.isArray(item?.dailyUsageBuckets)
    ? item.dailyUsageBuckets
      .map((value) => {
        const bucket = asRecord(value);
        const date = asString(bucket?.startDate);
        const tokens = asNumber(bucket?.tokens);
        return date && tokens !== null ? { date, tokens: Math.max(0, tokens) } : null;
      })
      .filter(Boolean)
    : [];
  return {
    lifetimeTokens: nonNegativeNumber(summary?.lifetimeTokens),
    peakDailyTokens: nonNegativeNumber(summary?.peakDailyTokens),
    currentStreakDays: asNumber(summary?.currentStreakDays),
    longestStreakDays: asNumber(summary?.longestStreakDays),
    latestDailyUsage: buckets.at(-1) || null,
  };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function nonNegativeNumber(value) {
  const numberValue = asNumber(value);
  return numberValue === null ? null : Math.max(0, numberValue);
}

function clampPercent(value) {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

async function claim() {
  const response = await fetch(`${siteUrl}/api/runner/jobs/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ deviceId }),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw await runnerHttpError(response, "领取任务");
  return (await response.json()).job;
}

async function runnerHttpError(response, operation) {
  let detail = "";
  try {
    const body = await response.json();
    if (body && typeof body.error === "string") detail = body.error.trim();
  } catch {
    // 只使用状态码，不读取或输出任何响应原文。
  }
  const status = response.status;
  let message;
  if (status === 401) {
    message = `线上设备令牌无效或已撤销（${operation}，401）。请回网站“API 与 CLI”重新生成这台设备的启动器。`;
  } else if (status === 403) {
    message = `线上拒绝这台设备的连接（${operation}，403）。这不是本机 Codex 登录问题，请确认启动器来自当前 Site，并重新生成后再试。`;
  } else if (status === 404) {
    message = `线上 Runner 接口不存在（${operation}，404）。请从当前 Site 重新下载启动器。`;
  } else {
    message = `线上${operation}失败（${status}）${detail ? `：${detail.slice(0, 180)}` : ""}`;
  }
  const error = new Error(message);
  error.runnerStatus = status;
  return error;
}

function isFatalRunnerError(error) {
  return Boolean(error && typeof error === "object" && [401, 403, 404].includes(error.runnerStatus));
}

function isLocalCodexAuthError(error) {
  return /not logged in|login required|unauthorized|authentication|尚未完成登录|尚未登录/i.test(messageOf(error));
}

async function executeAndReport(job) {
  let heartbeat;
  try {
    heartbeat = setInterval(() => void renewLease(job), 60_000);
    let result;
    let resultError = null;
    if (job.kind === "smoke") {
      result = { ok: true, message: job.payload?.message ?? "Runner connected", deviceId, completedAt: new Date().toISOString() };
    } else if (job.kind === "codex_prompt") {
      result = await runCodexPrompt(job.payload);
    } else if (job.kind === "project_foundation" || job.kind === "episode_pipeline") {
      const local = await runLocalPipelineJob(job);
      result = local.result;
      resultError = local.error;
    } else {
      throw new Error(`当前启动器不支持任务类型：${String(job.kind)}`);
    }
    await report(job, resultError ? "failed" : "succeeded", result, resultError);
    if (resultError) console.error(`✗ 任务失败：${resultError}`);
    else console.log("✓ 任务完成");
  } catch (error) {
    const message = messageOf(error);
    await report(job, "failed", null, message);
    console.error(`✗ 任务失败：${message}`);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await refreshCodexStatus(true);
  }
}

async function runLocalPipelineJob(job) {
  if (!projectDir) throw new Error("缺少本地执行代码目录。请重新下载启动器，并填写 director-web 本地目录。线上数据不会从本机项目库读取。");
  const workDir = await mkdtemp(join(tmpdir(), "director-runner-pipeline-"));
  const inputFile = join(workDir, "input.json");
  const outputFile = join(workDir, "output.json");
  try {
    const input = await requestJobInput(job);
    await writeFile(inputFile, JSON.stringify(input));
    const tsxDist = join(projectDir, "node_modules", "tsx", "dist");
    const bridge = join(projectDir, "scripts", "run-runner-job.ts");
    const commandArgs = [
      "--require", join(tsxDist, "preflight.cjs"),
      "--import", pathToFileURL(join(tsxDist, "loader.mjs")).href,
      bridge,
      "--input", inputFile,
      "--output", outputFile,
    ];
    const processResult = await runProcessOutcome(process.execPath, commandArgs, null, 2 * 60 * 60_000, projectDir);
    let result = null;
    try {
      result = JSON.parse(await readFile(outputFile, "utf8"));
    } catch {
      if (processResult.code !== 0) throw new Error(tail(processResult.stderr || processResult.stdout || `本地执行桥退出码：${processResult.code}`, 20_000));
      throw new Error("本地执行桥没有返回结果文件。");
    }
    const executionError = result?.meta?.executionError;
    const error = processResult.code === 0 && !executionError
      ? null
      : String(executionError || tail(processResult.stderr || processResult.stdout || `本地执行桥退出码：${processResult.code}`, 20_000));
    return { result, error };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function requestJobInput(job) {
  const response = await fetch(`${siteUrl}/api/runner/jobs/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jobId: job.id, leaseToken: job.leaseToken }),
  });
  if (!response.ok) throw new Error(`读取线上任务包失败（${response.status}）`);
  const body = await response.json();
  if (!body?.input) throw new Error("线上任务包为空。");
  return body.input;
}

async function runCodexPrompt(payload) {
  const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
  const model = typeof payload?.model === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(payload.model)
    ? payload.model
    : null;
  if (!prompt || prompt.length > 180_000) throw new Error("任务提示词为空或过长。");

  const workDir = await mkdtemp(join(tmpdir(), "director-runner-"));
  const outputFile = join(workDir, "final.txt");
  try {
    const commandArgs = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--output-last-message",
      outputFile,
      ...(model ? ["--model", model] : []),
      "-",
    ];
    const processResult = await runProcess(codexCommand, commandArgs, prompt, 60 * 60_000, workDir);
    const output = await readFile(outputFile, "utf8");
    return { output, model: model ?? "Codex 默认模型", log: tail(processResult.stdout, 20_000) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function renewLease(job) {
  try {
    await fetch(`${siteUrl}/api/runner/jobs/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jobId: job.id, leaseToken: job.leaseToken }),
    });
  } catch {
    // The final report will surface a lost connection.
  }
}

async function report(job, status, result, error) {
  const response = await fetch(`${siteUrl}/api/runner/jobs/report`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jobId: job.id, leaseToken: job.leaseToken, status, result, error }),
  });
  if (!response.ok) throw new Error(`回传任务失败（${response.status}）`);
}

function runProcess(command, commandArgs, input, timeoutMs, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(command, commandArgs);
    let child;
    try {
      child = spawn(spec.command, spec.args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(new Error(`启动 ${command} 失败：${messageOf(error)}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("本机 CLI 执行超时。"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout = tail(stdout + chunk, 100_000)));
    child.stderr.on("data", (chunk) => (stderr = tail(stderr + chunk, 100_000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`启动 ${command} 失败：${messageOf(error)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${tail(stderr || stdout || `Codex CLI 退出码：${code}`, 20_000)}（退出码 ${code}）`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runProcessOutcome(command, commandArgs, input, timeoutMs, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(command, commandArgs);
    let child;
    try {
      child = spawn(spec.command, spec.args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("本地流水线执行超时。"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout = tail(stdout + chunk, 100_000)));
    child.stderr.on("data", (chunk) => (stderr = tail(stderr + chunk, 100_000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function spawnSpec(command, commandArgs) {
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...commandArgs],
    };
  }
  return { command, args: commandArgs };
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (key && value) result[key] = value;
  }
  return result;
}

function required(value, message) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function requiredUrl(value) {
  const url = new URL(required(value, "缺少网站地址。"));
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("网站地址必须使用 HTTPS。");
  }
  return url.toString().replace(/\/$/, "");
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function tail(value, maxLength) {
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
