"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useFormStatus } from "react-dom";
import { deleteProjectAction } from "@/app/actions";

/** 彻底删除项目（带确认弹窗）。 */
export function DeleteProjectButton({ projectId, title }: { projectId: string; title: string }) {
  const submitting = useRef(false);
  return (
    <form
      action={deleteProjectAction}
      onSubmit={(event) => {
        if (submitting.current) {
          event.preventDefault();
          return;
        }
        if (!window.confirm(`彻底删除项目「${title}」？将删除全部分集、资产、快照、流水线记录与问题卡，不可恢复。`)) {
          event.preventDefault();
          return;
        }
        submitting.current = true;
      }}
    >
      <input name="projectId" type="hidden" value={projectId} />
      <DeleteSubmitButton submitting={submitting} />
    </form>
  );
}

function DeleteSubmitButton({ submitting }: { submitting: RefObject<boolean> }) {
  const { pending } = useFormStatus();
  useEffect(() => { submitting.current = pending; }, [pending, submitting]);
  return (
    <button type="submit" className="studioButton archiveDanger" data-variant="danger" disabled={pending} aria-busy={pending} title="彻底删除（不可恢复）">
      {pending ? "正在删除…" : "彻底删除"}
    </button>
  );
}
