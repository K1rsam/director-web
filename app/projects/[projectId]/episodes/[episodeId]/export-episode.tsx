"use client";

import { useId, useState } from "react";
import { CopyPromptButton } from "./copy-prompt-button";

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
  const [downloadState, setDownloadState] = useState<"idle" | "success" | "error">("idle");
  const downloadFeedbackId = useId();

  const buildText = () =>
    units.map((unit) => `【单元 ${unit.unitKey}】\n${unit.content}`).join("\n\n=====\n\n");

  const handleDownload = () => {
    if (!units.length) return;
    let url: string | undefined;
    let anchor: HTMLAnchorElement | undefined;
    try {
      const text = `# ${episodeTitle} · Seedance 单元提示词（${units.length} 个）\n\n${buildText()}\n`;
      const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      url = URL.createObjectURL(blob);
      anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${episodeTitle}-Seedance单元提示词.md`;
      document.body.appendChild(anchor);
      anchor.click();
      setDownloadState("success");
    } catch {
      setDownloadState("error");
    } finally {
      anchor?.remove();
      if (url) {
        const downloadUrl = url;
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
      }
    }
  };

  return (
    <div className="exportEpisodeBar">
      <span>本集 {units.length} 个单元提示词（按单元顺序）</span>
      <div>
        <CopyPromptButton
          content={`# ${episodeTitle} · Seedance 单元提示词（${units.length} 个）\n\n${buildText()}`}
          label="一键复制全部"
          copiedLabel="✓ 已复制全部"
          className="quietButton"
          title={units.length ? "按单元顺序复制本集全部提示词" : "暂无可复制内容"}
          disabled={!units.length}
        />
        <button
          type="button"
          className="studioButton quietButton"
          data-variant="secondary"
          data-state={downloadState}
          onClick={handleDownload}
          disabled={!units.length}
          aria-describedby={downloadState !== "idle" ? downloadFeedbackId : undefined}
          title={units.length ? "导出本集全部提示词为 Markdown 文件" : "暂无可导出内容"}
        >
          {downloadState === "error" ? "导出失败，重试" : "导出 .md 文件"}
        </button>
      </div>
      {downloadState !== "idle" ? (
        <span id={downloadFeedbackId} className="actionFeedback" data-state={downloadState} role={downloadState === "error" ? "alert" : "status"}>
          {downloadState === "error" ? "导出失败，请重试，或使用一键复制全部。" : "下载已发起，请查看浏览器下载列表。"}
        </span>
      ) : null}
    </div>
  );
}
