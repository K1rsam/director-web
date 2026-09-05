"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { MotionSelection } from "./motion-selection";

type EpisodeSidebarItem = {
  id: string;
  number: number;
  title: string;
  state?: string;
};

function readScrollTop(key: string): number | null {
  try {
    const value = Number(window.sessionStorage.getItem(key));
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function writeScrollTop(key: string, value: number) {
  try {
    window.sessionStorage.setItem(key, String(Math.max(0, Math.round(value))));
  } catch {
    // 隐私模式或禁用存储时不影响分集导航本身。
  }
}

export function EpisodeSidebar({
  projectId,
  episodes,
  activeEpisodeId
}: {
  projectId: string;
  episodes: EpisodeSidebarItem[];
  activeEpisodeId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const storageKey = `director-studio:episode-sidebar:${projectId}`;

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const savedTop = readScrollTop(storageKey);
    const frame = window.requestAnimationFrame(() => {
      if (savedTop !== null) container.scrollTop = savedTop;

      const activeLink = activeEpisodeId
        ? [...container.querySelectorAll<HTMLElement>("[data-episode-id]")]
            .find((element) => element.dataset.episodeId === activeEpisodeId)
        : null;
      if (!activeLink) return;

      // 直接打开一个不在当前可视范围内的集数时，把它带入列表视口；
      // 已经从列表点击进入时则保留用户刚刚停留的位置。
      const containerRect = container.getBoundingClientRect();
      const linkRect = activeLink.getBoundingClientRect();
      if (
        savedTop === null
        || linkRect.top < containerRect.top
        || linkRect.bottom > containerRect.bottom
      ) {
        if (linkRect.top < containerRect.top) {
          container.scrollTop -= containerRect.top - linkRect.top;
        } else if (linkRect.bottom > containerRect.bottom) {
          container.scrollTop += linkRect.bottom - containerRect.bottom;
        }
        writeScrollTop(storageKey, container.scrollTop);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeEpisodeId, storageKey]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const rememberPosition = () => writeScrollTop(storageKey, container.scrollTop);
    container.addEventListener("scroll", rememberPosition, { passive: true });
    return () => container.removeEventListener("scroll", rememberPosition);
  }, [storageKey]);

  return (
    <nav className="sidebarEpisodes" aria-label="分集制作">
      <p>分集制作 <span>{episodes.length}</span></p>
      <MotionSelection as="div" containerRef={scrollRef} className="sidebarEpisodeScroller" label="分集列表" group={`episodes:${projectId}`} activeKey={activeEpisodeId ?? ""}>
        {episodes.map((episode) => (
          <Link
            href={`/projects/${projectId}/episodes/${episode.id}`}
            className={episode.id === activeEpisodeId ? "active" : ""}
            aria-current={episode.id === activeEpisodeId ? "page" : undefined}
            aria-label={`第${episode.number}集 ${episode.title}${episode.state ? `，${episode.state}` : ""}`}
            data-episode-id={episode.id}
            key={episode.id}
            onClick={() => writeScrollTop(storageKey, scrollRef.current?.scrollTop ?? 0)}
          >
            <b>{String(episode.number).padStart(2, "0")}</b>
            <span>{episode.title}</span>
            <i title={episode.state} aria-hidden="true">
              {episode.state === "已完成" || episode.state === "生成中" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                  {episode.state === "已完成" ? <path d="m5 12 4 4L19 6" /> : <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>}
                </svg>
              ) : null}
            </i>
          </Link>
        ))}
      </MotionSelection>
    </nav>
  );
}
