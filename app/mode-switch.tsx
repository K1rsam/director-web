"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { setProjectExecutionModeAction } from "@/app/actions";

/**
 * 执行方式切换：点击瞬间乐观高亮，随后整页刷新与服务端对齐。
 */
export function ModeSwitch({ projectId, current, compact = false }: { projectId: string; current?: string | null; compact?: boolean }) {
  const [mode, setMode] = useState<string>(current === "API" || current === "CLI" ? current : "API");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const hadPending = useRef(false);
  const handlePendingChange = useCallback((value: boolean) => {
    setPending(value);
    if (value) hadPending.current = true;
    else if (hadPending.current) {
      hadPending.current = false;
      submitting.current = false;
      // 等服务端 action 完成再刷新，避免固定延时打断尚未完成的保存。
      window.location.reload();
    }
  }, []);
  const switchTo = (next: "API" | "CLI") => (event: FormEvent<HTMLFormElement>) => {
    if (submitting.current) {
      event.preventDefault();
      return;
    }
    submitting.current = true;
    setMode(next);
  };
  const apiActive = mode === "API";
  const cliActive = mode === "CLI";
  return (
    <span className={`executionModeSwitch ${compact ? "compact" : ""}`} role="group" aria-label="执行方式" aria-busy={pending} title={`当前执行方式：${mode}`}>
      <small>{compact ? "渠道" : "执行方式"}</small>
      <form action={setProjectExecutionModeAction} onSubmit={switchTo("API")}>
        <input name="projectId" type="hidden" value={projectId} />
        <input name="executionMode" type="hidden" value="API" />
        <ModeSubmitButton selected={apiActive} disabled={pending} label={compact ? "API" : "API（DeepSeek）"} title="使用 DeepSeek API 执行岗位" onPendingChange={handlePendingChange} />
      </form>
      <form action={setProjectExecutionModeAction} onSubmit={switchTo("CLI")}>
        <input name="projectId" type="hidden" value={projectId} />
        <input name="executionMode" type="hidden" value="CLI" />
        <ModeSubmitButton selected={cliActive} disabled={pending} label={compact ? "CLI" : "CLI（本机 Codex）"} title="使用本机 Codex CLI 执行岗位" onPendingChange={handlePendingChange} />
      </form>
      {!compact ? <small className="modeCurrent">当前：{mode}</small> : null}
    </span>
  );
}

function ModeSubmitButton({ selected, disabled, label, title, onPendingChange }: {
  selected: boolean;
  disabled: boolean;
  label: string;
  title: string;
  onPendingChange: (pending: boolean) => void;
}) {
  const { pending } = useFormStatus();
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);
  return (
    <button
      type="submit"
      className={`modeButton ${selected ? "active" : ""}`}
      data-control="choice"
      aria-pressed={selected}
      aria-busy={pending}
      disabled={disabled || pending}
      title={pending ? "正在保存执行方式…" : title}
    >
      {selected ? "● " : ""}{label}
    </button>
  );
}
