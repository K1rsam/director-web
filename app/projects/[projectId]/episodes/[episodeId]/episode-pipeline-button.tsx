"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { startEpisodePipelineAction } from "@/app/actions";

export function EpisodePipelineButton({
  projectId,
  episodeId,
  active,
  hasContent,
  released,
  activeLabel
}: {
  projectId: string;
  episodeId: string;
  active: boolean;
  hasContent: boolean;
  released: boolean;
  activeLabel?: string;
}) {
  const router = useRouter();
  const submitting = useRef(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [active, router]);

  return (
    <form
      action={startEpisodePipelineAction}
      onSubmit={(event) => {
        if (active || submitting.current) {
          event.preventDefault();
          return;
        }
        // #10 防护：本集已有分镜（尤其已放行）时，重新生成会整批覆盖，必须二次确认
        if (hasContent && !window.confirm(
          released
            ? "本集已放行。重新生成会用新的一轮 E0–E5 覆盖现有分镜与单元（仅影响本集），确定继续？"
            : "本集已有分镜/单元。重新生成会整批覆盖（仅影响本集），确定继续？"
        )) {
          event.preventDefault();
          return;
        }
        submitting.current = true;
      }}
    >
      <input name="projectId" type="hidden" value={projectId} />
      <input name="episodeId" type="hidden" value={episodeId} />
      <SubmitButton active={active} hasContent={hasContent} activeLabel={activeLabel} submitting={submitting} />
    </form>
  );
}

function SubmitButton({ active, hasContent, activeLabel, submitting }: { active: boolean; hasContent: boolean; activeLabel?: string; submitting: RefObject<boolean> }) {
  const { pending } = useFormStatus();
  useEffect(() => { submitting.current = pending; }, [pending, submitting]);
  const busy = active || pending;
  return (
    <button
      type="submit"
      className="studioButton episodePipelineButton primaryRun"
      data-variant="primary"
      disabled={busy}
      aria-busy={busy}
    >
      {!busy ? <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M7 4.7c0-.6.7-1 1.2-.7l11.3 7.3a.8.8 0 0 1 0 1.4L8.2 20c-.5.3-1.2-.1-1.2-.7Z" /></svg> : null}
      <strong>{busy ? activeLabel ?? "正在执行 E0–E5…" : hasContent ? "重新执行本集 E0–E5" : "开始本集 E0–E5"}</strong>
    </button>
  );
}
