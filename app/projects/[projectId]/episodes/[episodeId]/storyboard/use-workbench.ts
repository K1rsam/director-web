"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, messageOf, type NewSettings, type Run, type RunIndex, type WorkbenchSnapshot } from "./types";

class RequestError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

const needsLiveRead = (run?:Run|null) => Boolean(run?.active || run?.operations.some(op=>op.canRecoverSaved||op.status==='running'||op.status==='unknown'&&!op.cancelAcknowledgement?.acceptUnknownUsage) || run?.production?.blocking || run?.production?.pendingRepair);

export function useWorkbench(episodeId: string, initialSnapshot?:WorkbenchSnapshot) {
  const snapshot=initialSnapshot?.episodeId===episodeId?initialSnapshot:undefined;
  const saved=snapshot?.run;
  const endpoint = `/api/episodes/${encodeURIComponent(episodeId)}/storyboard`;
  const [index, setIndex] = useState<RunIndex | null>(snapshot?.index??null);
  const [run, setRun] = useState<Run | null>(saved??null);
  const [runId, setRunId] = useState(saved?.id??"");
  const [settings, setSettings] = useState<NewSettings>(saved?{maxUnitSeconds:saved.settings.maxUnitSeconds,fantasyMode:saved.settings.fantasyMode,notes:saved.directorNotes||'',maxCalls:saved.budget.maxCalls,maxTokens:saved.budget.maxTokens}:{...DEFAULT_SETTINGS});
  const [budget, setBudget] = useState({ maxCalls: saved?.budget.maxCalls??DEFAULT_SETTINGS.maxCalls, maxTokens: saved?.budget.maxTokens??DEFAULT_SETTINGS.maxTokens });
  const [loading, setLoading] = useState(!snapshot?.index);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState(snapshot?.error??"");
  const [notice, setNotice] = useState("");
  const [creationUncertain, setCreationUncertain] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(saved?snapshot!.savedAt:null);
  const alive = useRef(false), lifecycle = useRef(0), busy = useRef(false), generation = useRef(0), readSequence = useRef(0), indexSequence = useRef(0), currentId = useRef("");
  const pendingReads = useRef(new Map<string,Promise<void>>());
  const readBarrier=useRef(0), pendingJsonReads=useRef(new Map<string,Promise<any>>());
  // Instance-local only: no cross-account/global cache or persisted script data.
  const savedRuns = useRef(new Map<string,Run>());

  const readJson = useCallback(async (url: string, init?: RequestInit) => {
    const isRead=!init?.method||init.method==='GET',key=`${readBarrier.current}:${url}`;
    if(isRead&&pendingJsonReads.current.has(key))return pendingJsonReads.current.get(key)!;
    const task=(async()=>{
      const response = await fetch(url, { cache: "no-store", ...init });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new RequestError(data.error || `请求未成功（${response.status}）`, response.status, data.code);
      return data;
    })();
    if(isRead){pendingJsonReads.current.set(key,task);void task.finally(()=>{if(pendingJsonReads.current.get(key)===task)pendingJsonReads.current.delete(key);}).catch(()=>{});}
    return task;
  }, []);

  const rememberUrl = useCallback((id: string) => {
    const url = new URL(window.location.href);
    id ? url.searchParams.set("runId", id) : url.searchParams.delete("runId");
    window.history.replaceState(null, "", url);
  }, []);

  const applyRun = useCallback((next: Run, restoreSettings: boolean) => {
    const previous=savedRuns.current.get(next.id);
    // Saved-state reads can update progress, but cannot contradict a known failed source check.
    // Only a checked response (including a freshly validated POST) may clear that failure.
    if(next.preparation?.deferred&&previous&&(previous.sourceStale||previous.preparation?.ready===false&&!previous.preparation.deferred))next={...next,
      sourceStale:next.sourceStale||previous.sourceStale,blocked:true,preparation:previous.preparation,error:previous.error||next.error};
    savedRuns.current.set(next.id,next);
    setRun(next); setSyncedAt(Date.now());
    setError(previous => previous.startsWith("状态同步暂未成功：") ? "" : previous);
    setIndex(previous => previous ? { ...previous, runs: previous.runs.map(item => item.id === next.id ? { ...item, status: next.status, active: next.active,legacyReadOnly:next.legacyReadOnly } : item) } : previous);
    if (restoreSettings) {
      setSettings({ maxUnitSeconds: next.settings.maxUnitSeconds, fantasyMode: next.settings.fantasyMode, notes: next.directorNotes || "", maxCalls: next.budget.maxCalls, maxTokens: next.budget.maxTokens });
      setBudget({ maxCalls: next.budget.maxCalls, maxTokens: next.budget.maxTokens });
    }
  }, []);

  const loadIndex = useCallback(async (saved=true) => {
    const sequence = ++indexSequence.current, life = lifecycle.current;
    const next = await readJson(endpoint+(saved?'?view=saved':'')) as RunIndex;
    if (!alive.current || life !== lifecycle.current || sequence !== indexSequence.current) return null;
    setIndex(next);
    return next;
  }, [endpoint, readJson]);

  const loadRun = useCallback((id: string, restoreSettings = false, saved=false, includeIndex=false) => {
    const epoch = generation.current,key=`${epoch}:${id}:${saved}:${includeIndex}`,existing=pendingReads.current.get(key);
    if(existing)return existing;
    const sequence = ++readSequence.current;
    const task=(async()=>{
      try {
        const data = await readJson(`${endpoint}?runId=${encodeURIComponent(id)}${saved?'&view=saved':''}${includeIndex?'&includeIndex=1':''}`);
        if (!alive.current || currentId.current !== id || generation.current !== epoch || readSequence.current !== sequence) return;
        if (data.run?.id !== id) throw new RequestError("返回的任务与当前选择不一致，未覆盖当前页面。");
        applyRun(data.run as Run, restoreSettings);
        if(includeIndex&&data.index){indexSequence.current++;setIndex(data.index as RunIndex);}
        if(data.indexError)setError(`资料准备核对暂未成功：${data.indexError}。保存内容仍可查看，请刷新重试。`);
      } catch (reason) {
        if (alive.current && currentId.current === id && generation.current === epoch && readSequence.current === sequence) {
          // A failed explicit/live freshness check preserves reading but fails closed for actions/export.
          const previous=savedRuns.current.get(id);
          if(!saved&&previous&&!previous.legacyReadOnly){
            const failed={...previous,sourceCheckPending:false,blocked:true,preparation:{ready:false,error:messageOf(reason)}};
            savedRuns.current.set(id,failed);setRun(failed);
          }
          throw reason;
        }
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
    const cached=savedRuns.current.get(id);
    setRunId(id); setRun(null); setDetailLoading(Boolean(id&&!cached)); setError(""); setNotice("");
    if(cached)applyRun(cached,true);
    rememberUrl(id);
    // Reuse cached content immediately; a small saved-state read still notices work started elsewhere.
    try { if (id) await loadRun(id, true, true); }
    catch (reason) { if (alive.current && generation.current === epoch) setError(messageOf(reason)); }
    finally { if (alive.current && generation.current === epoch) {setDetailLoading(false);setLoading(false);} }
    if(id&&needsLiveRead(savedRuns.current.get(id))&&alive.current&&generation.current===epoch){
      try{await loadRun(id);}
      catch(reason){if(alive.current&&generation.current===epoch)setError(`状态同步暂未成功：${messageOf(reason)}。已显示的保存内容仍保留。`);}
    }
  }, [loadRun, rememberUrl,applyRun]);

  useEffect(() => {
    const life = ++lifecycle.current;
    alive.current = true;
    busy.current = false;
    generation.current++; readSequence.current++; indexSequence.current++;
    const seed=initialSnapshot?.episodeId===episodeId?initialSnapshot:undefined;
    currentId.current = seed?.run?.id??"";
    setIndex(seed?.index??null); setRun(seed?.run??null); setRunId(seed?.run?.id??""); setLoading(!seed?.index); setError(seed?.error??""); setPending(""); setNotice(""); setCreationUncertain(false);setDetailLoading(false);
    setSyncedAt(seed?.run?seed.savedAt:null);
    setSettings({ ...DEFAULT_SETTINGS }); setBudget({ maxCalls: DEFAULT_SETTINGS.maxCalls, maxTokens: DEFAULT_SETTINGS.maxTokens });
    if(seed?.index){
      if(seed.run){
        applyRun(seed.run,true);rememberUrl(seed.run.id);
        if(needsLiveRead(seed.run))void loadRun(seed.run.id).catch(reason=>{if(alive.current&&life===lifecycle.current)setError(`状态同步暂未成功：${messageOf(reason)}。已显示的保存内容仍保留。`);});
      }
    }else{
      const fromUrl=new URLSearchParams(window.location.search).get('runId');
      // A bound detail endpoint can authenticate a direct link independently of the list.
      if(fromUrl)void chooseRun(fromUrl);
      void loadIndex(true).then(async next=>{
        if(!next||!alive.current||life!==lifecycle.current)return;
        if(fromUrl&&!next.runs.some(item=>item.id===fromUrl))await chooseRun(next.runs[0]?.id??'');
        else if(!fromUrl&&!currentId.current&&next.runs[0])await chooseRun(next.runs[0].id);
      }).catch(reason=>{if(alive.current&&life===lifecycle.current)setError(messageOf(reason));})
        .finally(()=>{if(alive.current&&life===lifecycle.current)setLoading(false);});
    }
    return () => { alive.current = false; generation.current++; readSequence.current++; indexSequence.current++; };
  }, [episodeId,initialSnapshot,loadIndex,chooseRun,loadRun,applyRun,rememberUrl]);

  useEffect(() => {
    if (!runId || detailLoading) return;
    const pollNeeded=needsLiveRead(run);
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!busy.current && document.visibilityState !== "hidden") {
        try { await loadRun(runId); }
        catch (reason) { if (!cancelled && alive.current) setError(`状态同步暂未成功：${messageOf(reason)}。已显示的成果仍保留。`); }
      }
      if (!cancelled) timer = setTimeout(poll, run?.active ? 2000 : 8000);
    };
    if(pollNeeded)timer = setTimeout(poll, run?.active ? 1500 : 8000);
    // A completed/idle task only needs the current saved record, not source/CLI preflight.
    const focus = () => { if (!busy.current) void loadRun(runId,false,!pollNeeded,true).catch(reason => { if (alive.current) setError(messageOf(reason)); }); };
    window.addEventListener("focus", focus);
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener("focus", focus); };
  }, [initialSnapshot,runId, run?.active,run?.status,run?.production?.blocking,run?.production?.pendingRepair,run?.operations, detailLoading, loadRun]);

  const settingsReady = Boolean(index && !loading && !detailLoading && (!runId || run?.id === runId && !run.sourceCheckPending) && !creationUncertain && (index.preparation?.ready !== false || index.preparation.deferred));
  const canCreate = settingsReady && (run?.legacyReadOnly || !run?.active && !run?.operations.some(op => op.status === "running" || op.status === "unknown" && !op.cancelAcknowledgement?.acceptUnknownUsage))
    && !index?.runs.some(item => !item.legacyReadOnly && (item.active || ["running", "pausing", "unknown", "interrupted"].includes(item.status)));

  const act = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    if (busy.current || action === "create" && !canCreate) return null;
    if(action!=='create'&&(run?.id!==currentId.current||run?.legacyReadOnly)){setError('旧版任务仅可查看和导出；未提交变更。');return null;}
    const epoch = ++generation.current;
    readBarrier.current++;
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
      void loadIndex().catch(() => {});
      return next;
    } catch (reason) {
      if (!alive.current || generation.current !== epoch) return null;
      setError(messageOf(reason));
      if(reason instanceof RequestError&&['CLI_NOT_READY','RUNNER_TIMEOUT_CONFIG'].includes(reason.code||''))setIndex(previous=>previous?{...previous,runner:{ready:false,checked:true,message:reason.message,configurationError:reason.code==='RUNNER_TIMEOUT_CONFIG'}}:previous);
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
    readBarrier.current++;
    try {
      // Explicit freshness check reuses one prepared input, with no CLI process.
      if(!creationUncertain&&currentId.current){await loadRun(currentId.current,false,false,true);return;}
      const next=await loadIndex(false);
      if (!next || !alive.current) return;
      if (creationUncertain) {
        setCreationUncertain(false);
        if (next.runs[0]) await chooseRun(next.runs[0].id);
        setNotice("任务列表已核对，请查看已有记录后决定是否新建。");
      }
    } catch (reason) { if (alive.current) setError(messageOf(reason)); }
  }, [loadIndex, loadRun, chooseRun, creationUncertain]);

  return { endpoint, index, run, runId, settings, setSettings, budget, setBudget, loading, detailLoading, pending, error, notice, setNotice, setError, settingsReady, canCreate, creationUncertain, syncedAt, chooseRun, act, refresh };
}
