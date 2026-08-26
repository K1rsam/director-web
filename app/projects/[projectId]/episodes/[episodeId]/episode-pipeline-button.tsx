"use client";

export function EpisodePipelineButton({
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
    <button
      type="button"
      className={`episodePipelineButton ${hasContent ? "rerun" : "firstRun"}`}
      disabled
      title="执行引擎将在 API/Runner 阶段接通"
    >
      <strong>{active ? activeLabel ?? "正在执行 E0–E5…" : hasContent ? "重新执行本集 E0–E5" : "开始本集 E0–E5"}</strong>
      {!active && !hasContent ? <small>API/Runner 接通后可用</small> : null}
    </button>
  );
}
