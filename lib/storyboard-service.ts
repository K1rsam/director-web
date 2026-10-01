import "server-only";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { readLightEpisodeFoundation } from "@/lib/light-foundation-reader";

// Native Node owns the ESM engine and its rule files; do not bundle a second copy into React.
const nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
const runtimePath = path.join(process.cwd(), "runtime/storyboard-v4");
const input = nativeRequire(path.join(runtimePath, "input.mjs"));
const sourceContext = nativeRequire(path.join(runtimePath, "source-context.mjs"));
export const storyboardHttp = nativeRequire(path.join(runtimePath, "http.mjs"));
const executable = process.env.DIRECTOR_CODEX_CLI || path.join(os.homedir(), ".local/bin/codex");
// Runtime user data is deliberately outside the build tracing graph.
export const storyboardDataRoot = path.resolve(/*turbopackIgnore: true*/ process.env.DIRECTOR_STORYBOARD_DATA_DIR || path.join(process.cwd(), ".storyboard-v4"));
type RecordValue = Record<string, any>;
type Service = ReturnType<typeof makeService>;
const state = globalThis as unknown as { storyboardV4?: Service; storyboardV4Status?: { at: number; value: Promise<{ ready: boolean; message: string }> } };

export async function loadStoryboardInput(episode: RecordValue, notes = "") {
  const independentSource = await sourceContext.readEpisodeSourceContext(storyboardDataRoot, episode);
  if (independentSource) return input.makeEpisodeInput({ episode, project: episode.project, notes, independentSource });
  let handoff;
  try { handoff = await readLightEpisodeFoundation(episode.projectId, episode.number); }
  catch { throw Object.assign(new Error("前情资料暂无法读取，已有任务和付费稿保留，请稍后重试或先检查全剧资料。"), { status: 503, code: "CONTEXT_UNAVAILABLE" }); }
  return input.makeEpisodeInput({ episode, project: episode.project, handoff, notes });
}

function makeService() {
  const { createCoordinator } = nativeRequire(path.join(runtimePath, "coordinator.mjs"));
  return createCoordinator({ dataRoot: storyboardDataRoot, executable, maxConcurrent: 4,
    beforeExecute: async (binding: RecordValue, { signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      const episode = await prisma.episode.findFirst({ where: { id: binding.episodeId, projectId: binding.projectId }, include: { project: true } });
      signal.throwIfAborted();
      return Boolean(episode && (await loadStoryboardInput(episode)).sourceVersion === binding.sourceVersion);
    }
  });
}
export function storyboardService() { return state.storyboardV4 ??= makeService(); }

export async function storyboardRunnerStatus() {
  if (!state.storyboardV4Status || Date.now() - state.storyboardV4Status.at > 60000) {
    const value = (async () => {
      try {
        await promisify(execFile)(executable, ["--version"], { timeout: 10000, maxBuffer: 32768 });
        await promisify(execFile)(executable, ["login", "status"], { timeout: 10000, maxBuffer: 32768 });
        return { ready: true, message: "本机CLI已登录；新分镜固定使用GPT-6.1 Sol中档，不调用旧岗位。" };
      } catch { return { ready: false, message: "本机Codex CLI未就绪，请先在终端安装并登录；未调用生成模型。" }; }
    })();
    state.storyboardV4Status = { at: Date.now(), value };
  }
  return state.storyboardV4Status.value;
}

export async function createStoryboardRun(episode: RecordValue, command: RecordValue) {
  return storyboardService().withPreparation(async () => {
  const prepared = await loadStoryboardInput(episode, command.notes || "");
  if (prepared.source.diagnostics?.length) {
    const diagnostics = prepared.source.diagnostics.map((problem: RecordValue) => {
      const row = prepared.source.sourceRows.find((item: RecordValue) => item.id === problem.rowId);
      return { rowId: problem.rowId, line: row?.line, sourceFileLine: row?.sourceFileLine, text: row?.text || "", reason: problem.reason };
    });
    throw Object.assign(new Error("源材料有未处理歧义；任务未创建，尚未调用模型。请核对下方原文位置与格式。"), { status: 409, code: "SOURCE_DIAGNOSTICS", creationOutcome: "NOT_CREATED", diagnostics });
  }
  const { measureVoiceReference } = nativeRequire(path.join(runtimePath, "voice.mjs"));
  const voiceReference = await measureVoiceReference(prepared.source, { cacheRoot: path.join(storyboardDataRoot, "voice-cache") });
  prepared.source.context.sourceWarnings.push(...voiceReference.warnings);
  return storyboardService().create({ source: prepared.source, title: `第${episode.number}集 · ${episode.title || "分镜任务"}`, voiceReference,
    binding: { projectId: episode.projectId, episodeId: episode.id, sourceVersion: prepared.sourceVersion },
    settings: { model: "gpt-6.1-sol", reasoning: "medium", maxUnitSeconds: command.settings?.maxUnitSeconds ?? 30, maxUnits: null,
      fantasyMode: command.settings?.fantasyMode ?? "recommended", visualStyle: prepared.visualStyle },
    budget: { maxCalls: command.maxCalls ?? 32, maxTokens: command.maxTokens ?? 300000 }
  });
  });
}

export async function storyboardRunView(run: RecordValue, episode: RecordValue) {
  storyboardHttp.assertEpisodeBinding(run, episode);
  const current = await loadStoryboardInput(episode);
  const service = storyboardService();
  const [cancellations, executions] = await Promise.all([service.cancellationStatus(run.id), service.executionStatus?.(run.id) ?? []]);
  return input.publicRun(run, { active: service.active(run.id), scheduling: service.scheduling(run.id), sourceStale: current.sourceVersion !== run.web.binding.sourceVersion || run.web.sourceStale, cancellations, executions });
}

export function storyboardFailure(failure: unknown) {
  const e = failure as { code?: string; message?: string; status?: number; creationOutcome?: string; diagnostics?: RecordValue[] };
  const status = e.status || (e.code === "ENOENT" ? 404 : ["EACCES", "EPERM", "EIO"].includes(e.code || "") ? 500 : 409);
  const sourceRejection = e.code === "SOURCE_DIAGNOSTICS" && e.creationOutcome === "NOT_CREATED";
  const diagnostics = sourceRejection && Array.isArray(e.diagnostics) ? e.diagnostics.map(({ rowId, line, sourceFileLine, text, reason }) => ({
    rowId: typeof rowId === "string" ? rowId : "", ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}), ...(Number.isSafeInteger(sourceFileLine) && sourceFileLine > 0 ? { sourceFileLine } : {}),
    text: typeof text === "string" ? text.length > 600 ? `${text.slice(0, 600)}…` : text : "", reason: typeof reason === "string" ? reason : "原文格式需要核对"
  })) : [];
  return { status, body: { code: e.code || "STORYBOARD_ERROR", error: status === 500 ? "本机保存或运行环境异常，已有原稿保留。" : (e.message || "操作暂不能完成"),
    ...(sourceRejection ? { creationOutcome: "NOT_CREATED", diagnostics } : {}) } };
}
