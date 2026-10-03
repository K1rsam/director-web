"use client";

import { useEffect, useState, type ComponentPropsWithoutRef, type CSSProperties } from "react";
import styles from "./workflow-glass.module.css";

export type WorkflowGlassState = "idle" | "running" | "complete" | "paused" | "waiting" | "attention";
export type WorkflowGlassActivity = "none" | "running" | "waiting";
export { styles as workflowGlassStyles };

const motionKey = "director-workflow-reduced-motion";
const motionEvent = "director-workflow-motion-change";

type RailProps = ComponentPropsWithoutRef<"section"> & { label?: string; columns?: number };

/** Display preference only: this control never pauses or restarts a task. */
export function WorkflowGlassRail({ children, label = "工作流程", columns = 3, className = "", style, ...props }: RailProps) {
  const [manualReduced, setManualReduced] = useState(false);
  const [systemReduced, setSystemReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const readSystem = () => setSystemReduced(media.matches);
    const readManual = () => {
      try { setManualReduced(window.localStorage.getItem(motionKey) === "true"); } catch { /* Storage may be unavailable. */ }
    };
    const readSession = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "boolean") setManualReduced(event.detail);
    };
    readSystem();
    readManual();
    media.addEventListener("change", readSystem);
    window.addEventListener("storage", readManual);
    window.addEventListener(motionEvent, readSession);
    return () => {
      media.removeEventListener("change", readSystem);
      window.removeEventListener("storage", readManual);
      window.removeEventListener(motionEvent, readSession);
    };
  }, []);

  return <section {...props} aria-label={props["aria-label"] ?? label} className={`${styles.rail} ${className}`}
    data-reduced-motion={manualReduced || systemReduced} style={{ "--workflow-columns": columns, ...style } as CSSProperties}>
    <div className={styles.toolbar}>
      <label className={styles.motionToggle}>
        <input type="checkbox" checked={manualReduced || systemReduced} disabled={systemReduced} onChange={event => {
          const reduced = event.target.checked;
          setManualReduced(reduced);
          try { window.localStorage.setItem(motionKey, String(reduced)); } catch { /* The current page preference still works. */ }
          window.dispatchEvent(new CustomEvent(motionEvent, { detail: reduced }));
        }} />
        减少动效
      </label>
      {systemReduced ? <small>系统已开启</small> : null}
    </div>
    <div className={styles.cards}>{children}</div>
  </section>;
}

type CardProps = ComponentPropsWithoutRef<"article"> & { index: number; state: WorkflowGlassState; activity?: WorkflowGlassActivity };

/** Travel means active work; a distinct breathing light means an executing CLI
 * awaiting output. Queues, user choices and uncertain history remain static. */
export function WorkflowGlassCard({ children, index, state, activity, className = "", ...props }: CardProps) {
  const motion = state === "running" ? "running" : state === "waiting" && activity === "waiting" ? "waiting" : "none";
  return <article {...props} className={`${styles.card} ${className}`} data-workflow-state={state} data-workflow-index={index} data-workflow-activity-state={motion} aria-busy={motion !== "none"}>
    <div className={styles.content}>{children}</div>
    <span className={styles.activity} data-workflow-activity aria-hidden="true" />
  </article>;
}
