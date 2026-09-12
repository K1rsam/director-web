import Link from "next/link";
import type { CSSProperties } from "react";
import {
  deriveProjectCardState,
  resolveProjectDestination,
  resolveProjectStyleCover
} from "@/lib/project-entry";
import { requireSessionUser } from "@/lib/auth";
import { getProjectLibrary } from "@/lib/project-library";
import { getFoundationDeliveryState } from "@/lib/foundation-delivery";
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
  const currentUser = await requireSessionUser("/");
  const { projectId: requestedProjectId } = await searchParams;
  const { projects, archivedProjects } = await getProjectLibrary(currentUser.id);
  const foundationCompleteByProject = new Map(await Promise.all(projects.map(async (project) =>
    [project.id, (await getFoundationDeliveryState(project.id)).complete] as const
  )));
  const activeProject = requestedProjectId
    ? projects.find((project) => project.id === requestedProjectId)
    : undefined;

  return (
    <AppChrome
      title="我的剧本项目"
      eyebrow="v0.2 第一阶段测试"
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
                foundationReady: foundationCompleteByProject.get(project.id) === true,
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

                    <div className="projectProgress" aria-label={`第一阶段资料准备进度 ${state.progress}%，不代表作品质量通过`}>
                      <div>
                        <span>第一阶段资料准备</span>
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
