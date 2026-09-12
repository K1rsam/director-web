import Link from "next/link";
import type { ReactNode } from "react";
import { AccountMenu } from "./account-menu";

type EpisodeLink = { id: string; number: number; title: string; state?: string };

export function AppChrome({
  title,
  eyebrow,
  projectId,
  projectLabel,
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
  activeSection?: "projects" | "project" | "episode" | "new";
  primaryAction?: ReactNode;
  utility?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`appChrome ${activeSection === "episode" ? "episodeShell" : ""}`}>
      <aside className="appSidebar" aria-label="工作台导航">
        <Link href="/" className="chromeBrand">
          <span aria-hidden="true">镜</span>
          <div><strong>第一阶段工作台</strong><small>v0.2 第一阶段测试</small></div>
        </Link>

        <nav className="sidebarNav">
          <Link href={projectId ? `/?projectId=${projectId}` : "/"} className={activeSection === "projects" ? "active" : ""}><span className="navIcon" aria-hidden="true">⌂</span><span className="navText">所有项目</span></Link>
          {projectId ? <Link href={`/projects/${projectId}`} className={activeSection === "project" ? "active" : ""}><span className="navIcon" aria-hidden="true">◇</span><span className="navText navContext">{activeSection === "projects" && projectLabel ? projectLabel : "全剧工作台"}</span></Link> : null}
          <Link href="/projects/new" className={activeSection === "new" ? "active" : ""}><span className="navIcon" aria-hidden="true">＋</span><span className="navText">新建项目</span></Link>
        </nav>

        {activeSection !== "projects" && projectId ? (
          <div className="sidebarEpisodes">
            <p>v0.2 后续阶段尚未启用</p>
          </div>
        ) : null}

        <div className="sidebarFooter">
          <div className="sidebarWorkflow"><span>v0.2 第一阶段测试</span><strong>原文 · 整理 · 完善</strong></div>
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
