"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

/** 停止本集正在执行的流水线：kill worker 进程组 + 批次状态置为已停止。
 *  只在 pipelineActive（有 QUEUED/RUNNING）时可用；pending 时显示「停止中…」。 */
export function StopPipelineButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus();
  const submitting = useRef(false);
  useEffect(() => { submitting.current = pending; }, [pending]);
  const stopping = pending;
  if (!active && !stopping) return null;
  return (
    <button
      type="submit"
      className="studioButton quietButton cautionQuietButton"
      data-variant="caution"
      disabled={!active || stopping}
      aria-busy={stopping}
      onClick={(event) => {
        if (!active || stopping || submitting.current) {
          event.preventDefault();
          return;
        }
        submitting.current = true;
      }}
      title="停止本集正在执行的任务，正在进行的 API 调用会被中断"
    >
      {stopping ? "停止中…" : "停止任务"}
    </button>
  );
}
