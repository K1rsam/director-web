import { execFile } from "node:child_process";

/**
 * 终止由页面启动的后台 worker 及其子进程。
 * Windows 不支持用负 PID 表示进程组，必须使用 taskkill /T；Unix 继续使用进程组信号。
 */
export async function terminateWorkerProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    await runHiddenCommand("taskkill.exe", ["/PID", String(pid), "/T"]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await runHiddenCommand("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // 进程已经退出。
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 进程已经退出。
  }
}

function runHiddenCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, () => resolve());
  });
}
