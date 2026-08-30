"use client";

import { useActionState, useState } from "react";

import { createRunnerTokenAction, type RunnerTokenState } from "@/app/actions";

const initialState: RunnerTokenState = { token: null, error: null };

export function RunnerTokenForm() {
  const [state, action, pending] = useActionState(createRunnerTokenAction, initialState);
  const [copyState, setCopyState] = useState("");
  const [projectDir, setProjectDir] = useState("E:\\codex-data\\director-web");

  function downloadWindowsLauncher() {
    if (!state.token) return;
    const siteUrl = window.location.origin;
    const source = windowsLauncher(siteUrl, state.token, projectDir);
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
    await navigator.clipboard.writeText(macCommand(siteUrl, state.token, projectDir));
    setCopyState("已复制：打开终端粘贴并回车");
  }

  return (
    <section className="runnerConnectionCard studioCard">
      <div className="runnerConnectionHeader">
        <div>
          <p className="sectionEyebrow">CLI MODE</p>
          <h2>连接自己的 Codex CLI</h2>
          <p>每台电脑都使用自己的 Runner、Codex 账号和额度。请在这台电脑准备与线上协议匹配的执行代码和 Skill；它只负责运行，不读取本机项目数据库。</p>
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
          <p>启动器从线上 D1 下载本次任务快照，放入一次性临时工作库；本地目录只加载 P1/P2/E0–E5 执行代码和 Skill，不读取你的持久项目库。</p>
          <label className="runnerProjectDirField"><span>本地执行代码目录</span><input value={projectDir} onChange={(event) => setProjectDir(event.target.value)} placeholder="例如：E:\\codex-data\\director-web" /></label>
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

function windowsLauncher(siteUrl: string, token: string, projectDir: string): string {
  return [
    "@echo off",
    "chcp 65001 >nul",
    "title 分镜工作台 Runner",
    "where node >nul 2>nul || (echo 请先安装 Node.js 18 或更高版本。 & pause & exit /b 1)",
    "where codex >nul 2>nul || (echo 请先安装 Codex CLI，并运行 codex login。 & pause & exit /b 1)",
    'set "RUNNER_DIR=%LOCALAPPDATA%\\DirectorRunner"',
    'if not exist "%RUNNER_DIR%" mkdir "%RUNNER_DIR%"',
    `powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing '${siteUrl}/runner/director-runner.mjs' -OutFile '%RUNNER_DIR%\\runner.mjs'"`,
    `node "%RUNNER_DIR%\\runner.mjs" --site "${siteUrl}" --token "${token}" --project-dir "${projectDir.replaceAll('"', '')}"`,
    "pause",
    "",
  ].join("\r\n");
}

function macCommand(siteUrl: string, token: string, projectDir: string): string {
  const escapedDir = projectDir.replaceAll("'", "'\\''");
  return `mkdir -p "$HOME/.director-runner" && curl -fsSL '${siteUrl}/runner/director-runner.mjs' -o "$HOME/.director-runner/runner.mjs" && node "$HOME/.director-runner/runner.mjs" --site '${siteUrl}' --token '${token}' --project-dir '${escapedDir}'`;
}
