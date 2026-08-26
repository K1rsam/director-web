"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  checkCodexCliAction,
  removeDeepSeekCredentialAction,
  saveDeepSeekCredentialAction,
  type ProviderConnectionState
} from "@/app/actions";

type InitialApiStatus = {
  connected: boolean;
  apiBase: string;
  model: string;
  keyHint: string | null;
  lastTestedAt: string | null;
  error: string | null;
};

const initialActionState: ProviderConnectionState = { ok: false, message: "" };

export function ProviderConnectionPanel({ initialApi }: { initialApi: InitialApiStatus }) {
  const [apiState, apiAction, apiPending] = useActionState(saveDeepSeekCredentialAction, initialActionState);
  const [removeState, removeAction, removePending] = useActionState(removeDeepSeekCredentialAction, initialActionState);
  const [cliState, cliAction, cliPending] = useActionState(checkCodexCliAction, initialActionState);
  const apiKeyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (apiState.ok && apiState.provider === "DEEPSEEK" && apiKeyRef.current) {
      apiKeyRef.current.value = "";
    }
  }, [apiState]);

  const apiMessage = apiState.message || initialApi.error || "Key 只会加密保存在当前账号下，不会写入浏览器 localStorage。";
  const apiMessageClass = apiState.message
    ? (apiState.ok ? "success" : "error")
    : (initialApi.error ? "error" : "");
  const cliMessageClass = cliState.message ? (cliState.ok ? "success" : "error") : "";
  const apiStatusLabel = initialApi.connected ? "已连接" : "未连接";
  const cliStatusLabel = cliState.ok ? "已就绪" : "本机检测";

  return (
    <div className="runnerConnectionGrid">
      <section className="runnerConnectionCard studioCard">
        <div className="runnerConnectionHeader">
          <div>
            <p className="sectionEyebrow">API MODE</p>
            <h2>连接自己的 DeepSeek</h2>
            <p>先验证 `/models`，验证成功后才保存。保存的是当前账号的加密凭证，项目 API 执行会读取项目管理员账号的凭证。</p>
          </div>
          <span className={`runnerConnectionStatus ${initialApi.connected ? "connected" : ""}`}>{apiStatusLabel}</span>
        </div>

        <div className="runnerCredentialForm">
          <form action={apiAction} className="runnerSaveForm">
            <div className="runnerFieldGrid">
              <label>
                <span>DeepSeek API Key</span>
                <input
                  ref={apiKeyRef}
                  name="apiKey"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder={initialApi.connected ? "输入新 Key 以替换当前 Key" : "粘贴 sk- 开头的 API Key"}
                />
              </label>
              <label>
                <span>模型</span>
                <select name="model" defaultValue={initialApi.model}>
                  <option value="deepseek-chat">deepseek-chat</option>
                  <option value="deepseek-reasoner">deepseek-reasoner</option>
                  <option value="deepseek-v4-flash">deepseek-v4-flash</option>
                </select>
              </label>
            </div>
            <label className="runnerWideField">
              <span>API 地址</span>
              <input name="apiBase" type="url" defaultValue={initialApi.apiBase} required />
            </label>
            <div className="runnerCredentialMeta">
              <span>{initialApi.keyHint ? `当前 Key：${initialApi.keyHint}` : "尚未保存账号 Key"}</span>
              {initialApi.lastTestedAt ? <time dateTime={initialApi.lastTestedAt}>最近验证：{formatDate(initialApi.lastTestedAt)}</time> : null}
            </div>
            <div className="runnerActions">
              <button className="glassPrimary runnerPrimaryButton" type="submit" disabled={apiPending}>
                {apiPending ? "正在验证…" : "验证并保存"}
              </button>
              {apiMessage ? <p className={`runnerMessage ${apiMessageClass}`} role="status">{apiMessage}</p> : null}
            </div>
            {apiState.ok && apiState.models?.length ? (
              <p className="runnerConnectionNote">已读取模型：{apiState.models.slice(0, 5).join("、")}{apiState.models.length > 5 ? " 等" : ""}</p>
            ) : null}
          </form>
          {initialApi.connected ? (
            <form action={removeAction} className="runnerActions runnerRemoveAction">
              <button className="quietButton runnerSecondaryButton" type="submit" disabled={removePending}>
                {removePending ? "正在删除…" : "删除已保存 Key"}
              </button>
              {removeState.message ? <p className={`runnerMessage ${removeState.ok ? "success" : "error"}`} role="status">{removeState.message}</p> : null}
            </form>
          ) : null}
        </div>
      </section>

      <section className="runnerConnectionCard studioCard">
        <div className="runnerConnectionHeader">
          <div>
            <p className="sectionEyebrow">CLI MODE</p>
            <h2>使用本机 Codex CLI</h2>
            <p>CLI 不上传账号令牌，也不在网页保存登录信息；任务沿用这台电脑当前的 Codex CLI 登录态。</p>
          </div>
          <span className={`runnerConnectionStatus ${cliState.ok ? "connected" : ""}`}>{cliStatusLabel}</span>
        </div>

        <div className="runnerLauncherPanel">
          <strong>本机检查范围</strong>
          <p>只运行 `codex --version` 和 `codex login status`，不消耗模型额度；通过后，CLI 项目可以使用现有的本地执行流水线。</p>
        </div>
        <form action={cliAction} className="runnerActions">
          <button className="glassPrimary runnerPrimaryButton" type="submit" disabled={cliPending}>
            {cliPending ? "正在检查…" : "测试本机 Codex CLI"}
          </button>
          {cliMessageClass ? <p className={`runnerMessage ${cliMessageClass}`} role="status">{cliState.message}</p> : null}
          {cliState.version ? <p className="runnerConnectionNote">检测到：{cliState.version}</p> : null}
        </form>
      </section>
    </div>
  );
}

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

