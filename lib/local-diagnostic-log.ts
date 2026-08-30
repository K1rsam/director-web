import { appendFile, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import {
  createDiagnosticEvent,
  toDiagnosticEnvelope,
  type DiagnosticEvent,
  type DiagnosticInput,
} from "@/lib/diagnostic-log";

/** 线下版本的本地诊断日志目录；可用 DIRECTOR_LOG_DIR 覆盖，便于支持和备份。 */
export function localDiagnosticLogDirectory(): string {
  if (process.env.DIRECTOR_LOG_DIR?.trim()) return process.env.DIRECTOR_LOG_DIR.trim();
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "DirectorWorkbench", "logs");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "director-workbench", "logs");
}

/** 只在本机保存详细日志；写盘失败不能覆盖原始任务错误。 */
export async function recordLocalDiagnosticLog(input: DiagnosticInput): Promise<DiagnosticEvent | null> {
  const event = createDiagnosticEvent(input);
  try {
    const directory = localDiagnosticLogDirectory();
    await mkdir(directory, { recursive: true });
    const file = join(directory, `diagnostics-${event.occurredAt.slice(0, 10)}.jsonl`);
    await appendFile(file, `${JSON.stringify(toDiagnosticEnvelope(event, "detailed"))}\n`, "utf8");
    return event;
  } catch {
    return null;
  }
}
