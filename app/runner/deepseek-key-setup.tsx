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
    <section className="runnerConnectionCard studioCard">
      <div className="runnerConnectionHeader">
        <div>
          <p className="sectionEyebrow">API MODE</p>
          <h2>连接自己的 DeepSeek</h2>
          <p>Key 只保存在当前设备，调用时临时转发；网站数据库不会保存。</p>
        </div>
        <span className={`runnerConnectionStatus ${connected ? "connected" : ""}`}>
          {connected ? "已保存" : "未连接"}
        </span>
      </div>

      <div className="runnerFieldGrid">
        <label>
          <span>DeepSeek API Key</span>
          <input
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="粘贴你自己的 Key"
            spellCheck={false}
            type="password"
            value={apiKey}
          />
        </label>
        <label>
          <span>模型</span>
          <select onChange={(event) => setModel(event.target.value)} value={model}>
            <option value="deepseek-v4-pro">V4 Pro</option>
            <option value="deepseek-v4-flash">V4 Flash</option>
          </select>
        </label>
      </div>

      <div className="runnerActions">
        <button className="glassPrimary runnerPrimaryButton" disabled={pending} onClick={testAndSave} type="button">
          {pending ? "测试中" : "测试并保存本设备"}
        </button>
        {apiKey ? <button className="quietButton runnerSecondaryButton" onClick={clearKey} type="button">删除 Key</button> : null}
        {message ? <p className={`runnerMessage ${connected ? "success" : "error"}`}>{message}</p> : null}
      </div>
    </section>
  );
}
