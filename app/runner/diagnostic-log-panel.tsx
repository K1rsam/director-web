"use client";

import { useEffect, useMemo, useState } from "react";

import type { RunnerStatusDevice } from "./codex-status-panel";

type DiagnosticEventView = {
  occurredAt: string;
  severity: "warning" | "error";
  kind: string;
  code: string;
  operation: string;
  message: string;
  jobId?: string;
  taskKind?: string;
  details?: { stack?: string; stdoutTail?: string; stderrTail?: string };
};

type DiagnosticLogView = {
  id: string;
  eventId: string;
  runnerTokenId: string;
  deviceName: string;
  scope: "minimal" | "detailed";
  occurredAt: string;
  receivedAt: string;
  event: DiagnosticEventView;
};

type UploadRequestView = {
  id: string;
  runnerTokenId: string;
  deviceName: string;
  status: "requested" | "uploaded" | "expired";
  createdAt: string;
  completedAt: string | null;
};

const KIND_LABELS: Record<string, string> = {
  runner_start_failed: "Runner 启动失败",
  runner_connection_failed: "连接失败",
  task_failed: "任务失败",
  task_timeout: "任务超时",
  launcher_download_failed: "启动器下载失败",
};

export function DiagnosticLogPanel({ devices }: { devices: RunnerStatusDevice[] }) {
  const [logs, setLogs] = useState<DiagnosticLogView[]>([]);
  const [requests, setRequests] = useState<UploadRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const activeDevices = devices.filter((device) => !device.revoked);
  const latestRequests = useMemo(() => {
    const result = new Map<string, UploadRequestView>();
    for (const request of requests) {
      if (!result.has(request.runnerTokenId)) result.set(request.runnerTokenId, request);
    }
    return result;
  }, [requests]);

  async function loadDiagnostics() {
    try {
      const response = await fetch("/api/runner/diagnostics", { cache: "no-store" });
      if (!response.ok) throw new Error("诊断日志暂时无法读取。");
      const body = await response.json() as { logs?: unknown; requests?: unknown };
      setLogs(Array.isArray(body.logs) ? body.logs : []);
      setRequests(Array.isArray(body.requests) ? body.requests : []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "诊断日志暂时无法读取。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDiagnostics();
    const timer = window.setInterval(() => void loadDiagnostics(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  async function requestDetailedUpload(runnerTokenId: string) {
    setRequesting(runnerTokenId);
    setMessage("");
    try {
      const response = await fetch("/api/runner/diagnostics/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerTokenId }),
      });
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "详细诊断请求失败。");
      setMessage("已请求详细诊断；请保持对应设备的 Runner 窗口打开。上传完成后本页会自动刷新。");
      await loadDiagnostics();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "详细诊断请求失败。");
    } finally {
      setRequesting(null);
    }
  }

  return (
    <section className="runnerStatusCard studioCard runnerDiagnosticsCard" aria-label="Runner 诊断日志">
      <header className="runnerStatusHeader">
        <div>
          <p className="sectionEyebrow">DIAGNOSTIC LOGS</p>
          <h2>设备诊断日志</h2>
          <p>连接失败、任务失败和启动失败会自动上传最小诊断；堆栈和命令输出只有点击“上传详细诊断”后才会上传。</p>
        </div>
        <span className={`runnerStatusSyncState ${logs.length ? "synced" : ""}`}>
          {loading ? "读取中" : `${logs.length} 条记录`}
        </span>
      </header>

      {activeDevices.length ? (
        <div className="runnerDiagnosticDevices">
          {activeDevices.map((device) => {
            const request = latestRequests.get(device.id);
            const waiting = request?.status === "requested";
            return (
              <div key={device.id} className="runnerDiagnosticDevice">
                <div>
                  <strong>{device.name}</strong>
                  <small>{waiting ? "等待设备上传详细诊断" : request?.status === "uploaded" ? "最近一次详细诊断已上传" : "可请求这台设备的详细记录"}</small>
                </div>
                <button
                  className="quietButton runnerStatusRefresh"
                  type="button"
                  disabled={requesting === device.id || waiting}
                  onClick={() => void requestDetailedUpload(device.id)}
                >
                  {requesting === device.id ? "请求中…" : waiting ? "等待上传" : "上传详细诊断"}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="runnerStatusEmpty">尚未生成可用的 CLI 设备启动器。</p>
      )}

      {message ? <p className="runnerDiagnosticMessage">{message}</p> : null}

      {logs.length ? (
        <div className="runnerDiagnosticLogList">
          {logs.map((log) => (
            <article key={log.id} className="runnerDiagnosticLogItem">
              <header>
                <div>
                  <strong>{KIND_LABELS[log.event.kind] ?? log.event.kind}</strong>
                  <small>{log.deviceName} · {formatDate(log.event.occurredAt)}</small>
                </div>
                <span className={`runnerDiagnosticBadge ${log.scope === "detailed" ? "detailed" : "minimal"}`}>
                  {log.scope === "detailed" ? "详细" : "最小"}
                </span>
              </header>
              <p>{log.event.message}</p>
              <small className="runnerDiagnosticMeta">{log.event.code} · {log.event.operation}{log.event.jobId ? ` · 任务 ${log.event.jobId}` : ""}</small>
              {log.scope === "detailed" && log.event.details ? (
                <details>
                  <summary>查看堆栈与命令输出</summary>
                  <pre>{formatDetails(log.event.details)}</pre>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="runnerStatusEmpty">暂时没有失败记录；发生问题后，最小诊断会显示在这里。</p>
      )}
    </section>
  );
}

function formatDetails(details: NonNullable<DiagnosticEventView["details"]>): string {
  return [
    details.stack ? `STACK\n${details.stack}` : "",
    details.stdoutTail ? `STDOUT\n${details.stdoutTail}` : "",
    details.stderrTail ? `STDERR\n${details.stderrTail}` : "",
  ].filter(Boolean).join("\n\n");
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

