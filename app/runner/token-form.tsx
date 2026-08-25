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
    <section className="runnerConnectionCard studioCard">
      <div className="runnerConnectionHeader">
        <div>
          <p className="sectionEyebrow">CLI MODE</p>
          <h2>连接自己的 Codex CLI</h2>
          <p>无需项目源码或 CL-sites 文件夹。先确保这台电脑已安装并登录 Codex，再生成专属启动器。</p>
        </div>
        <span className={`runnerConnectionStatus ${state.token ? "connected" : ""}`}>{state.token ? "已生成" : "未连接"}</span>
      </div>
      <form action={action} className="runnerDeviceForm">
        <label><span>设备名称</span><input name="name" placeholder="例如：Mac Studio" maxLength={60} required /></label>
        <button className="glassPrimary runnerPrimaryButton" disabled={pending} type="submit">{pending ? "生成中" : "生成设备启动器"}</button>
      </form>
      {state.error ? <p className="runnerMessage error">{state.error}</p> : null}
      {state.token ? (
        <div className="runnerLauncherPanel">
          <strong>选择这台电脑的系统</strong>
          <p>启动器已包含一次性连接令牌，不需要手动配置环境变量。</p>
          <div className="runnerActions">
            <button className="glassPrimary runnerPrimaryButton" onClick={downloadWindowsLauncher} type="button">下载 Windows 启动器</button>
            <button className="quietButton runnerSecondaryButton" onClick={copyMacCommand} type="button">复制 Mac 启动命令</button>
          </div>
          {copyState ? <p className="runnerMessage success">{copyState}</p> : null}
        </div>
      ) : null}
    </section>
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
