import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { revokeRunnerTokenAction } from "@/app/actions";
import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { getDb } from "@/db";
import { runnerTokens } from "@/db/schema";
import { requireSiteUser } from "@/lib/site-user";
import { RunnerTokenForm } from "./token-form";

export const dynamic = "force-dynamic";

export default async function RunnerPage() {
  const user = await requireSiteUser("/runner");
  await ensureControlPlaneSchema();
  const tokens = await getDb()
    .select()
    .from(runnerTokens)
    .where(eq(runnerTokens.ownerUserId, user.userId))
    .orderBy(desc(runnerTokens.createdAt));

  return (
    <main className="min-h-screen bg-[#f6f3ed] px-5 py-8 text-[#201c18] sm:px-8">
      <div className="mx-auto max-w-3xl">
        <Link className="text-sm font-medium text-[#a9341d] hover:underline" href="/">← 返回项目</Link>
        <h1 className="mt-5 text-3xl font-bold tracking-tight">本地 Runner</h1>
        <p className="mt-2 text-sm leading-6 text-black/60">Runner 只领取你的任务，并且只能执行代码中允许的固定任务类型。</p>

        <div className="mt-6 grid gap-5">
          <RunnerTokenForm />

          <section className="rounded-2xl border border-black/10 bg-[#201c18] p-5 text-white">
            <h2 className="font-semibold">设备启动方式</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-white/70">
              <li>在本机打开 <code className="text-white">CL-sites</code> 目录。</li>
              <li>设置 <code className="text-white">DIRECTOR_SITE_URL</code> 和刚生成的 <code className="text-white">DIRECTOR_RUNNER_TOKEN</code>。</li>
              <li>运行 <code className="text-white">npm run runner:start</code>。</li>
            </ol>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-5">
            <h2 className="font-semibold">已连接令牌</h2>
            <div className="mt-3 divide-y divide-black/8">
              {tokens.map((token) => (
                <div key={token.id} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <p className="text-sm font-medium">{token.name}</p>
                    <p className="mt-0.5 text-xs text-black/45">
                      {token.revokedAt ? "已撤销" : token.lastSeenAt ? `最近连接：${formatTime(token.lastSeenAt)}` : "尚未连接"}
                    </p>
                  </div>
                  {!token.revokedAt ? (
                    <form action={revokeRunnerTokenAction.bind(null, token.id)}>
                      <button className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50" type="submit">撤销</button>
                    </form>
                  ) : null}
                </div>
              ))}
              {tokens.length === 0 ? <p className="py-6 text-center text-sm text-black/45">尚未生成令牌</p> : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}
