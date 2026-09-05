"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

export function StopFoundationButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus();
  const submitting = useRef(false);
  useEffect(() => { submitting.current = pending; }, [pending]);
  if (!active && !pending) return null;
  return (
    <button
      type="submit"
      className="studioButton foundationStopButton cautionQuietButton"
      data-variant="caution"
      disabled={!active || pending}
      aria-busy={pending}
      title="停止当前 P1/P2 基础工程任务"
      onClick={(event) => {
        if (!active || pending || submitting.current) {
          event.preventDefault();
          return;
        }
        submitting.current = true;
      }}
    >
      {pending ? "停止中…" : "停止"}
    </button>
  );
}
