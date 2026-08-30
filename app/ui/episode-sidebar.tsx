"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

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
    <div className="sidebarEpisodes">
      <p>分集制作 <span>{episodes.length}</span></p>
      <div ref={scrollRef} className="sidebarEpisodeScroller" aria-label="分集列表">
        {episodes.map((episode) => (
          <Link
            href={`/projects/${projectId}/episodes/${episode.id}`}
            className={episode.id === activeEpisodeId ? "active" : ""}
            data-episode-id={episode.id}
            key={episode.id}
            onClick={() => writeScrollTop(storageKey, scrollRef.current?.scrollTop ?? 0)}
          >
            <b>{String(episode.number).padStart(2, "0")}</b>
            <span>{episode.title}</span>
            <i title={episode.state}>{episode.state === "已完成" ? "✓" : episode.state === "生成中" ? "•" : ""}</i>
          </Link>
        ))}
      </div>
    </div>
  );
}
