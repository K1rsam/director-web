"use client";

import { useFormStatus } from "react-dom";

/** 重置分镜按钮：提交时显示"重置中…"并禁用，防止连点；重置后整集回到未运行状态。 */
export function ResetEpisodeButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="quietButton dangerQuietButton resetEpisodeButton"
      disabled={active || pending}
      title={pending ? "正在清空本集…" : "危险操作：将清空本集分镜、单元、问题卡与执行记录"}
      onClick={(event) => {
        if (!active && !pending && !window.confirm("确定重置本集分镜？\n\n这会清空本集分镜、Seedance 单元、问题卡和执行记录，且无法撤回。")) {
          event.preventDefault();
        }
      }}
    >
      {pending ? "重置中…" : active ? "运行中不可重置" : "重置分镜"}
    </button>
  );
}
