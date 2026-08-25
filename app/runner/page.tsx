import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { revokeRunnerTokenAction } from "@/app/actions";
import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { getDb } from "@/db";
import { runnerTokens } from "@/db/schema";
import { requireSessionUser } from "@/lib/auth";
import { AppChrome } from "@/app/ui/app-chrome";
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
    <AppChrome
      title="API 与 CLI"
      eyebrow="执行设置"
      activeSection="runner"
      utility={<div className="runnerTopbarMeta"><span>个人凭证</span><span>本机额度</span></div>}
      primaryAction={<Link href="/" className="topbarPrimary">返回项目总览</Link>}
    >
      <section className="runnerSettingsPage">
        <header className="runnerHero studioCard">
          <span className="runnerHeroIcon" aria-hidden="true">↗</span>
          <div>
            <p className="sectionEyebrow">PERSONAL EXECUTION</p>
            <h1>使用你自己的执行额度</h1>
            <p>API Key 只留在当前浏览器；Codex CLI 只在你自己的电脑运行。网站不会调用站长的账号或额度。</p>
          </div>
          <div className="runnerHeroAssurance"><span>账号隔离</span><strong>每位用户独立连接</strong></div>
        </header>

        <div className="runnerConnectionGrid">
          <DeepSeekKeySetup />
          <RunnerTokenForm />
        </div>

        <section className="runnerChoiceGuide studioCard">
          <header className="runnerSectionHeader">
            <div><p className="sectionEyebrow">QUICK GUIDE</p><h2>怎么选择</h2></div>
            <p>两种方式都使用用户自己的额度，不需要项目源码。</p>
          </header>
          <div className="runnerChoiceGrid">
            <article><span>01</span><div><strong>直接使用 API</strong><p>粘贴自己的 DeepSeek Key，测试成功后即可关闭本页；只在这台设备生效。</p></div></article>
            <article><span>02</span><div><strong>使用 Codex CLI</strong><p>生成启动器并保持窗口运行，网站任务才会交给这台电脑上的 Codex。</p></div></article>
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
