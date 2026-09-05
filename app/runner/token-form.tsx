"use client";

import { useActionState, useState } from "react";

import { createRunnerTokenAction, type RunnerTokenState } from "@/app/actions";

const initialState: RunnerTokenState = { token: null, error: null };

export function RunnerTokenForm({ siteBypassToken }: { siteBypassToken: string | null }) {
  const [state, action, pending] = useActionState(createRunnerTokenAction, initialState);
  const [copyState, setCopyState] = useState("");
  const [copyError, setCopyError] = useState(false);
  const [copying, setCopying] = useState(false);
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
    if (!state.token || copying) return;
    setCopying(true);
    setCopyError(false);
    try {
      const siteUrl = window.location.origin;
      await navigator.clipboard.writeText(macCommand(siteUrl, state.token, projectDir, siteBypassToken));
      setCopyState("已复制：打开终端粘贴并回车");
    } catch {
      setCopyError(true);
      setCopyState("复制失败，请允许剪贴板访问后重试。");
    } finally { setCopying(false); }
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
        <button className="studioButton glassPrimary runnerPrimaryButton" data-variant="primary" disabled={pending} aria-busy={pending} type="submit">{pending ? "生成中…" : "生成设备启动器"}</button>
      </form>
      {state.error ? <p className="runnerMessage error" role="alert">{state.error}</p> : null}
      {state.token ? (
        <div className="runnerLauncherPanel">
          <strong>选择这台电脑的系统</strong>
          <p>启动器从线上 D1 下载本次任务快照，放入一次性临时工作库；本地目录只加载 P1/P2/E0–E5 执行代码和 Skill，不读取你的持久项目库。</p>
          <label className="runnerProjectDirField"><span>本地执行代码目录</span><input value={projectDir} onChange={(event) => setProjectDir(event.target.value)} placeholder="例如：E:\\codex-data\\director-web" /></label>
          <div className="runnerActions">
            <button className="glassPrimary runnerPrimaryButton" onClick={downloadWindowsLauncher} type="button">下载 Windows 启动器</button>
            <button className="studioButton quietButton runnerSecondaryButton" data-variant="secondary" onClick={copyMacCommand} disabled={copying} aria-busy={copying} type="button">{copying ? "正在复制…" : copyError ? "重试复制 Mac 命令" : "复制 Mac 启动命令"}</button>
          </div>
          {copyState ? <p className={`runnerMessage ${copyError ? "error" : "success"}`} role={copyError ? "alert" : "status"}>{copyState}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function windowsLauncher(siteUrl: string, token: string, projectDir: string, siteBypassToken: string | null): string {
  const siteHeader = siteBypassToken ? ` --header "OAI-Sites-Authorization: Bearer ${siteBypassToken}"` : "";
  const siteArg = siteBypassToken ? ` --site-bypass-token "${siteBypassToken}"` : "";
  const escapedProjectDir = projectDir.replaceAll('"', "");
  return [
    "@echo off",
    "chcp 65001 >nul",
    "title 分镜工作台 Runner",
    "where node >nul 2>nul || (echo 请先安装 Node.js 18 或更高版本。 & pause & exit /b 1)",
    "where codex >nul 2>nul || (echo 请先安装 Codex CLI；然后在本机终端运行 codex 并按提示完成登录。 & pause & exit /b 1)",
    "where curl.exe >nul 2>nul || (echo 当前 Windows 找不到 curl.exe，无法下载最新 Runner。 & pause & exit /b 1)",
    `set "PROJECT_DIR=${escapedProjectDir}"`,
    'set "RUNNER_DIR=%LOCALAPPDATA%\\DirectorRunner"',
    'if not exist "%RUNNER_DIR%" mkdir "%RUNNER_DIR%"',
    `set "RUNNER_URL=${siteUrl}/runner/director-runner.mjs?download=1"`,
    `set "DIAGNOSTIC_URL=${siteUrl}/runner/diagnostic-log.mjs?download=1"`,
    'set "LOCAL_RUNNER=%PROJECT_DIR%\\public\\runner\\director-runner.mjs"',
    'set "LOCAL_DIAGNOSTIC=%PROJECT_DIR%\\public\\runner\\diagnostic-log.mjs"',
    'set "DIRECTOR_PROXY="',
    'if defined HTTPS_PROXY set "DIRECTOR_PROXY=%HTTPS_PROXY%"',
    'if not defined DIRECTOR_PROXY if defined HTTP_PROXY set "DIRECTOR_PROXY=%HTTP_PROXY%"',
    'if defined DIRECTOR_PROXY call :download_with_proxy',
    'if defined DIRECTOR_PROXY if not errorlevel 1 goto runner_ready',
    'set "DIRECTOR_PROXY="',
    'set "HTTP_PROXY="',
    'set "HTTPS_PROXY="',
    'set "ALL_PROXY="',
    'set "NODE_USE_ENV_PROXY="',
    'call :download_without_proxy',
    'if not errorlevel 1 goto runner_ready',
    'set "DIRECTOR_PROXY=http://127.0.0.1:7890"',
    'call :download_with_proxy',
    'if not errorlevel 1 goto runner_ready',
    'call :copy_local_runner',
    'if not errorlevel 1 goto runner_ready',
    'call :report_launcher_failure',
    `echo 无法连接线上 Runner（可能需要本机网络代理），已停止，不会运行旧版本。请检查网络后重新打开。`,
    `del /q "%RUNNER_DIR%\\runner.mjs.new" >nul 2>nul`,
    `del /q "%RUNNER_DIR%\\diagnostic-log.mjs.new" >nul 2>nul`,
    "pause",
    "exit /b 1",
    ":runner_ready",
    `move /y "%RUNNER_DIR%\\runner.mjs.new" "%RUNNER_DIR%\\runner.mjs" >nul`,
    `if errorlevel 1 (echo 无法更新本机 Runner，已停止，不会运行旧版本。请重新下载启动器。 & pause & exit /b 1)`,
    `move /y "%RUNNER_DIR%\\diagnostic-log.mjs.new" "%RUNNER_DIR%\\diagnostic-log.mjs" >nul`,
    `if errorlevel 1 (echo 无法更新 Runner 诊断模块，已停止。请重新下载启动器。 & pause & exit /b 1)`,
    `node "%RUNNER_DIR%\\runner.mjs" --site "${siteUrl}" --token "${token}"${siteArg} --project-dir "%PROJECT_DIR%"`,
    "pause",
    "exit /b 0",
    "",
    ":download_with_proxy",
    'set "HTTP_PROXY=%DIRECTOR_PROXY%"',
    'set "HTTPS_PROXY=%DIRECTOR_PROXY%"',
    'set "ALL_PROXY=%DIRECTOR_PROXY%"',
    'set "NODE_USE_ENV_PROXY=1"',
    `curl.exe --proxy "%DIRECTOR_PROXY%" --fail --silent --show-error --location --retry 2 --connect-timeout 20${siteHeader} "%RUNNER_URL%" --output "%RUNNER_DIR%\\runner.mjs.new"`,
    'if errorlevel 1 exit /b %errorlevel%',
    `curl.exe --proxy "%DIRECTOR_PROXY%" --fail --silent --show-error --location --retry 2 --connect-timeout 20${siteHeader} "%DIAGNOSTIC_URL%" --output "%RUNNER_DIR%\\diagnostic-log.mjs.new"`,
    "exit /b %errorlevel%",
    "",
    ":download_without_proxy",
    'curl.exe --noproxy "*" --fail --silent --show-error --location --retry 2 --connect-timeout 20' + siteHeader + ' "%RUNNER_URL%" --output "%RUNNER_DIR%\\runner.mjs.new"',
    'if errorlevel 1 exit /b %errorlevel%',
    'curl.exe --noproxy "*" --fail --silent --show-error --location --retry 2 --connect-timeout 20' + siteHeader + ' "%DIAGNOSTIC_URL%" --output "%RUNNER_DIR%\\diagnostic-log.mjs.new"',
    "exit /b %errorlevel%",
    "",
    ":copy_local_runner",
    'if not exist "%LOCAL_RUNNER%" exit /b 1',
    'copy /y "%LOCAL_RUNNER%" "%RUNNER_DIR%\\runner.mjs.new" >nul',
    'if errorlevel 1 exit /b %errorlevel%',
    'if not exist "%LOCAL_DIAGNOSTIC%" exit /b 1',
    'copy /y "%LOCAL_DIAGNOSTIC%" "%RUNNER_DIR%\\diagnostic-log.mjs.new" >nul',
    "exit /b %errorlevel%",
    "",
    ":report_launcher_failure",
    `set "DIAG_SITE=${siteUrl}"`,
    `set "DIAG_TOKEN=${token}"`,
    `set "DIAG_DEVICE=%COMPUTERNAME%"`,
    siteBypassToken ? `set "DIAG_BYPASS=${siteBypassToken}"` : 'set "DIAG_BYPASS="',
    `node -e "const site=process.env.DIAG_SITE,token=process.env.DIAG_TOKEN,bypass=process.env.DIAG_BYPASS;const event={schemaVersion:1,eventId:'launcher-'+Date.now(),occurredAt:new Date().toISOString(),severity:'error',kind:'launcher_download_failed',code:'LAUNCHER_DOWNLOAD_FAILED',operation:'launcher_download',message:'无法下载最新 Runner。',deviceId:process.env.DIAG_DEVICE||'unknown'};fetch(site+'/api/runner/diagnostics/report',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...(bypass?{'OAI-Sites-Authorization':'Bearer '+bypass}:{})},body:JSON.stringify({schemaVersion:1,scope:'minimal',event})}).catch(()=>{});" >nul 2>nul`,
    "exit /b 0",
  ].join("\r\n");
}

function macCommand(siteUrl: string, token: string, projectDir: string, siteBypassToken: string | null): string {
  const escapedDir = projectDir.replaceAll("'", "'\\''");
  const escapedBypassToken = siteBypassToken?.replaceAll("'", "'\\''");
  const siteHeader = escapedBypassToken ? ` -H 'OAI-Sites-Authorization: Bearer ${escapedBypassToken}'` : "";
  const siteArg = escapedBypassToken ? ` --site-bypass-token '${escapedBypassToken}'` : "";
  return `mkdir -p "$HOME/.director-runner" && curl -fsSL${siteHeader} '${siteUrl}/runner/director-runner.mjs' -o "$HOME/.director-runner/runner.mjs" && curl -fsSL${siteHeader} '${siteUrl}/runner/diagnostic-log.mjs' -o "$HOME/.director-runner/diagnostic-log.mjs" && node "$HOME/.director-runner/runner.mjs" --site '${siteUrl}' --token '${token}'${siteArg} --project-dir '${escapedDir}'`;
}
