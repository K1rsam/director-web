"use client";

import { useFormStatus } from "react-dom";

/** 停止本集正在执行的流水线：kill worker 进程组 + 批次状态置为已停止。
 *  只在 pipelineActive（有 QUEUED/RUNNING）时可用；pending 时显示「停止中…」。 */
export function StopPipelineButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus();
  const stopping = pending;
  if (!active && !stopping) return null;
  return (
    <button
      type="submit"
      className="dangerQuietButton"
      disabled={!active || stopping}
      title="终止本集正在执行的岗位（kill worker 进程 + 批次标记停止），正在进行的 API 调用会被中断"
    >
      {stopping ? "停止中…" : "停止"}
    </button>
  );
}
