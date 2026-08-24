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
      <section className="loginCard" aria-labelledby="login-title">
        <div className="loginBrand" aria-hidden="true">
          <span>镜</span>
          <div><strong>分镜工作台</strong><small>Director Studio</small></div>
        </div>
        <div className="loginHeading">
          <p>PRIVATE WORKSPACE</p>
          <h1 id="login-title">登录你的工作台</h1>
          <span>每个账号只会看到自己的项目与制作内容。</span>
        </div>
        <LoginForm returnTo={returnTo} />
        <p className="loginFootnote">当前为私有测试环境，请使用已分配的账号。</p>
      </section>
    </main>
  );
}
