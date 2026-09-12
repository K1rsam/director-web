import { parseSceneBatch } from "@/lib/source-parser";

export type ScriptSceneDraft = {
  sceneKey: string;
  sortOrder: number;
  heading: string;
  location: string | null;
  interiorExterior: string | null;
  timeOfDay: string | null;
  weather: string | null;
  timeLayer: string;
  sourceText: string;
  metadata: Record<string, unknown>;
};

/** Compatibility API. Bulk callers should use parseSceneBatch once per project. */
export function extractScriptScenes(episodeNumber: number, raw: string): ScriptSceneDraft[] {
  return parseSceneBatch([{ number: episodeNumber, content: raw }])[0]?.scenes ?? [];
}
