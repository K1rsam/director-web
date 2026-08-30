"use client";

import { useActionState } from "react";

import { loginAction, type LoginState } from "@/app/auth-actions";

const initialState: LoginState = { error: "" };

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [state, formAction, isPending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="loginForm">
      <input type="hidden" name="returnTo" value={returnTo} />
      <label>
        <span>账号</span>
        <input
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          placeholder="请输入测试账号"
        />
      </label>
      <label>
        <span>密码</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="请输入密码"
        />
      </label>
      {state.error ? <p className="loginError" role="alert">{state.error}</p> : null}
      <button type="submit" disabled={isPending}>{isPending ? "正在登录…" : "进入工作台"}</button>
    </form>
  );
}
