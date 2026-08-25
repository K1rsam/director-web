import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

import { buildRunnerCommand } from "./commands.mjs";

const siteUrl = requiredUrl(process.env.DIRECTOR_SITE_URL);
const runnerToken = requiredEnv("DIRECTOR_RUNNER_TOKEN");
const deviceId = process.env.DIRECTOR_RUNNER_DEVICE_ID?.trim() || hostname();
const projectDir = process.env.DIRECTOR_PROJECT_DIR?.trim() || fileURLToPath(new URL("../../CL/", import.meta.url));
const headers = { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" };

console.log(`[runner] 已启动：${deviceId}`);

while (true) {
  try {
    const job = await claim();
    if (!job) {
      await delay(5_000);
      continue;
    }
    console.log(`[runner] 领取任务 ${job.id} (${job.kind})`);
    await executeAndReport(job);
  } catch (error) {
    console.error(`[runner] ${error instanceof Error ? error.message : String(error)}`);
    await delay(10_000);
  }
}

async function claim() {
  const response = await fetch(`${siteUrl}/api/runner/jobs/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ deviceId }),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`领取任务失败：HTTP ${response.status}`);
  return (await response.json()).job;
}

async function executeAndReport(job) {
  let heartbeat;
  try {
    heartbeat = setInterval(() => void renewLease(job), 60_000);
    const result = job.kind === "smoke" ? smokeResult(job) : await runCommand(buildRunnerCommand(job, projectDir));
    await report(job, "succeeded", result, null);
    console.log(`[runner] 完成任务 ${job.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await report(job, "failed", null, message);
    console.error(`[runner] 任务失败 ${job.id}：${message}`);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function smokeResult(job) {
  return {
    ok: true,
    message: job.payload?.message ?? "Runner connected",
    deviceId,
    completedAt: new Date().toISOString(),
  };
}

async function renewLease(job) {
  try {
    const response = await fetch(`${siteUrl}/api/runner/jobs/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jobId: job.id, leaseToken: job.leaseToken }),
    });
    if (!response.ok) console.error(`[runner] 任务 ${job.id} 心跳失败：HTTP ${response.status}`);
  } catch (error) {
    console.error(`[runner] 任务 ${job.id} 心跳失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function report(job, status, result, error) {
  const response = await fetch(`${siteUrl}/api/runner/jobs/report`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jobId: job.id, leaseToken: job.leaseToken, status, result, error }),
  });
  if (!response.ok) throw new Error(`回传任务失败：HTTP ${response.status}`);
}

function runCommand(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout = tail(stdout + chunk, 100_000)));
    child.stderr.on("data", (chunk) => (stderr = tail(stderr + chunk, 100_000)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ exitCode: 0, stdout, stderr });
      else reject(new Error(tail(stderr || stdout || `本地命令退出码：${code}`, 20_000)));
    });
  });
}

function tail(value, maxLength) {
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function requiredUrl(value) {
  if (!value) throw new Error("缺少环境变量 DIRECTOR_SITE_URL");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("DIRECTOR_SITE_URL 必须使用 HTTPS。");
  }
  return url.toString().replace(/\/$/, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
