import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const siteUrl = requiredUrl(args.site);
const runnerToken = required(args.token, "缺少设备连接令牌。请从网站重新生成启动器。");
const deviceId = args.device || hostname();
const headers = { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" };
const codexCommand = process.platform === "win32" ? "codex.cmd" : "codex";

await verifyCodex();
console.log(`\n✓ 本机 Codex 已登录`);
console.log(`✓ 分镜工作台已连接：${deviceId}`);
console.log("保持此窗口打开即可使用 CLI；按 Ctrl+C 可停止。\n");

while (true) {
  try {
    const job = await claim();
    if (!job) {
      await delay(5_000);
      continue;
    }
    console.log(`收到任务：${job.kind}`);
    await executeAndReport(job);
  } catch (error) {
    console.error(`连接异常：${messageOf(error)}`);
    await delay(10_000);
  }
}

async function verifyCodex() {
  if (Number(process.versions.node.split(".")[0]) < 18) {
    throw new Error("Node.js 版本过低，请安装 Node.js 18 或更高版本。");
  }
  try {
    await runProcess(codexCommand, ["login", "status"], null, 20_000);
  } catch {
    throw new Error("Codex CLI 尚未安装或登录。请先在终端运行 codex login，再重新打开启动器。");
  }
}

async function claim() {
  const response = await fetch(`${siteUrl}/api/runner/jobs/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ deviceId }),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`领取任务失败（${response.status}）`);
  return (await response.json()).job;
}

async function executeAndReport(job) {
  let heartbeat;
  try {
    heartbeat = setInterval(() => void renewLease(job), 60_000);
    const result = job.kind === "smoke"
      ? { ok: true, message: job.payload?.message ?? "Runner connected", deviceId, completedAt: new Date().toISOString() }
      : job.kind === "codex_prompt"
        ? await runCodexPrompt(job.payload)
        : (() => { throw new Error(`当前启动器不支持任务类型：${String(job.kind)}`); })();
    await report(job, "succeeded", result, null);
    console.log("✓ 任务完成");
  } catch (error) {
    const message = messageOf(error);
    await report(job, "failed", null, message);
    console.error(`✗ 任务失败：${message}`);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
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
    const child = spawn(command, commandArgs, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
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
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(tail(stderr || stdout || `Codex 退出码：${code}`, 20_000)));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
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
