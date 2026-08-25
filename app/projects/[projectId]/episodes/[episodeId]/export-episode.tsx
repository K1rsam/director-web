"use client";

import { useState } from "react";

/**
 * 本集全部分镜单元提示词：一键复制 / 一键导出（.md 文件）。
 */
export function ExportEpisodeButtons({
  episodeTitle,
  units
}: {
  episodeTitle: string;
  units: Array<{ unitKey: string; content: string }>;
}) {
  const [copied, setCopied] = useState(false);

  const buildText = () =>
    units.map((unit) => `【单元 ${unit.unitKey}】\n${unit.content}`).join("\n\n=====\n\n");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`# ${episodeTitle} · Seedance 单元提示词（${units.length} 个）\n\n${buildText()}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时提示
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const text = `# ${episodeTitle} · Seedance 单元提示词（${units.length} 个）\n\n${buildText()}\n`;
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${episodeTitle}-Seedance单元提示词.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="exportEpisodeBar">
      <span>本集 {units.length} 个单元提示词（按单元顺序）</span>
      <div>
        <button type="button" className="quietButton" onClick={handleCopy} disabled={!units.length}>
          {copied ? "✓ 已复制全部" : "一键复制全部"}
        </button>
        <button type="button" className="quietButton" onClick={handleDownload} disabled={!units.length}>
          导出 .md 文件
        </button>
      </div>
    </div>
  );
}
