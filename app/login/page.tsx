import { redirect } from "next/navigation";
import { sanitizeReturnTo } from "@/lib/auth-crypto";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";
import "@/app/page-surfaces.css";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo: requestedReturnTo } = await searchParams;
  const returnTo = sanitizeReturnTo(requestedReturnTo);
  if (await getCurrentUser()) {
    redirect(returnTo);
  }

  return (
    <main className="loginShell pageSurface loginSurface">
      <div className="loginComposition">
        <aside className="loginContext" aria-label="分镜工作台介绍">
          <div className="loginBrand">
            <span aria-hidden="true">L</span>
            <div><strong>分镜工作台</strong><small>Director Studio</small></div>
          </div>
          <div className="loginWorkflow">
            <h2>剧本制作工作区</h2>
            <ol>
              <li><span aria-hidden="true">01</span><div><strong>导入完整剧本</strong><p>保留剧本原文，设定画面风格。</p></div></li>
              <li><span aria-hidden="true">02</span><div><strong>整理全剧资料</strong><p>建立项目策划、场景与资产索引。</p></div></li>
              <li><span aria-hidden="true">03</span><div><strong>推进分集制作</strong><p>查看制作进度与 Seedance 分镜单元。</p></div></li>
            </ol>
          </div>
        </aside>
        <section className="loginCard" aria-labelledby="login-title" aria-describedby="login-description login-access-note">
          <header className="loginHeading">
            <h1 id="login-title" className="pageTitle">登录你的工作台</h1>
            <span id="login-description">每个账号只会看到自己的项目与制作内容。</span>
          </header>
          <LoginForm returnTo={returnTo} />
          <p id="login-access-note" className="loginFootnote">当前为私有测试环境，请使用已分配的账号。</p>
        </section>
      </div>
    </main>
  );
}
