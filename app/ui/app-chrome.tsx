import Link from "next/link";
import type { ReactNode } from "react";
import { AccountMenu } from "./account-menu";
import { EpisodeSidebar } from "./episode-sidebar";

type EpisodeLink = { id: string; number: number; title: string; state?: string };
type NavigationSection = "projects" | "project" | "episode" | "new" | "runner";
type NavigationItem = { section: NavigationSection; href: string; label: string };

function NavigationIcon({ name }: { name: NavigationSection | "menu" }) {
  const paths = {
    projects: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    project: <><path d="M3 7h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2" /></>,
    new: <path d="M12 5v14M5 12h14" />,
    episode: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="m3 7 17-4 1 4M8 6l2 3m4-5 2 3M3 12h18" /></>,
    runner: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />
  };

  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

function NavigationLinks({ items, activeSection }: { items: NavigationItem[]; activeSection?: NavigationSection | "episode" }) {
  return items.map((item) => (
    <Link key={item.section} href={item.href} className={activeSection === item.section ? "active" : ""} aria-current={activeSection === item.section ? "page" : undefined}>
      <span className="navIcon" aria-hidden="true"><NavigationIcon name={item.section} /></span>
      <span className={`navText${item.section === "project" ? " navContext" : ""}`}>{item.label}</span>
    </Link>
  ));
}

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
  const episodeEntryId = activeEpisodeId ?? productionEpisodes[0]?.id;
  const navigationItems: NavigationItem[] = [
    { section: "projects", href: projectLibraryHref, label: "所有项目" },
    ...(projectWorkbenchHref ? [{ section: "project" as const, href: projectWorkbenchHref, label: "全剧工作台" }] : []),
    ...(projectId && episodeEntryId ? [{ section: "episode" as const, href: `/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeEntryId)}`, label: "分集制作" }] : []),
    { section: "new", href: newProjectHref, label: "新建项目" },
    { section: "runner", href: runnerHref, label: "执行设置" }
  ];
  // 全剧工作台的正文已有 h1，顶部只保留页面标识，避免重复一级标题。
  const TitleTag = activeSection === "project" ? "p" : "h1";

  return (
    <div className={`appChrome ${activeSection === "episode" ? "episodeShell" : ""}`} data-section={activeSection}>
      <a className="skipLink" href="#main-content">跳到主要内容</a>
      <aside className="appSidebar" aria-label="工作台导航">
        <Link href="/" className="chromeBrand" aria-label="分镜工作台首页">
          <span aria-hidden="true">L</span>
          <div><strong>分镜工作台</strong><small>Director Studio</small></div>
        </Link>

        <nav className="sidebarNav" aria-label="主要导航">
          <NavigationLinks items={navigationItems} activeSection={activeSection} />
        </nav>

        {activeSection !== "projects" && projectId && productionEpisodes.length ? (
          <EpisodeSidebar projectId={projectId} episodes={productionEpisodes} activeEpisodeId={activeEpisodeId} />
        ) : null}

        <div className="sidebarFooter">
          <div className="sidebarWorkflow"><span>{projectLabel ?? "导演工作空间"}</span><strong>P1 · P2 · E0–E5</strong></div>
          <AccountMenu />
        </div>
      </aside>

      <div className="appWorkspace">
        <header className="appTopbar">
          <details className="mobileNav">
            <summary aria-label="切换导航"><NavigationIcon name="menu" /></summary>
            <nav aria-label="主要导航">
              <NavigationLinks items={navigationItems} activeSection={activeSection} />
              {projectId && productionEpisodes.length ? <details className="mobileEpisodeList"><summary>切换分集 · {productionEpisodes.length} 集</summary><div>{productionEpisodes.map(episode => <Link key={episode.id} href={`/projects/${projectId}/episodes/${episode.id}`} aria-current={episode.id === activeEpisodeId ? "page" : undefined}>{String(episode.number).padStart(2,"0")} · {episode.title}</Link>)}</div></details> : null}
              <div className="mobileAccountMenu"><AccountMenu /></div>
            </nav>
          </details>
          <div className="topbarIdentity" data-route-label><small>{eyebrow}</small><TitleTag id="page-title" className="pageTitle">{title}</TitleTag></div>
          <div className="topbarTools">{utility}{primaryAction}</div>
        </header>
        <main id="main-content" className="appMain" tabIndex={-1} aria-labelledby="page-title">{children}</main>
      </div>
    </div>
  );
}
