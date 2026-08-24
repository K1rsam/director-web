"use client";

import { useState } from "react";
import { setProjectExecutionModeAction } from "@/app/actions";

/**
 * 执行方式切换：点击瞬间乐观高亮，随后整页刷新与服务端对齐。
 */
export function ModeSwitch({ projectId, current, compact = false }: { projectId: string; current?: string | null; compact?: boolean }) {
  const [mode, setMode] = useState<string>(current === "API" || current === "CLI" ? current : "API");
  const switchTo = (next: "API" | "CLI") => () => {
    setMode(next);
    setTimeout(() => window.location.reload(), 600);
  };
  const apiActive = mode === "API";
  const cliActive = mode === "CLI";
  return (
    <span className={`executionModeSwitch ${compact ? "compact" : ""}`} title={`当前执行方式：${mode}`}>
      <small>{compact ? "渠道" : "执行方式"}</small>
      <form action={setProjectExecutionModeAction} onSubmit={switchTo("API")}>
        <input name="projectId" type="hidden" value={projectId} />
        <input name="executionMode" type="hidden" value="API" />
        <button type="submit" className={`modeButton ${apiActive ? "active" : ""}`} title="使用 DeepSeek API 执行岗位">
          {apiActive ? "● " : ""}{compact ? "API" : "API（DeepSeek）"}
        </button>
      </form>
      <form action={setProjectExecutionModeAction} onSubmit={switchTo("CLI")}>
        <input name="projectId" type="hidden" value={projectId} />
        <input name="executionMode" type="hidden" value="CLI" />
        <button type="submit" className={`modeButton ${cliActive ? "active" : ""}`} title="使用本机 Codex CLI 执行岗位">
          {cliActive ? "● " : ""}{compact ? "CLI" : "CLI（本机 Codex）"}
        </button>
      </form>
      {!compact ? <small className="modeCurrent">当前：{mode}</small> : null}
    </span>
  );
}
