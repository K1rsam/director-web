"use client";

import { useState } from "react";
import { restorePromptVersionAction, saveManualPromptVersionAction } from "@/app/actions";
import { CopyPromptButton } from "./copy-prompt-button";

export type UnitPromptVersion = {
  id: string;
  version: number;
  content: string;
  syncStatus: "RELEASE_COMPILED" | "DRAFT_COMPILED" | string;
};

/**
 * 单元提示词卡（版本管理）：
 * - 版本 chip 直接点选预览（不影响"当前"版本），非当前版本时出现「恢复此版本」；
 * - 「编辑」就地展开编辑框，保存即另存为新版本（不覆盖编译产物）。
 */
export function UnitPromptCard({
  projectId,
  episodeId,
  unitId,
  openIssueCount,
  versions,
  currentVersionId,
  pipelineActive
}: {
  projectId: string;
  episodeId: string;
  unitId: string;
  openIssueCount: number;
  versions: UnitPromptVersion[];
  currentVersionId: string;
  pipelineActive: boolean;
}) {
  const [selectedId, setSelectedId] = useState(currentVersionId);
  const [editing, setEditing] = useState(false);

  const selected = versions.find((version) => version.id === selectedId) ?? versions[0];
  if (!selected) return null;
  const isCurrent = selected.id === currentVersionId;
  const currentVersion = versions.find((version) => version.id === currentVersionId);

  return (
    <div className="seedancePrompt">
      <div className="seedancePromptHead">
        <span className={`seedancePromptTag ${isCurrent && selected.syncStatus === "RELEASE_COMPILED" ? "released" : "draft"}`}>
          {isCurrent && selected.syncStatus === "RELEASE_COMPILED" ? "✓ 已放行" : isCurrent ? "◌ 当前草稿" : "◌ 预览"}
          {openIssueCount > 0 ? ` · 待修${openIssueCount}条` : ""} · Seedance 提示词 V{selected.version}
        </span>
        <CopyPromptButton content={selected.content} />
      </div>

      <div className="promptVersionChips">
        {versions.map((version) => {
          const active = version.id === selectedId;
          const isCurrentVersion = version.id === currentVersionId;
          return (
            <button
              type="button"
              key={version.id}
              className={`promptVersionChip ${active ? "active" : ""} ${isCurrentVersion ? "current" : ""}`}
              onClick={() => {
                setSelectedId(version.id);
                setEditing(false);
              }}
              title={isCurrentVersion ? "当前版本" : "点击预览此版本"}
            >
              V{version.version}
              {isCurrentVersion ? "·当前" : ""}
            </button>
          );
        })}
        <button
          type="button"
          className={`promptVersionChip edit ${editing ? "active" : ""}`}
          onClick={() => setEditing((value) => !value)}
          disabled={pipelineActive}
          title="就地编辑，保存为手动新版本"
        >
          ✎ 编辑
        </button>
      </div>

      {!isCurrent && !editing ? (
        <div className="promptVersionRestore">
          <span>正在预览 V{selected.version}（当前为 V{currentVersion?.version ?? "?"}）。恢复后此版本将设为当前显示。</span>
          <form action={restorePromptVersionAction}>
            <input name="projectId" type="hidden" value={projectId} />
            <input name="episodeId" type="hidden" value={episodeId} />
            <input name="versionId" type="hidden" value={selected.id} />
            <button type="submit" className="quietButton" disabled={pipelineActive}>恢复此版本</button>
          </form>
        </div>
      ) : null}

      {editing ? (
        <form action={saveManualPromptVersionAction} className="promptManualEdit">
          <input name="projectId" type="hidden" value={projectId} />
          <input name="episodeId" type="hidden" value={episodeId} />
          <input name="unitId" type="hidden" value={unitId} />
          <textarea name="content" rows={10} defaultValue={selected.content} placeholder="直接修改本单元提示词…" />
          <div className="promptManualEditFoot">
            <button type="submit" className="quietButton" disabled={pipelineActive}>另存为新版本 V{versions.length + 1}</button>
            <button type="button" className="quietButton" onClick={() => setEditing(false)}>取消</button>
            <small>手动版本标记为草稿，不影响后续编译产物；可在版本 chip 中随时切换回编译版。</small>
          </div>
        </form>
      ) : (
        <pre>{selected.content}</pre>
      )}
    </div>
  );
}
