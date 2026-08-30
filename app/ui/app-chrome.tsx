import Link from "next/link";
import type { ReactNode } from "react";
import { AccountMenu } from "./account-menu";
import { EpisodeSidebar } from "./episode-sidebar";

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
  const productionEpisodes = episodes.filter((episode) => episode.number >= 1);
  const projectLibraryHref = projectId ? `/?projectId=${encodeURIComponent(projectId)}` : "/";
  const projectWorkbenchHref = projectId ? `/projects/${encodeURIComponent(projectId)}` : null;
  const newProjectHref = projectId ? `/projects/new?projectId=${encodeURIComponent(projectId)}` : "/projects/new";
  const runnerHref = projectId ? `/runner?projectId=${encodeURIComponent(projectId)}` : "/runner";

  return (
    <div className={`appChrome ${activeSection === "episode" ? "episodeShell" : ""}`}>
      <aside className="appSidebar" aria-label="工作台导航">
        <Link href="/" className="chromeBrand">
          <span aria-hidden="true">L</span>
          <div><strong>分镜工作台</strong><small>Director Studio</small></div>
        </Link>

        <nav className="sidebarNav">
          <Link href={projectLibraryHref} className={activeSection === "projects" ? "active" : ""}><span className="navIcon" aria-hidden="true">⌂</span><span className="navText">所有项目</span></Link>
          {projectWorkbenchHref ? <Link href={projectWorkbenchHref} className={activeSection === "project" ? "active" : ""}><span className="navIcon" aria-hidden="true">◇</span><span className="navText navContext">{projectLabel ?? "全剧工作台"}</span></Link> : null}
          <Link href={newProjectHref} className={activeSection === "new" ? "active" : ""}><span className="navIcon" aria-hidden="true">＋</span><span className="navText">新建项目</span></Link>
          <Link href={runnerHref} className={activeSection === "runner" ? "active" : ""}><span className="navIcon" aria-hidden="true">↯</span><span className="navText">API 与 CLI</span></Link>
        </nav>

        {activeSection !== "projects" && projectId && productionEpisodes.length ? <EpisodeSidebar projectId={projectId} episodes={productionEpisodes} activeEpisodeId={activeEpisodeId} /> : null}

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
              <Link href={projectLibraryHref}>所有项目</Link>
              {projectWorkbenchHref ? <Link href={projectWorkbenchHref}>{projectLabel ?? "全剧工作台"}</Link> : null}
              <Link href={newProjectHref}>新建项目</Link>
              <Link href={runnerHref}>API 与 CLI</Link>
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
