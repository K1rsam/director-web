"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, messageOf, type NewSettings, type Run, type RunIndex } from "./types";

class RequestError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

export function useWorkbench(episodeId: string) {
  const endpoint = `/api/episodes/${encodeURIComponent(episodeId)}/storyboard`;
  const [index, setIndex] = useState<RunIndex | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [runId, setRunId] = useState("");
  const [settings, setSettings] = useState<NewSettings>({ ...DEFAULT_SETTINGS });
  const [budget, setBudget] = useState({ maxCalls: 32, maxTokens: 300000 });
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creationUncertain, setCreationUncertain] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const alive = useRef(false), lifecycle = useRef(0), busy = useRef(false), generation = useRef(0), readSequence = useRef(0), indexSequence = useRef(0), currentId = useRef("");
  const pendingReads = useRef(new Map<string,Promise<void>>());

  const readJson = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { cache: "no-store", ...init });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new RequestError(data.error || `请求未成功（${response.status}）`, response.status, data.code);
    return data;
  }, []);

  const rememberUrl = useCallback((id: string) => {
    const url = new URL(window.location.href);
    id ? url.searchParams.set("runId", id) : url.searchParams.delete("runId");
    window.history.replaceState(null, "", url);
  }, []);

  const applyRun = useCallback((next: Run, restoreSettings: boolean) => {
    setRun(next); setSyncedAt(Date.now());
    setError(previous => previous.startsWith("状态同步暂未成功：") ? "" : previous);
    setIndex(previous => previous ? { ...previous, runs: previous.runs.map(item => item.id === next.id ? { ...item, status: next.status, active: next.active,legacyReadOnly:next.legacyReadOnly } : item) } : previous);
    if (restoreSettings) {
      setSettings({ maxUnitSeconds: next.settings.maxUnitSeconds, fantasyMode: next.settings.fantasyMode, notes: next.directorNotes || "", maxCalls: next.budget.maxCalls, maxTokens: next.budget.maxTokens });
      setBudget({ maxCalls: next.budget.maxCalls, maxTokens: next.budget.maxTokens });
    }
  }, []);

  const loadIndex = useCallback(async (saved=false) => {
    const sequence = ++indexSequence.current, life = lifecycle.current;
    const next = await readJson(endpoint+(saved?'?view=saved':'')) as RunIndex;
    if (!alive.current || life !== lifecycle.current || sequence !== indexSequence.current) return null;
    setIndex(next);
    return next;
  }, [endpoint, readJson]);

  const loadRun = useCallback((id: string, restoreSettings = false, saved=false) => {
    const epoch = generation.current,key=`${epoch}:${id}:${saved}`,existing=pendingReads.current.get(key);
    if(existing)return existing;
    const sequence = ++readSequence.current;
    const task=(async()=>{
      try {
        const data = await readJson(`${endpoint}?runId=${encodeURIComponent(id)}${saved?'&view=saved':''}`);
        if (!alive.current || currentId.current !== id || generation.current !== epoch || readSequence.current !== sequence) return;
        if (data.run?.id !== id) throw new RequestError("返回的任务与当前选择不一致，未覆盖当前页面。");
        applyRun(data.run as Run, restoreSettings);
      } catch (reason) {
        if (alive.current && currentId.current === id && generation.current === epoch && readSequence.current === sequence) throw reason;
      }
    })();
    pendingReads.current.set(key,task);
    void task.finally(()=>{if(pendingReads.current.get(key)===task)pendingReads.current.delete(key);}).catch(()=>{});
    return task;
  }, [endpoint, readJson, applyRun]);

  const chooseRun = useCallback(async (id: string) => {
    if (busy.current) return;
    const epoch = ++generation.current;
    readSequence.current++;
    currentId.current = id;
    setRunId(id); setRun(null); setDetailLoading(Boolean(id)); setError(""); setNotice("");
    rememberUrl(id);
    try { if (id) await loadRun(id, true, true); }
    catch (reason) { if (alive.current && generation.current === epoch) setError(messageOf(reason)); }
    finally { if (alive.current && generation.current === epoch) {setDetailLoading(false);setLoading(false);} }
    if(id&&alive.current&&generation.current===epoch){
      try{await loadRun(id);}
      catch(reason){if(alive.current&&generation.current===epoch)setError(`状态同步暂未成功：${messageOf(reason)}。已显示的保存内容仍保留。`);}
    }
  }, [loadRun, rememberUrl]);

  useEffect(() => {
    const life = ++lifecycle.current;
    alive.current = true;
    busy.current = false;
    generation.current++; readSequence.current++; indexSequence.current++;
    currentId.current = "";
    setIndex(null); setRun(null); setRunId(""); setLoading(true); setError(""); setPending(""); setNotice(""); setCreationUncertain(false);
    setSettings({ ...DEFAULT_SETTINGS }); setBudget({ maxCalls: DEFAULT_SETTINGS.maxCalls, maxTokens: DEFAULT_SETTINGS.maxTokens });
    const epoch = generation.current;
    void loadIndex(true).then(async next => {
      if (!next || !alive.current || generation.current !== epoch) return;
      void loadIndex().catch(reason=>{if(alive.current&&life===lifecycle.current)setError(`资料准备核对暂未成功：${messageOf(reason)}。保存内容仍可查看，请刷新重试。`);});
      const fromUrl = new URLSearchParams(window.location.search).get("runId");
      const id = next.runs.find(item => item.id === fromUrl)?.id || next.runs[0]?.id;
      if (id) await chooseRun(id);
    }).catch(reason => { if (alive.current && life === lifecycle.current) setError(messageOf(reason)); })
      .finally(() => { if (alive.current && life === lifecycle.current) setLoading(false); });
    return () => { alive.current = false; generation.current++; readSequence.current++; indexSequence.current++; };
  }, [loadIndex, chooseRun]);

  useEffect(() => {
    if (!runId || detailLoading) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!busy.current && document.visibilityState !== "hidden") {
        try { await loadRun(runId); }
        catch (reason) { if (!cancelled && alive.current) setError(`状态同步暂未成功：${messageOf(reason)}。已显示的成果仍保留。`); }
      }
      if (!cancelled) timer = setTimeout(poll, run?.active ? 2000 : 8000);
    };
    timer = setTimeout(poll, run?.active ? 1500 : 8000);
    const focus = () => { if (!busy.current) void loadRun(runId).catch(reason => { if (alive.current) setError(messageOf(reason)); }); };
    window.addEventListener("focus", focus);
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener("focus", focus); };
  }, [runId, run?.active, detailLoading, loadRun]);

  const settingsReady = Boolean(index && !loading && !detailLoading && (!runId || run?.id === runId && !run.sourceCheckPending) && !creationUncertain && index.preparation?.ready !== false);
  const canCreate = settingsReady && (run?.legacyReadOnly || !run?.active && !run?.operations.some(op => op.status === "running" || op.status === "unknown" && !op.cancelAcknowledgement?.acceptUnknownUsage))
    && !index?.runs.some(item => !item.legacyReadOnly && (item.active || ["running", "pausing", "unknown", "interrupted"].includes(item.status)));

  const act = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    if (busy.current || action === "create" && !canCreate) return null;
    if(action!=='create'&&(run?.id!==currentId.current||run?.legacyReadOnly)){setError('旧版任务仅可查看和导出；未提交变更。');return null;}
    const epoch = ++generation.current;
    readSequence.current++; indexSequence.current++;
    const target = currentId.current;
    busy.current = true; setPending(action); setError(""); setNotice("");
    try {
      const data = await readJson(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-storyboard-action": "1" }, body: JSON.stringify({ action, ...(action === "create" ? {} : { runId: target }), ...payload }) });
      if (!alive.current || generation.current !== epoch || currentId.current !== target) return null;
      const next = data.run as Run;
      if (!next?.id || action !== "create" && next.id !== target) throw new RequestError("任务返回不匹配，未覆盖当前页面。请刷新核对。");
      currentId.current = next.id; setRunId(next.id); applyRun(next, action === "create"); rememberUrl(next.id);
      if (action === "budget") setBudget({ maxCalls: next.budget.maxCalls, maxTokens: next.budget.maxTokens });
      setCreationUncertain(false);
      setNotice(action === "create" ? "任务已创建，尚未调用生成模型。" : action === "start" || action === "repair" || action === "replan" ? "请求已受理，真实进度会自动更新。" : action === "pause" ? "已请求暂停新派单，等待在途结果保存。" : action === "stop" ? "已发出中断请求；请核对回包与未知用量。" : action === "choice" || action === "confirm" ? "选择已保存；尚未启动新的生成。" : action === "acknowledge_cancel" ? "已记录风险确认，没有启动新请求。" : "操作已保存。" );
      // A list-refresh failure must not turn an acknowledged create into an unknown creation.
      await loadIndex().catch(() => {});
      return next;
    } catch (reason) {
      if (!alive.current || generation.current !== epoch) return null;
      setError(messageOf(reason));
      if (action === "create" && (!(reason instanceof RequestError) || !reason.status || reason.status >= 500)) {
        setCreationUncertain(true); setNotice("创建结果尚未确认。先刷新任务列表核对，不重复创建。");
      } else if (target) await loadRun(target).catch(() => {});
      return null;
    } finally {
      if (alive.current && generation.current === epoch) { busy.current = false; setPending(""); }
    }
  }, [canCreate, run, readJson, endpoint, applyRun, rememberUrl, loadIndex, loadRun]);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    setError("");
    try {
      const next = await loadIndex();
      if (!next || !alive.current) return;
      if (creationUncertain) {
        setCreationUncertain(false);
        if (next.runs[0]) await chooseRun(next.runs[0].id);
        setNotice("任务列表已核对，请查看已有记录后决定是否新建。");
      } else if (currentId.current) await loadRun(currentId.current);
    } catch (reason) { if (alive.current) setError(messageOf(reason)); }
  }, [loadIndex, loadRun, chooseRun, creationUncertain]);

  return { endpoint, index, run, runId, settings, setSettings, budget, setBudget, loading, detailLoading, pending, error, notice, setNotice, setError, settingsReady, canCreate, creationUncertain, syncedAt, chooseRun, act, refresh };
}
