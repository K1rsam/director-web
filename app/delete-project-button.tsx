"use client";

import { deleteProjectAction } from "@/app/actions";

/** 彻底删除项目（带确认弹窗）。 */
export function DeleteProjectButton({ projectId, title }: { projectId: string; title: string }) {
  return (
    <form
      action={deleteProjectAction}
      onSubmit={(event) => {
        if (!window.confirm(`彻底删除项目「${title}」？将删除全部分集、资产、快照、流水线记录与问题卡，不可恢复。`)) {
          event.preventDefault();
        }
      }}
    >
      <input name="projectId" type="hidden" value={projectId} />
      <button type="submit" className="archiveDanger" title="彻底删除（不可恢复）">彻底删除</button>
    </form>
  );
}
