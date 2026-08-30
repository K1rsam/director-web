"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { startProjectFoundationAction } from "@/app/actions";

export type FoundationRunView = {
  stageCode: string;
  status: string;
  model: string;
  duration: string;
  error?: string | null;
};

export function FoundationActions({
  projectId,
  active,
  foundationReady,
  runs,
  preprocessReady,
  validationReady
}: {
  projectId: string;
  active: boolean;
  foundationReady: boolean;
  runs: FoundationRunView[];
  preprocessReady: boolean;
  validationReady: boolean;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [active, router]);

  const statusOf = (code: string) => runs.find((run) => run.stageCode === code);

  return (
    <div className="foundationControlRoom" id="foundation-actions">
      <div className="foundationControlHeader">
        <div>
          <strong>P1 → P2</strong>
          <span>线上建立任务；由已连接 Runner 使用本地 P1/P2 代码执行</span>
        </div>
        <form action={startProjectFoundationAction}>
          <input name="projectId" type="hidden" value={projectId} />
          <button type="submit" className="foundationRunAllButton" disabled={active}>
            {active ? "P1/P2 已排队或执行中…" : foundationReady ? "重新执行 P1 + P2" : "开始 P1 + P2"}
          </button>
        </form>
      </div>
      <p className="foundationRunnerNote">项目资料以线上数据库为准；Runner 只取本次任务快照执行，完成后把结果写回线上。</p>
      <div className="foundationRail" aria-label="全剧基础工程岗位">
        <article className={`foundationRole automatic ${preprocessReady ? "done" : ""}`}>
          <span>P0</span>
          <div><strong>剧本预处理</strong><small>Python · 自动工程</small></div>
          <em>{preprocessReady ? "已完成" : "待处理"}</em>
          <span className="foundationCardAction">自动执行</span>
        </article>
      {(["P1", "P2"] as const).map((code) => {
        const run = statusOf(code);
        const className = run
          ? run.status === "已完成" ? "done" : run.status === "进行中" ? "running" : run.status === "排队中" ? "queued" : run.status === "失败" ? "failed" : ""
          : "";
        const actionLabel = run?.status === "已完成" ? "重跑" : run?.status === "失败" ? "再试一次" : "运行";
        return (
          <div className="foundationStageForm" key={code}>
            <form action={startProjectFoundationAction}>
              <input name="projectId" type="hidden" value={projectId} />
              <input name="stageCode" type="hidden" value={code} />
              <button type="submit" className="foundationCardHitArea" disabled={active || run?.status === "排队中" || run?.status === "进行中"} aria-label={`${actionLabel} ${code}`} />
            </form>
              <article className={`foundationRole ${className}`}>
                <span>{code}</span>
                <div>
                  <strong>{code === "P1" ? "全剧基础策划" : "全剧资产拆解"}</strong>
                  <small>{run?.model ?? "默认模型"} · {run?.duration ?? "—"}</small>
                </div>
                <em>{run?.status ?? "未开始"}</em>
                {run?.status === "失败" && run?.error ? <p className="roleRunError" title={run.error}>{run.error}</p> : null}
                <span className="foundationCardAction">{active && (run?.status === "进行中" || run?.status === "排队中") ? run.status : actionLabel}</span>
              </article>
          </div>
        );
      })}
        <article className={`foundationRole automatic ${validationReady ? "done" : ""}`}>
          <span>P3</span>
          <div><strong>确定性校验</strong><small>Python · 自动工程</small></div>
          <em>{validationReady ? "通过" : "待校验"}</em>
          <span className="foundationCardAction">自动执行</span>
        </article>
      </div>
      <details className="maintenancePanel">
        <summary>维护与重置 <span>低频操作</span></summary>
        <div>
          <p>重新整理会覆盖当前全剧策划与资产索引，但不会删除已生成的单集分镜。</p>
          <div className="foundationRunAll">
            <form action={startProjectFoundationAction}>
              <input name="projectId" type="hidden" value={projectId} />
              <button type="submit" className="dangerQuietButton" disabled={active}>重跑全剧基础工程</button>
            </form>
          </div>
        </div>
      </details>
    </div>
  );
}
