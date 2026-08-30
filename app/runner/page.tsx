import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { revokeRunnerTokenAction } from "@/app/actions";
import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { getDb } from "@/db";
import { runnerTokens } from "@/db/schema";
import { requireSessionUser } from "@/lib/auth";
import { getProjectLibrary } from "@/lib/project-library";
import { AppChrome } from "@/app/ui/app-chrome";
import { parseStoredRunnerStatus } from "@/lib/runner-status";
import { DeepSeekKeySetup } from "./deepseek-key-setup";
import { CodexStatusPanel, type RunnerStatusDevice } from "./codex-status-panel";
import { RunnerTokenForm } from "./token-form";

export const dynamic = "force-dynamic";

export default async function RunnerPage({ searchParams }: { searchParams: Promise<{ projectId?: string }> }) {
  const user = await requireSessionUser("/runner");
  const { projectId: requestedProjectId } = await searchParams;
  const { projects } = await getProjectLibrary(user.id);
  const activeProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  const projectLibraryHref = activeProject ? `/?projectId=${encodeURIComponent(activeProject.id)}` : "/";
  await ensureControlPlaneSchema();
  const tokens = await getDb()
    .select()
    .from(runnerTokens)
    .where(eq(runnerTokens.ownerUserId, user.id))
    .orderBy(desc(runnerTokens.createdAt));
  const devices: RunnerStatusDevice[] = tokens.map((token) => ({
    id: token.id,
    name: token.name,
    revoked: Boolean(token.revokedAt),
    status: parseStoredRunnerStatus(token.statusJson),
  }));
  const hasStatus = devices.some((device) => device.status && !device.revoked);

  return (
    <AppChrome
      title="API 与 CLI"
      eyebrow="执行设置"
      projectId={activeProject?.id}
      projectLabel={activeProject?.title}
      episodes={activeProject?.episodes.map(({ id, number, title }) => ({ id, number, title: title ?? `第${number}集` }))}
      activeSection="runner"
      utility={<div className="runnerTopbarMeta"><span>个人凭证</span><span>{hasStatus ? "额度已同步" : "等待本机状态"}</span></div>}
      primaryAction={<Link href={projectLibraryHref} className="topbarPrimary">返回项目总览</Link>}
    >
      <section className="runnerSettingsPage">
        <header className="runnerHero studioCard">
          <span className="runnerHeroIcon" aria-hidden="true">↗</span>
          <div>
            <p className="sectionEyebrow">PERSONAL EXECUTION</p>
            <h1>使用你自己的执行额度</h1>
            <p>API Key 只留在当前浏览器；每台电脑使用自己的 Codex CLI、账号和额度。网站只保存线上项目数据与任务结果，不会读取任何设备的本机项目数据库。</p>
          </div>
          <div className="runnerHeroAssurance"><span>账号隔离</span><strong>每位用户独立连接</strong></div>
        </header>

        <div className="runnerConnectionGrid">
          <DeepSeekKeySetup />
          <RunnerTokenForm />
        </div>

        <CodexStatusPanel devices={devices} />

        <section className="runnerChoiceGuide studioCard">
          <header className="runnerSectionHeader">
            <div><p className="sectionEyebrow">QUICK GUIDE</p><h2>怎么选择</h2></div>
            <p>两种方式都使用用户自己的额度；CLI 模式还需要本机执行代码目录。</p>
          </header>
          <div className="runnerChoiceGrid">
            <article><span>01</span><div><strong>直接使用 API</strong><p>粘贴自己的 DeepSeek Key，测试成功后即可关闭本页；只在这台设备生效。</p></div></article>
            <article><span>02</span><div><strong>使用 Codex CLI</strong><p>生成启动器并保持窗口运行；网站从 D1 下发任务快照，本机代码调用本机 Codex，完成后只把本次结果写回线上。</p></div></article>
          </div>
        </section>

        <section className="runnerDeviceCard studioCard">
          <header className="runnerSectionHeader">
            <div><p className="sectionEyebrow">CLI DEVICES</p><h2>我的 CLI 设备</h2></div>
            <p>{tokens.filter((token) => !token.revokedAt).length} 台可用设备</p>
          </header>
          <div className="runnerDeviceList">
            {tokens.map((token) => (
              <div key={token.id} className="runnerDeviceRow">
                <span className={`runnerDeviceDot ${token.revokedAt ? "revoked" : ""}`} aria-hidden="true" />
                <div>
                  <strong>{token.name}</strong>
                  <small>{token.revokedAt ? "已撤销" : token.lastSeenAt ? `最近连接：${formatTime(token.lastSeenAt)}` : "尚未连接"}</small>
                </div>
                {!token.revokedAt ? (
                  <form action={revokeRunnerTokenAction.bind(null, token.id)}>
                    <button className="runnerRevokeButton" type="submit">撤销</button>
                  </form>
                ) : null}
              </div>
            ))}
            {tokens.length === 0 ? <p className="runnerDeviceEmpty">尚未连接 CLI 设备</p> : null}
          </div>
        </section>
      </section>
    </AppChrome>
  );
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}
