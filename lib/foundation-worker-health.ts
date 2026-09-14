import { foundationWorkerCommand, matchesFoundationWorker, type FoundationWorkerIdentity } from './foundation-worker-process';
import path from 'node:path';

export type FoundationWorkerHealth = 'ALIVE' | 'GONE' | 'UNKNOWN' | 'STARTING';
type Task = FoundationWorkerIdentity & { status: string; updatedAt?: string | Date; createdAt?: string | Date };
type Probe = { exists: 'YES' | 'NO' | 'UNKNOWN'; command: string | null };
export const FOUNDATION_WORKER_START_GRACE_MS = 30_000;

async function probeWorker(pid: number): Promise<Probe> {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { exists: 'NO', command: null };
    return { exists: 'UNKNOWN', command: null };
  }
  return { exists: 'YES', command: await foundationWorkerCommand(pid) };
}

/** UNKNOWN is deliberately not recoverable: losing observability must not buy another AI call. */
export async function assessFoundationWorkerHealth(task: Task, options: {
  now?: number; graceMs?: number; script?: string; platform?: NodeJS.Platform;
  probe?: (pid: number) => Promise<Probe>;
} = {}): Promise<FoundationWorkerHealth> {
  const pid = task.workerPid;
  if (pid == null) {
    if (task.status !== 'QUEUED') return 'UNKNOWN';
    const timestamp = task.updatedAt ?? task.createdAt;
    const updated = timestamp == null ? NaN : new Date(timestamp).getTime();
    if (!Number.isFinite(updated)) return 'UNKNOWN';
    return (options.now ?? Date.now()) - updated >= (options.graceMs ?? FOUNDATION_WORKER_START_GRACE_MS) ? 'GONE' : 'STARTING';
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'UNKNOWN';
  // The delivery executor also supports an in-process runner.
  if (pid === process.pid) return 'ALIVE';
  const probe = await (options.probe ?? probeWorker)(pid);
  if (probe.exists === 'NO') return 'GONE';
  if (probe.exists === 'UNKNOWN' || !probe.command || !task.workerToken) return 'UNKNOWN';
  const script = options.script ?? path.resolve('scripts/run-foundation-delivery.ts');
  if (matchesFoundationWorker(probe.command, task, script)) return 'ALIVE';
  // ps on Unix flattens argv without quoting, so a path containing spaces cannot
  // be safely reconstructed. Do not classify or terminate an ambiguous process.
  if ((options.platform ?? process.platform) !== 'win32' && /\s/.test(script)) return 'UNKNOWN';
  return 'GONE';
}
