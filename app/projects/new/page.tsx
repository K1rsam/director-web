import Link from "next/link";
import { PROJECT_STYLE_OPTIONS } from "@/lib/project-entry";
import { ProjectCreateForm } from "./project-create-form";
import { AppChrome } from "@/app/ui/app-chrome";
import { requireSessionUser } from "@/lib/auth";
import { getProjectLibrary } from "@/lib/project-library";
import "@/app/page-surfaces.css";

export const dynamic = "force-dynamic";

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ projectId?: string }> }) {
  const currentUser = await requireSessionUser("/projects/new");
  const { projectId: requestedProjectId } = await searchParams;
  const { projects } = await getProjectLibrary(currentUser.id);
  const activeProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const projectLibraryHref = activeProject ? `/?projectId=${encodeURIComponent(activeProject.id)}` : "/";

  return (
    <AppChrome
      title="创建剧本项目"
      eyebrow="新建项目"
      projectId={activeProject?.id}
      projectLabel={activeProject?.title}
      episodes={activeProject?.episodes.map(({ id, number, title }) => ({ id, number, title: title ?? `第${number}集` }))}
      activeSection="new"
      primaryAction={<Link href={projectLibraryHref} className="secondaryAction">返回项目总览</Link>}
    >
      <section className="createProjectPage pageSurface createSurface" aria-label="新建剧本项目">
        <div className="createPageHeading surfaceIntro">
          <p>提供完整剧本并选择固定风格模板，系统将从全剧资料整理开始。</p>
          <span className="surfaceCaption">完整剧本 → 全剧资料 → 分集制作</span>
        </div>
        <ProjectCreateForm styles={PROJECT_STYLE_OPTIONS} />
      </section>
    </AppChrome>
  );
}
