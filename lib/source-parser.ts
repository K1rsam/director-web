import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ImportedEpisode, SourceSection, SourceStructure } from "@/lib/import-script";
import type { ScriptSceneDraft } from "@/lib/scene-structure";

export type SourceBoundaryPlan = {
  assignments?: { sectionKey: string; kind: "EPISODE" | "BACKGROUND"; episodeNumber?: number }[];
  boundaries?: { start: number; kind: "EPISODE" | "BACKGROUND"; episodeNumber?: number }[];
};
type ReadIssue = { code: string; message: string };
type SourceResult = { episodes: ImportedEpisode[]; sourceStructure: SourceStructure; boundaryNotes: string[] };
export type SceneResult = { episodeNumber: number; scenes: ScriptSceneDraft[] };
export type SceneParserVersion = "SCENE_PARSER_V1" | "SCENE_PARSER_V2";
export const SCENE_PARSER_VERSION: SceneParserVersion = "SCENE_PARSER_V2";
/** A plan slices one existing source scene; sourceHash is SHA-256 of the full raw episode. */
export type SceneSplitPlan = {
  episode: number;
  sourceHash: string;
  sceneKey: string;
  cuts: { startLine: number; anchor: string; location?: string; interiorExterior?: string; timeOfDay?: string; timeLayer?: string }[];
};

function invoke(operation: "parse_source" | "parse_scenes", payload: Record<string, unknown>) {
  const parser = path.join(process.cwd(), "scripts/source_parser.py");
  // One complete JSON frame. Python can start without waiting for the pipe's
  // eventual EOF, which is not a reliable completion signal on every runtime.
  const encoded = JSON.stringify({ operation, ...payload }) + '\n';
  let stdout: string;
  try {
    stdout = execFileSync(/*turbopackIgnore: true*/ process.env.PYTHON ?? "python3", [parser], { input: encoded, encoding: "utf8", windowsHide: true, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: Math.max(8 * 1024 * 1024, Buffer.byteLength(encoded, "utf8") * 12), stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    const output = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
    try {
      const response = JSON.parse(output) as { error?: { message?: string } };
      throw new Error(`固定来源解析器拒绝输入：${response.error?.message ?? "未知错误"}`);
    } catch (parseError) {
      if (parseError instanceof Error && parseError.message.startsWith("固定来源解析器拒绝输入")) throw parseError;
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw new Error(`固定来源解析器执行失败：${detail}`);
    }
  }
  let response: { ok: boolean; value?: unknown; error?: { message?: string } };
  try { response = JSON.parse(stdout); } catch { throw new Error("固定来源解析器返回了无效数据。"); }
  if (!response.ok) throw new Error(`固定来源解析器拒绝输入：${response.error?.message ?? "未知错误"}`);
  return response.value;
}

export function parseSourceText(text: string, readIssues: ReadIssue[] = [], plan?: SourceBoundaryPlan): SourceResult {
  return invoke("parse_source", { text, readIssues, plan }) as SourceResult;
}

export function parseSceneBatch(episodes: { number: number; content: string }[], plans: SceneSplitPlan[] = [], options: { versions?: Record<number, SceneParserVersion> } = {}): SceneResult[] {
  if (Object.values(options.versions ?? {}).some(version => version !== "SCENE_PARSER_V1" && version !== "SCENE_PARSER_V2")) throw new Error("unknown scene parser version");
  const sceneParserVersions = Object.fromEntries(episodes.map(episode => [episode.number, options.versions?.[episode.number] ?? SCENE_PARSER_VERSION]));
  return invoke("parse_scenes", { episodes, plans, sceneParserVersions }) as SceneResult[];
}
