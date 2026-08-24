"use client";

import { useState } from "react";

/** 一键复制编译后的 Seedance 提示词（客户端组件）。 */
export function CopyPromptButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copyPromptButton"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(content);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // 剪贴板权限失败时静默（不打断页面）
        }
      }}
      title="复制整段提示词，直接投喂 Seedance"
    >
      {copied ? "已复制 ✓" : "复制提示词"}
    </button>
  );
}
