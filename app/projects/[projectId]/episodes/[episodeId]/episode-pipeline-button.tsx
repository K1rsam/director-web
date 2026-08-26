"use client";

import { useEffect } from "react";
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
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [active, router]);

  return (
    <form
      action={startEpisodePipelineAction}
      onSubmit={(event) => {
        // #10 防护：本集已有分镜（尤其已放行）时，重新生成会整批覆盖，必须二次确认
        if (hasContent && !window.confirm(
          released
            ? "本集已放行。重新生成会用新的一轮 E0–E5 覆盖现有分镜与单元（仅影响本集），确定继续？"
            : "本集已有分镜/单元。重新生成会整批覆盖（仅影响本集），确定继续？"
        )) {
          event.preventDefault();
        }
      }}
    >
      <input name="projectId" type="hidden" value={projectId} />
      <input name="episodeId" type="hidden" value={episodeId} />
      <SubmitButton active={active} hasContent={hasContent} activeLabel={activeLabel} />
    </form>
  );
}

function SubmitButton({ active, hasContent, activeLabel }: { active: boolean; hasContent: boolean; activeLabel?: string }) {
  const { pending } = useFormStatus();
  const busy = active || pending;
  return (
    <button type="submit" className={`episodePipelineButton ${hasContent ? "rerun" : "firstRun"}`} disabled={busy}>
      <strong>{busy ? activeLabel ?? "正在执行 E0–E5…" : hasContent ? "重新执行本集 E0–E5" : "开始本集 E0–E5"}</strong>
      {!busy && !hasContent ? <small>自动运行 E0–E5</small> : null}
    </button>
  );
}

