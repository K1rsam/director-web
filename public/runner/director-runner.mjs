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
  } catch (error) {
    throw new Error(`本机 Codex CLI 检测失败：${messageOf(error)}。如果提示未登录，请在终端运行 codex login 后重新打开启动器。`);
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
