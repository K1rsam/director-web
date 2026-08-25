import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { revokeRunnerTokenAction } from "@/app/actions";
import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { getDb } from "@/db";
import { runnerTokens } from "@/db/schema";
import { requireSessionUser } from "@/lib/auth";
import { DeepSeekKeySetup } from "./deepseek-key-setup";
import { RunnerTokenForm } from "./token-form";

export const dynamic = "force-dynamic";

export default async function RunnerPage() {
  const user = await requireSessionUser("/runner");
  await ensureControlPlaneSchema();
  const tokens = await getDb()
    .select()
    .from(runnerTokens)
    .where(eq(runnerTokens.ownerUserId, user.id))
    .orderBy(desc(runnerTokens.createdAt));

  return (
    <main className="min-h-screen bg-[#f2f5ff] px-5 py-8 text-[#171d35] sm:px-8">
      <div className="mx-auto max-w-3xl">
        <Link className="text-sm font-medium text-[#6258d5] hover:underline" href="/">← 返回项目</Link>
        <h1 className="mt-5 text-3xl font-bold tracking-tight">执行方式连接</h1>
        <p className="mt-2 text-sm leading-6 text-black/60">每位用户使用自己的 API Key 或自己的 Codex CLI。网站不会调用站长的账号或额度。</p>

        <div className="mt-6 grid gap-5">
          <DeepSeekKeySetup />
          <RunnerTokenForm />

          <section className="rounded-2xl border border-black/10 bg-[#171d35] p-5 text-white">
            <h2 className="font-semibold">怎么选</h2>
            <div className="mt-3 grid gap-3 text-sm leading-6 text-white/70 sm:grid-cols-2">
              <p><b className="text-white">API：</b>粘贴自己的 DeepSeek Key，测试成功后即可关闭此页；只在这台设备生效。</p>
              <p><b className="text-white">CLI：</b>生成启动器并运行；窗口保持打开时，网站任务才会交给你自己的 Codex。</p>
            </div>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-5">
            <h2 className="font-semibold">我的 CLI 设备</h2>
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
              {tokens.length === 0 ? <p className="py-6 text-center text-sm text-black/45">尚未连接 CLI 设备</p> : null}
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
