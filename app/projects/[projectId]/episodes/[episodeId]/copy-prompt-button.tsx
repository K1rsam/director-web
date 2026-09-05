"use client";

import { useEffect, useId, useRef, useState } from "react";

/** 一键复制编译后的 Seedance 提示词（客户端组件）。 */
export function CopyPromptButton({
  content,
  label = "复制提示词",
  copiedLabel = "已复制 ✓",
  className = "copyPromptButton",
  disabled = false,
  title = "复制整段提示词，直接投喂 Seedance"
}: {
  content: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ content: string; ok: boolean } | null>(null);
  const copying = useRef(false);
  const feedbackId = useId();
  const feedback = result?.content === content ? result : null;

  useEffect(() => {
    if (!result?.ok) return;
    const timer = window.setTimeout(() => setResult(null), 1500);
    return () => window.clearTimeout(timer);
  }, [result]);

  async function handleCopy() {
    if (disabled || copying.current) return;
    copying.current = true;
    setPending(true);
    setResult(null);
    try {
      await navigator.clipboard.writeText(content);
      setResult({ content, ok: true });
    } catch {
      setResult({ content, ok: false });
    } finally {
      copying.current = false;
      setPending(false);
    }
  }

  return (
    <span className="copyPromptAction">
      <button
        type="button"
        className={`studioButton ${className}`}
        data-variant="secondary"
        data-state={pending ? "pending" : feedback ? feedback.ok ? "success" : "error" : "idle"}
        onClick={handleCopy}
        disabled={disabled || pending}
        aria-busy={pending}
        aria-describedby={feedback ? feedbackId : undefined}
        title={title}
      >
        {pending ? "正在复制…" : feedback ? feedback.ok ? copiedLabel : "复制失败，重试" : label}
      </button>
      {feedback ? (
        <span id={feedbackId} className="actionFeedback" data-state={feedback.ok ? "success" : "error"} role={feedback.ok ? "status" : "alert"}>
          {feedback.ok ? "已复制，可直接粘贴使用。" : "复制失败，请允许剪贴板访问后重试，或手动选中文本复制。"}
        </span>
      ) : null}
    </span>
  );
}
