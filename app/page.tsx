import Link from "next/link";
import type { CSSProperties } from "react";
import {
  deriveProjectCardState,
  resolveProjectDestination,
  resolveProjectStyleCover
} from "@/lib/project-entry";
import { prisma } from "@/lib/prisma";
import { archiveProjectAction, restoreProjectAction } from "@/app/actions";
import { DeleteProjectButton } from "./delete-project-button";
import { AppChrome } from "./ui/app-chrome";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

export default async function HomePage({ searchParams }: { searchParams: Promise<{ projectId?: string }> }) {
  const { projectId: requestedProjectId } = await searchParams;
  const projects = await prisma.project.findMany({
    where: { archivedAt: null },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      style: true,
      aspectRatio: true,
      updatedAt: true,
      _count: {
        select: {
          episodes: true,
          assets: true,
          sceneSnapshots: true
        }
      },
      episodes: {
        orderBy: { number: "asc" },
        select: {
          id: true,
          number: true,
          title: true,
          _count: { select: { seedanceUnits: true } }
        }
      }
    }
  });

  const archivedProjects = await prisma.project.findMany({
    where: { archivedAt: { not: null } },
    orderBy: { archivedAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      style: true,
      aspectRatio: true,
      updatedAt: true,
      archivedAt: true,
      _count: { select: { episodes: true, assets: true } }
    }
  });
  const activeProject = requestedProjectId
    ? projects.find((project) => project.id === requestedProjectId)
    : undefined;

  return (
    <AppChrome
      title="我的剧本项目"
      eyebrow="项目库"
      activeSection="projects"
      projectId={activeProject?.id}
      projectLabel={activeProject?.title}
      utility={(
        <div className="libraryTopbarMeta" aria-label={`${projects.length} 个项目，${archivedProjects.length} 个归档`}>
          <span>{projects.length} 个项目</span>
          <span>{archivedProjects.length} 个归档</span>
        </div>
      )}
      primaryAction={<Link href="/projects/new" className="topbarPrimary">新建项目 <span>＋</span></Link>}
    >
      <section className="projectLibrary">
        {projects.length ? (
          <div className="projectCardGrid">
            {projects.map((project, index) => {
              const unitEpisodeCount = project.episodes.filter(
                (episode) => episode._count.seedanceUnits > 0
              ).length;
              const state = deriveProjectCardState({
                episodeCount: project._count.episodes,
                snapshotCount: project._count.sceneSnapshots,
                assetCount: project._count.assets,
                unitEpisodeCount
              });
              const posterStyle = {
                "--project-cover": `url("${resolveProjectStyleCover(project.style)}")`
              } as CSSProperties;
              const destination = resolveProjectDestination(project.id);

              return (
                <article className="projectCard" key={project.id}>
                  <Link
                    href={destination}
                    className="projectCardHitArea"
                    aria-label={`进入项目 ${project.title}`}
                  />
                  <div className="projectPoster" style={posterStyle}>
                    <div className="posterFrame" aria-hidden="true">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <i />
                    </div>
                    <span className="projectStageBadge">{state.stage}</span>
                    <strong>{project.style || "未选择风格"}</strong>
                  </div>

                  <div className="projectCardBody">
                    <div className="projectTitleRow">
                      <div>
                        <h2>{project.title}</h2>
                        <p>{project.description || "尚未填写项目简介"}</p>
                      </div>
                      <span className="aspectBadge">{project.aspectRatio}</span>
                    </div>

                    <div className="projectProgress" aria-label={`项目完成度 ${state.progress}%`}>
                      <div>
                        <span>当前进度</span>
                        <b>{state.progress}%</b>
                      </div>
                      <i><span style={{ width: `${state.progress}%` }} /></i>
                    </div>

                    <div className="projectCardFooter">
                      <span>{project._count.episodes} 集 · 更新于 {dateFormatter.format(project.updatedAt)}</span>
                      <Link href={destination} className="continueLink">
                        {state.actionLabel}<span aria-hidden="true">→</span>
                      </Link>
                      <details className="projectCardMenu">
                        <summary aria-label={`${project.title}更多操作`}>•••</summary>
                        <div>
                          <form action={archiveProjectAction}>
                            <input name="projectId" type="hidden" value={project.id} />
                            <button type="submit" className="archiveAction" title="归档项目（不删除，可随时恢复）">归档项目</button>
                          </form>
                        </div>
                      </details>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="projectEmptyState">
            <span className="emptyMark" aria-hidden="true">＋</span>
            <h2>还没有剧本项目</h2>
            <p>上传完整剧本，选择画面风格后即可开始整理全剧资料。</p>
            <Link href="/projects/new" className="secondaryAction">创建第一个项目</Link>
          </div>
        )}
        {archivedProjects.length ? (
          <details className="archiveSection">
            <summary>归档项目 <span>{archivedProjects.length}</span></summary>
            <div className="projectCardGrid">
              {archivedProjects.map((project) => (
                <article className="projectCard archived" key={project.id}>
                  <div className="projectCardBody">
                    <div className="projectTitleRow">
                      <div>
                        <h2>{project.title}</h2>
                        <p>{project.description || "尚未填写项目简介"}</p>
                      </div>
                      <span className="aspectBadge">归档</span>
                    </div>
                    <div className="projectCardFooter">
                      <span>{project._count.episodes} 集 · 归档于 {dateFormatter.format(project.archivedAt ?? project.updatedAt)}</span>
                      <form action={restoreProjectAction}>
                        <input name="projectId" type="hidden" value={project.id} />
                        <button type="submit" className="archiveAction" title="恢复到项目列表">恢复</button>
                      </form>
                      <DeleteProjectButton projectId={project.id} title={project.title} />
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </details>
        ) : null}
      </section>
    </AppChrome>
  );
}
