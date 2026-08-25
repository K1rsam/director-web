"use client";

import { useActionState, useState } from "react";

import { createRunnerTokenAction, type RunnerTokenState } from "@/app/actions";

const initialState: RunnerTokenState = { token: null, error: null };

export function RunnerTokenForm() {
  const [state, action, pending] = useActionState(createRunnerTokenAction, initialState);
  const [copyState, setCopyState] = useState("");

  function downloadWindowsLauncher() {
    if (!state.token) return;
    const siteUrl = window.location.origin;
    const source = windowsLauncher(siteUrl, state.token);
    const url = URL.createObjectURL(new Blob([source], { type: "application/x-msdos-program" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "启动分镜Runner.cmd";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function copyMacCommand() {
    if (!state.token) return;
    const siteUrl = window.location.origin;
    await navigator.clipboard.writeText(macCommand(siteUrl, state.token));
    setCopyState("已复制：打开终端粘贴并回车");
  }

  return (
    <div className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold text-[#6258d5]">CLI 模式</p>
      <h2 className="mt-1 text-lg font-semibold">连接自己的 Codex CLI</h2>
      <p className="mt-1 text-sm leading-6 text-black/55">无需项目源码或 CL-sites 文件夹。先确保这台电脑已安装并登录 Codex，再生成专属启动器。</p>
      <form action={action} className="mt-4 flex gap-2">
        <input className="min-w-0 flex-1 rounded-xl border border-black/15 px-3 py-2.5 outline-none focus:border-[#d84a2b]" name="name" placeholder="例如：Mac Studio" maxLength={60} required />
        <button className="rounded-xl bg-[#201c18] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={pending} type="submit">
          {pending ? "生成中" : "生成设备启动器"}
        </button>
      </form>
      {state.error ? <p className="mt-3 text-sm text-red-700">{state.error}</p> : null}
      {state.token ? (
        <div className="mt-4 rounded-xl border border-[#d84a2b]/25 bg-[#fff3ee] p-3">
          <p className="text-sm font-semibold text-[#a9341d]">选择这台电脑的系统</p>
          <p className="mt-1 text-xs leading-5 text-black/55">启动器已包含一次性连接令牌，不需要手动配置环境变量。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="rounded-xl bg-[#201c18] px-4 py-2.5 text-sm font-semibold text-white" onClick={downloadWindowsLauncher} type="button">下载 Windows 启动器</button>
            <button className="rounded-xl border border-black/15 bg-white px-4 py-2.5 text-sm font-semibold text-black/70" onClick={copyMacCommand} type="button">复制 Mac 启动命令</button>
          </div>
          {copyState ? <p className="mt-2 text-xs font-medium text-emerald-700">{copyState}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function windowsLauncher(siteUrl: string, token: string): string {
  return [
    "@echo off",
    "chcp 65001 >nul",
    "title 分镜工作台 Runner",
    "where node >nul 2>nul || (echo 请先安装 Node.js 18 或更高版本。 & pause & exit /b 1)",
    "where codex >nul 2>nul || (echo 请先安装 Codex CLI，并运行 codex login。 & pause & exit /b 1)",
    'set "RUNNER_DIR=%LOCALAPPDATA%\\DirectorRunner"',
    'if not exist "%RUNNER_DIR%" mkdir "%RUNNER_DIR%"',
    `powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing '${siteUrl}/runner/director-runner.mjs' -OutFile '%RUNNER_DIR%\\runner.mjs'"`,
    `node "%RUNNER_DIR%\\runner.mjs" --site "${siteUrl}" --token "${token}"`,
    "pause",
    "",
  ].join("\r\n");
}

function macCommand(siteUrl: string, token: string): string {
  return `mkdir -p "$HOME/.director-runner" && curl -fsSL '${siteUrl}/runner/director-runner.mjs' -o "$HOME/.director-runner/runner.mjs" && node "$HOME/.director-runner/runner.mjs" --site '${siteUrl}' --token '${token}'`;
}
