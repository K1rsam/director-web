"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getD1 } from "@/db";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { sanitizeReturnTo, SESSION_DURATION_MS } from "@/lib/auth-crypto";
import { authenticateCredentials, createSession, revokeSession } from "@/lib/repositories/auth";

export type LoginState = { error: string };

const INVALID_CREDENTIALS_MESSAGE = "账号或密码错误";

export async function loginAction(_previousState: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const returnTo = sanitizeReturnTo(String(formData.get("returnTo") ?? "/"));
  if (!username.trim() || !password) return { error: INVALID_CREDENTIALS_MESSAGE };

  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    const user = await authenticateCredentials(getD1(), username, password);
    if (!user) return { error: INVALID_CREDENTIALS_MESSAGE };
    session = await createSession(getD1(), user.id);
  } catch {
    return { error: "暂时无法登录，请稍后重试" };
  }

  (await cookies()).set(SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
    expires: session.expiresAt,
  });
  redirect(returnTo);
}

export async function logoutAction(): Promise<never> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    try {
      await revokeSession(getD1(), token);
    } catch {
      // 数据库暂不可用时仍清除浏览器凭证。
    }
  }
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
  redirect("/login");
}
