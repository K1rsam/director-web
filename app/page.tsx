import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { createProjectAction, enqueueSmokeAction } from "@/app/actions";
import { chatGPTSignOutPath } from "@/app/chatgpt-auth";
import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { getDb } from "@/db";
import { projects, runnerJobs } from "@/db/schema";
import { requireSiteUser } from "@/lib/site-user";

export const dynamic = "force-dynamic";

const statusText: Record<string, string> = {
  queued: "等待 Runner",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};

export default async function Home() {
  const user = await requireSiteUser("/");
  await ensureControlPlaneSchema();
  const db = getDb();
  const [projectList, jobs] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(eq(projects.ownerUserId, user.userId))
      .orderBy(desc(projects.updatedAt)),
    db
      .select()
      .from(runnerJobs)
      .where(eq(runnerJobs.ownerUserId, user.userId))
      .orderBy(desc(runnerJobs.createdAt))
      .limit(20),
  ]);
  const projectNames = new Map(projectList.map((project) => [project.id, project.title]));

  return (
    <main className="min-h-screen bg-[#f6f3ed] text-[#201c18]">
      <header className="border-b border-black/10 bg-[#fffdf9]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#d84a2b] text-sm font-black text-white">CL</span>
            <div>
              <p className="font-semibold leading-tight">导演工作台</p>
              <p className="text-xs text-black/50">Sites 控制面</p>
            </div>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <Link className="font-medium text-[#a9341d] hover:underline" href="/runner">Runner 设置</Link>
            <a className="text-black/55 hover:text-black" href={chatGPTSignOutPath("/")}>退出</a>
          </nav>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-6">
          <div>
            <p className="text-sm text-black/50">{user.displayName}</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">项目与执行任务</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-black/60">
              项目和任务状态保存在 D1；Codex CLI 只在你的本地 Runner 中运行。
            </p>
          </div>

          <form action={createProjectAction} className="grid gap-3 rounded-2xl border border-black/10 bg-white p-5 shadow-sm sm:grid-cols-[1fr_1fr_auto]">
            <label className="grid gap-1 text-sm font-medium">
              项目名称
              <input className="rounded-xl border border-black/15 px-3 py-2.5 outline-none focus:border-[#d84a2b]" name="title" maxLength={120} required />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              简短说明
              <input className="rounded-xl border border-black/15 px-3 py-2.5 outline-none focus:border-[#d84a2b]" name="description" maxLength={500} />
            </label>
            <button className="self-end rounded-xl bg-[#201c18] px-4 py-2.5 text-sm font-semibold text-white hover:bg-black" type="submit">新建项目</button>
          </form>

          <div className="grid gap-4 sm:grid-cols-2">
            {projectList.map((project) => (
              <article key={project.id} className="rounded-2xl border border-black/10 bg-[#fffdf9] p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold">{project.title}</h2>
                    <p className="mt-1 text-sm leading-5 text-black/55">{project.description || "暂无说明"}</p>
                  </div>
                  <span className="rounded-full bg-[#e7f4e5] px-2.5 py-1 text-xs font-medium text-[#2f6f35]">D1</span>
                </div>
                <form action={enqueueSmokeAction.bind(null, project.id)} className="mt-5">
                  <button className="w-full rounded-xl border border-[#d84a2b]/30 bg-[#fff3ee] px-3 py-2 text-sm font-semibold text-[#a9341d] hover:bg-[#ffe8de]" type="submit">
                    创建连通测试任务
                  </button>
                </form>
              </article>
            ))}
            {projectList.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/20 bg-white/50 p-8 text-center text-sm text-black/50 sm:col-span-2">
                先新建一个项目，然后创建连通测试任务。
              </div>
            ) : null}
          </div>
        </section>

        <aside className="h-fit rounded-2xl border border-black/10 bg-[#201c18] p-5 text-white shadow-lg shadow-black/10">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">最近任务</h2>
            <span className="text-xs text-white/50">最多 20 条</span>
          </div>
          <div className="mt-4 space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-xl bg-white/8 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm font-medium">{projectNames.get(job.projectId) ?? "未知项目"}</p>
                  <span className="shrink-0 text-xs text-[#ffb49f]">{statusText[job.status] ?? job.status}</span>
                </div>
                <p className="mt-1 text-xs text-white/45">连通测试 · 第 {job.attempt} 次 · {formatTime(job.createdAt)}</p>
                {job.error ? <p className="mt-2 line-clamp-2 text-xs text-red-300">{job.error}</p> : null}
              </div>
            ))}
            {jobs.length === 0 ? <p className="py-8 text-center text-sm text-white/40">暂无任务</p> : null}
          </div>
        </aside>
      </div>
    </main>
  );
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}
