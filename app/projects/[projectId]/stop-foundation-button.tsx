"use client";

import { useFormStatus } from "react-dom";

export function StopFoundationButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus();
  if (!active) return null;
  return (
    <button type="submit" className="foundationStopButton" disabled={pending} title="停止当前 F1/F2/Q1 基础资料任务">
      {pending ? "停止中…" : "停止"}
    </button>
  );
}
