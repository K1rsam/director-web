"use client";

import { useEffect, useState } from "react";

const KEY_STORAGE = "director.deepseek.apiKey";
const MODEL_STORAGE = "director.deepseek.model";

export function DeepSeekKeySetup() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("deepseek-v4-pro");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedKey = localStorage.getItem(KEY_STORAGE) ?? "";
      const savedModel = localStorage.getItem(MODEL_STORAGE);
      setApiKey(savedKey);
      setConnected(Boolean(savedKey));
      if (savedModel === "deepseek-v4-flash" || savedModel === "deepseek-v4-pro") setModel(savedModel);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function testAndSave() {
    const value = apiKey.trim();
    if (!value) {
      setMessage("请先填写 API Key。");
      return;
    }

    setPending(true);
    setMessage("正在测试…");
    try {
      const response = await fetch("/api/providers/deepseek/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: value }),
      });
      const result = (await response.json()) as { ok?: boolean; error?: string; models?: string[] };
      if (!response.ok || !result.ok) throw new Error(result.error || "连接失败。");

      localStorage.setItem(KEY_STORAGE, value);
      localStorage.setItem(MODEL_STORAGE, model);
      setConnected(true);
      setMessage("连接成功，已保存到当前设备。");
    } catch (error) {
      setConnected(false);
      setMessage(error instanceof Error ? error.message : "连接失败。");
    } finally {
      setPending(false);
    }
  }

  function clearKey() {
    localStorage.removeItem(KEY_STORAGE);
    localStorage.removeItem(MODEL_STORAGE);
    setApiKey("");
    setConnected(false);
    setMessage("已从当前设备删除。");
  }

  return (
    <section className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-[#6258d5]">API 模式</p>
          <h2 className="mt-1 text-lg font-semibold">连接自己的 DeepSeek</h2>
          <p className="mt-1 text-sm leading-6 text-black/55">Key 只保存在当前设备，调用时临时转发；网站数据库不会保存。</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${connected ? "bg-emerald-50 text-emerald-700" : "bg-black/5 text-black/45"}`}>
          {connected ? "已保存" : "未连接"}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_190px]">
        <label className="grid gap-1.5 text-sm font-medium">
          DeepSeek API Key
          <input
            autoComplete="off"
            className="min-w-0 rounded-xl border border-black/15 px-3 py-2.5 outline-none focus:border-[#6258d5]"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="粘贴你自己的 Key"
            spellCheck={false}
            type="password"
            value={apiKey}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          模型
          <select className="rounded-xl border border-black/15 px-3 py-2.5 outline-none focus:border-[#6258d5]" onChange={(event) => setModel(event.target.value)} value={model}>
            <option value="deepseek-v4-pro">V4 Pro</option>
            <option value="deepseek-v4-flash">V4 Flash</option>
          </select>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="rounded-xl bg-[#6258d5] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={pending} onClick={testAndSave} type="button">
          {pending ? "测试中" : "测试并保存本设备"}
        </button>
        {apiKey ? <button className="rounded-xl border border-black/10 px-4 py-2.5 text-sm font-medium text-black/60" onClick={clearKey} type="button">删除 Key</button> : null}
        {message ? <p className={`text-sm ${connected ? "text-emerald-700" : "text-[#a9341d]"}`}>{message}</p> : null}
      </div>
    </section>
  );
}
