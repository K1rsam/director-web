"use client";

import { startEpisodePipelineAction } from "@/app/actions";

export function EpisodePipelineButton({
  projectId,
  episodeId,
  active,
  hasContent,
  activeLabel,
}: {
  projectId: string;
  episodeId: string;
  active: boolean;
  hasContent: boolean;
  released: boolean;
  activeLabel?: string;
}) {
  return (
    <form action={startEpisodePipelineAction}>
      <input name="projectId" type="hidden" value={projectId} />
      <input name="episodeId" type="hidden" value={episodeId} />
      <button
        type="submit"
        className={`episodePipelineButton ${hasContent ? "rerun" : "firstRun"}`}
        disabled={active}
      >
        <strong>{active ? activeLabel ?? "正在执行 E0–E5…" : hasContent ? "重新执行本集 E0–E5" : "开始本集 E0–E5"}</strong>
        {!active && !hasContent ? <small>由已连接 Runner 执行</small> : null}
      </button>
    </form>
  );
}
