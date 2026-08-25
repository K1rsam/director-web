"use client";

import { useActionState } from "react";

import { createRunnerTokenAction, type RunnerTokenState } from "@/app/actions";

const initialState: RunnerTokenState = { token: null, error: null };

export function RunnerTokenForm() {
  const [state, action, pending] = useActionState(createRunnerTokenAction, initialState);

  return (
    <div className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
      <h2 className="font-semibold">连接一台设备</h2>
      <p className="mt-1 text-sm text-black/55">令牌只显示一次，请立即保存到该设备。</p>
      <form action={action} className="mt-4 flex gap-2">
        <input className="min-w-0 flex-1 rounded-xl border border-black/15 px-3 py-2.5 outline-none focus:border-[#d84a2b]" name="name" placeholder="例如：Mac Studio" maxLength={60} required />
        <button className="rounded-xl bg-[#201c18] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={pending} type="submit">
          {pending ? "生成中" : "生成令牌"}
        </button>
      </form>
      {state.error ? <p className="mt-3 text-sm text-red-700">{state.error}</p> : null}
      {state.token ? (
        <div className="mt-4 rounded-xl border border-[#d84a2b]/25 bg-[#fff3ee] p-3">
          <p className="text-xs font-semibold text-[#a9341d]">一次性 Runner 令牌</p>
          <code className="mt-2 block break-all text-xs text-black/75">{state.token}</code>
        </div>
      ) : null}
    </div>
  );
}
