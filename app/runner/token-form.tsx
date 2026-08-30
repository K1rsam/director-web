"use client";

import { useActionState, useState } from "react";

import { createRunnerTokenAction, type RunnerTokenState } from "@/app/actions";

const initialState: RunnerTokenState = { token: null, error: null };

export function RunnerTokenForm({ siteBypassToken }: { siteBypassToken: string | null }) {
  const [state, action, pending] = useActionState(createRunnerTokenAction, initialState);
  const [copyState, setCopyState] = useState("");
  const [projectDir, setProjectDir] = useState("E:\\codex-data\\director-web");

  function downloadWindowsLauncher() {
    if (!state.token) return;
    const siteUrl = window.location.origin;
    const source = windowsLauncher(siteUrl, state.token, projectDir, siteBypassToken);
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
    await navigator.clipboard.writeText(macCommand(siteUrl, state.token, projectDir, siteBypassToken));
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

function windowsLauncher(siteUrl: string, token: string, projectDir: string, siteBypassToken: string | null): string {
  const siteHeader = siteBypassToken ? ` --header "OAI-Sites-Authorization: Bearer ${siteBypassToken}"` : "";
  const siteArg = siteBypassToken ? ` --site-bypass-token "${siteBypassToken}"` : "";
  return [
    "@echo off",
    "chcp 65001 >nul",
    "title 分镜工作台 Runner",
    "where node >nul 2>nul || (echo 请先安装 Node.js 18 或更高版本。 & pause & exit /b 1)",
    "where codex >nul 2>nul || (echo 请先安装 Codex CLI；然后在本机终端运行 codex 并按提示完成登录。 & pause & exit /b 1)",
    "where curl.exe >nul 2>nul || (echo 当前 Windows 找不到 curl.exe，无法下载最新 Runner。 & pause & exit /b 1)",
    'set "RUNNER_DIR=%LOCALAPPDATA%\\DirectorRunner"',
    'if not exist "%RUNNER_DIR%" mkdir "%RUNNER_DIR%"',
    `set "RUNNER_URL=${siteUrl}/runner/director-runner.mjs?download=1"`,
    `curl.exe --fail --silent --show-error --location --retry 2 --connect-timeout 20${siteHeader} "%RUNNER_URL%" --output "%RUNNER_DIR%\\runner.mjs.new"`,
    `if errorlevel 1 (echo 无法下载最新 Runner，已停止，不会运行旧版本。请检查网络后重新打开。 & del /q "%RUNNER_DIR%\\runner.mjs.new" >nul 2>nul & pause & exit /b 1)`,
    `move /y "%RUNNER_DIR%\\runner.mjs.new" "%RUNNER_DIR%\\runner.mjs" >nul`,
    `if errorlevel 1 (echo 无法更新本机 Runner，已停止，不会运行旧版本。请重新下载启动器。 & pause & exit /b 1)`,
    `node "%RUNNER_DIR%\\runner.mjs" --site "${siteUrl}" --token "${token}"${siteArg} --project-dir "${projectDir.replaceAll('"', '')}"`,
    "pause",
    "",
  ].join("\r\n");
}

function macCommand(siteUrl: string, token: string, projectDir: string, siteBypassToken: string | null): string {
  const escapedDir = projectDir.replaceAll("'", "'\\''");
  const escapedBypassToken = siteBypassToken?.replaceAll("'", "'\\''");
  const siteHeader = escapedBypassToken ? ` -H 'OAI-Sites-Authorization: Bearer ${escapedBypassToken}'` : "";
  const siteArg = escapedBypassToken ? ` --site-bypass-token '${escapedBypassToken}'` : "";
  return `mkdir -p "$HOME/.director-runner" && curl -fsSL${siteHeader} '${siteUrl}/runner/director-runner.mjs' -o "$HOME/.director-runner/runner.mjs" && node "$HOME/.director-runner/runner.mjs" --site '${siteUrl}' --token '${token}'${siteArg} --project-dir '${escapedDir}'`;
}
