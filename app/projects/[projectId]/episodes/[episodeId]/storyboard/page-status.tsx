"use client";

import { createContext, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import styles from "./page-status.module.css";
import { deriveView } from "./view-state";
import type { Run } from "./types";

type PageStatus = { label: string; description: string; tone: string };
const StatusContext = createContext<PageStatus | null>(null);
const PublishContext = createContext<Dispatch<SetStateAction<PageStatus | null>> | null>(null);

/** Share the workbench's existing read stream; the header never fetches or dispatches work. */
export function StoryboardStatusProvider({ children, initialRun }: { children: ReactNode; initialRun?:Run|null }) {
  const [status, setStatus] = useState<PageStatus | null>(()=>{
    if(!initialRun)return null;
    const view=deriveView(initialRun,false);
    return {label:view.title,description:view.description,tone:initialRun.sourceCheckPending?'waiting':view.tone};
  });
  return <PublishContext.Provider value={setStatus}><StatusContext.Provider value={status}>{children}</StatusContext.Provider></PublishContext.Provider>;
}

export function usePublishStoryboardStatus({ label, description, tone }: PageStatus) {
  const publish = useContext(PublishContext);
  useEffect(() => {
    publish?.(previous => previous?.label === label && previous.description === description && previous.tone === tone ? previous : { label, description, tone });
  }, [publish, label, description, tone]);
  // The episode-keyed provider owns reset. A departing publisher must not clear
  // a newer workbench's status during navigation or Fast Refresh.
}

export function StoryboardHeaderStatus() {
  const status = useContext(StatusContext);
  return <span className={styles.badge} data-state={status?.tone || 'waiting'} aria-label="第三阶段当前步骤" role="status" title={status?.description || '正在读取所选任务的保存状态。'}>
    <i aria-hidden="true" /><span>{status?.label || '正在读取任务状态'}</span>
  </span>;
}
