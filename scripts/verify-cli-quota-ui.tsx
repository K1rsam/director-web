import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodexCliStatus, CodexCliStatusWindow } from "../lib/codex-cli";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const reactModule = require.cache[require.resolve("react")]!;
const originalReact = reactModule.exports;
const actions = {
  checkCodexCliAction() { throw new Error("No CLI calls in this rendering test"); },
  removeDeepSeekCredentialAction() { throw new Error("No credential writes in this test"); },
  saveDeepSeekCredentialAction() { throw new Error("No credential writes in this test"); }
};
let cliState: { ok: boolean; message: string; cliStatus?: CodexCliStatus } = { ok: true, message: "" };

try {
  // Supply completed action state; render the real panel without server actions or a database.
  Module._load = function (name: string, ...args: unknown[]) {
    return name === "@/app/actions" ? actions : originalLoad.call(this, name, ...args);
  };
  reactModule.exports = { ...originalReact, useActionState: (action: unknown) => [
    action === actions.checkCodexCliAction ? cliState : { ok: false, message: "" }, () => {}, false
  ] };
  const { ProviderConnectionPanel } = require("../app/runner/provider-connection-panel") as typeof import("../app/runner/provider-connection-panel");
  const window = (minutes: number | null, usedPercent = 63): CodexCliStatusWindow => ({
    windowDurationMins: minutes, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: 1790729141
  });
  const render = (primary: CodexCliStatusWindow | null, secondary: CodexCliStatusWindow | null) => {
    cliState = { ok: true, message: "", cliStatus: {
      version: "fixture", account: { type: "chatgpt", email: null, planType: "pro" },
      limits: [{ id: "codex", name: null, planType: "pro", primary, secondary, credits: null, individualLimit: null, rateLimitReachedType: null }],
      usage: { lifetimeTokens: null, peakDailyTokens: null, currentStreakDays: null, longestStreakDays: null, latestDailyUsage: null },
      checkedAt: "2026-09-26T01:20:00Z", warnings: []
    } };
    return renderToStaticMarkup(createElement(ProviderConnectionPanel, { initialApi: {
      connected: false, apiBase: "https://api.deepseek.com", model: "deepseek-chat", keyHint: null, lastTestedAt: null, error: null
    } }));
  };
  const weekly = render(window(10080), null);
  assert.match(weekly, /<span>7 天额度<\/span><strong>剩余 37%<\/strong>/, "A weekly primary window must be labelled as seven days");
  assert.doesNotMatch(weekly, /5 小时额度/, "Absent secondary windows must not create a fictitious quota card");
  assert.equal((weekly.match(/<article>/g) ?? []).length, 3, "Only account, weekly quota and usage cards are present");
  for (const html of [render(window(300, 25), window(10080)), render(window(10080), window(300, 25))]) {
    assert.match(html, /<span>5 小时额度<\/span><strong>剩余 75%<\/strong>/);
    assert.match(html, /<span>7 天额度<\/span><strong>剩余 37%<\/strong>/);
  }
  assert.match(render(window(90), null), /90 分钟额度/);
  assert.match(render(window(null), null), /额度窗口/);
  assert.match(render(null, null), /暂不可读/);
  assert.doesNotMatch(render(null, null), /5 小时额度|7 天额度|无限制/);
  console.log("PASS: actual quota panel renders weekly-only, both window orders, custom duration and unknown data; no model, DB or network calls");
} finally {
  Module._load = originalLoad;
  reactModule.exports = originalReact;
}
