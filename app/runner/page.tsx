import Link from "next/link";

import { AppChrome } from "@/app/ui/app-chrome";
import { ProviderConnectionPanel } from "@/app/runner/provider-connection-panel";
import { requireSessionUser } from "@/lib/auth";
import { getDeepSeekCredentialStatus } from "@/lib/provider-credentials";
import { getProjectLibrary } from "@/lib/project-library";

export const dynamic = "force-dynamic";

/**
 * Local execution settings surface.
 *
 * The cloud Sites version also exposes device-token management here. The local
 * app keeps its existing Prisma/SQLite execution path, so this page is kept as
 * a compatible settings surface without introducing the cloud token protocol.
 */
export default async function RunnerPage({ searchParams }: { searchParams: Promise<{ projectId?: string }> }) {
  const currentUser = await requireSessionUser("/runner");
  const apiStatus = await getDeepSeekCredentialStatus(currentUser.id);
  const { projectId: requestedProjectId } = await searchParams;
  const { projects } = await getProjectLibrary(currentUser.id);
  const activeProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const projectLibraryHref = activeProject ? `/?projectId=${encodeURIComponent(activeProject.id)}` : "/";

  return (
    <AppChrome
      title="API 与 CLI"
      eyebrow="执行设置"
      activeSection="runner"
      projectId={activeProject?.id}
      projectLabel={activeProject?.title}
      episodes={activeProject?.episodes.map(({ id, number, title }) => ({ id, number, title: title ?? `第${number}集` }))}
      utility={<div className="runnerTopbarMeta"><span>本地执行</span><span>账号隔离</span></div>}
      primaryAction={<Link href={projectLibraryHref} className="topbarPrimary">返回项目总览</Link>}
    >
      <section className="runnerSettingsPage">
        <header className="runnerHero studioCard">
          <span className="runnerHeroIcon" aria-hidden="true">↗</span>
          <div>
            <p className="sectionEyebrow">执行连接</p>
            <h2>连接你的生产工具</h2>
            <p>API 使用当前账号的 DeepSeek Key，CLI 使用本机已登录的 Codex。连接完成后，在项目中选择执行方式。</p>
          </div>
          <div className="runnerHeroAssurance"><span>本地版本</span><strong>账号隔离 · 密文保存</strong></div>
        </header>

        <ProviderConnectionPanel initialApi={apiStatus} />

        <section className="runnerChoiceGuide studioCard">
          <header className="runnerSectionHeader">
            <div><p className="sectionEyebrow">使用指引</p><h2>怎么选择</h2></div>
            <p>执行方式按项目单独设置；连接凭证按账号隔离，不会混用其他测试账号。</p>
          </header>
          <div className="runnerChoiceGrid">
            <article><span>01</span><div><strong>API 项目</strong><p>先在上方验证并保存当前账号 Key，再在项目中选择 API（DeepSeek）。后台流水线会读取项目管理员账号的凭证。</p></div></article>
            <article><span>02</span><div><strong>CLI 项目</strong><p>点击上方本机检测，确认 Codex 已登录后，在项目中选择 CLI；任务仍在本机运行，不经过云端 Runner。</p></div></article>
          </div>
        </section>

        <section className="runnerDeviceCard studioCard">
          <header className="runnerSectionHeader">
            <div><p className="sectionEyebrow">本机执行</p><h2>连接与数据</h2></div>
            <p>无需云端设备令牌</p>
          </header>
          <div className="runnerDeviceList">
            <p className="runnerDeviceEmpty">项目和任务保存在本机。API Key 加密保存，Codex 沿用本机登录状态，无需配对云端设备。</p>
          </div>
        </section>
      </section>
    </AppChrome>
  );
}
