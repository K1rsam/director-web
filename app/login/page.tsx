import { redirect } from "next/navigation";
import { sanitizeReturnTo } from "@/lib/auth-crypto";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

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
    <main className="loginShell">
      <section className="loginCard" aria-labelledby="login-title" aria-describedby="login-description login-access-note">
        <div className="loginBrand">
          <span aria-hidden="true">L</span>
          <div><strong>分镜工作台</strong><small>Director Studio</small></div>
        </div>
        <header className="loginHeading">
          <h1 id="login-title" className="pageTitle">登录你的工作台</h1>
          <span id="login-description">每个账号只会看到自己的项目与制作内容。</span>
        </header>
        <LoginForm returnTo={returnTo} />
        <p id="login-access-note" className="loginFootnote">当前为私有测试环境，请使用已分配的账号。</p>
      </section>
    </main>
  );
}
