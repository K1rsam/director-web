import Link from "next/link";
import type { ReactNode } from "react";
import { AccountMenu } from "./account-menu";

type EpisodeLink = { id: string; number: number; title: string; state?: string };

export function AppChrome({
  title,
  eyebrow,
  projectId,
  projectLabel,
  episodes = [],
  activeEpisodeId,
  activeSection,
  primaryAction,
  utility,
  children
}: {
  title: string;
  eyebrow: string;
  projectId?: string;
  projectLabel?: string;
  episodes?: EpisodeLink[];
  activeEpisodeId?: string;
  activeSection?: "projects" | "project" | "episode" | "new" | "runner";
  primaryAction?: ReactNode;
  utility?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`appChrome ${activeSection === "episode" ? "episodeShell" : ""}`}>
      <aside className="appSidebar" aria-label="工作台导航">
        <Link href="/" className="chromeBrand">
          <span aria-hidden="true">L</span>
          <div><strong>分镜工作台</strong><small>Director Studio</small></div>
        </Link>

        <nav className="sidebarNav">
          <Link href={projectId ? `/?projectId=${projectId}` : "/"} className={activeSection === "projects" ? "active" : ""}><span className="navIcon" aria-hidden="true">⌂</span><span className="navText">所有项目</span></Link>
          {projectId ? <Link href={`/projects/${projectId}`} className={activeSection === "project" ? "active" : ""}><span className="navIcon" aria-hidden="true">◇</span><span className="navText navContext">{activeSection === "projects" && projectLabel ? projectLabel : "全剧工作台"}</span></Link> : null}
          <Link href="/projects/new" className={activeSection === "new" ? "active" : ""}><span className="navIcon" aria-hidden="true">＋</span><span className="navText">新建项目</span></Link>
          <Link href="/runner" className={activeSection === "runner" ? "active" : ""}><span className="navIcon" aria-hidden="true">↯</span><span className="navText">API 与 CLI</span></Link>
        </nav>

        {activeSection !== "projects" && projectId && episodes.length ? (
          <div className="sidebarEpisodes">
            <p>分集制作 <span>{episodes.length}</span></p>
            <div>
              {episodes.map((episode) => (
                <Link
                  href={`/projects/${projectId}/episodes/${episode.id}`}
                  className={episode.id === activeEpisodeId ? "active" : ""}
                  key={episode.id}
                >
                  <b>{String(episode.number).padStart(2, "0")}</b>
                  <span>{episode.title}</span>
                  <i title={episode.state}>{episode.state === "已完成" ? "✓" : episode.state === "生成中" ? "•" : ""}</i>
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        <div className="sidebarFooter">
          <div className="sidebarWorkflow"><span>工作流</span><strong>P1 · P2 · E0–E5</strong></div>
          <AccountMenu />
        </div>
      </aside>

      <div className="appWorkspace">
        <header className="appTopbar">
          <details className="mobileNav">
            <summary aria-label="打开导航">☰</summary>
            <nav>
              <Link href={projectId ? `/?projectId=${projectId}` : "/"}>所有项目</Link>
              {projectId ? <Link href={`/projects/${projectId}`}>{activeSection === "projects" && projectLabel ? projectLabel : "全剧工作台"}</Link> : null}
              <Link href="/projects/new">新建项目</Link>
              <Link href="/runner">API 与 CLI</Link>
              <div className="mobileAccountMenu"><AccountMenu /></div>
            </nav>
          </details>
          <div className="topbarIdentity" data-route-label><small>{eyebrow}</small><strong>{title}</strong></div>
          <div className="topbarTools">{utility}{primaryAction}</div>
        </header>
        <main className="appMain">{children}</main>
      </div>
    </div>
  );
}
