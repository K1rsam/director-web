import { readFileSync } from "node:fs";
import path from "node:path";
import { hashFoundationPrompt, loadFoundationSystemPrompt, type FoundationStageCode } from "@/lib/project-foundation-contracts";

export type FoundationCalibrationProfile = {
  stageCode: FoundationStageCode;
  mode: "CALIBRATION_ONLY";
  version: string;
  basePromptHash: string;
  methodHash: string;
  systemPrompt: string;
};

const methodFiles: Record<FoundationStageCode, string> = { F1: "F1.md", F2: "F2.md", Q1: "Q1.md" };

/** Explicit isolated use only; the active foundation loader and input version stay unchanged. */
export function loadFoundationCalibrationProfile(stageCode: FoundationStageCode): FoundationCalibrationProfile {
  if (stageCode !== "F1" && stageCode !== "F2" && stageCode !== "Q1") throw new Error("无效校准岗位；仅允许F1、F2、Q1。");
  const base = loadFoundationSystemPrompt(stageCode);
  const method = readFileSync(path.join(process.cwd(), "prompts", "foundation", "calibration-v1", methodFiles[stageCode]), "utf8");
  if (!method.trim()) throw new Error(`校准方法附录${stageCode}为空。`);
  const basePromptHash = hashFoundationPrompt(base);
  const methodHash = hashFoundationPrompt(method);
  return {
    stageCode, mode: "CALIBRATION_ONLY",
    version: `CALIBRATION_V1:${hashFoundationPrompt(JSON.stringify({ stageCode, basePromptHash, methodHash }))}`,
    basePromptHash, methodHash, systemPrompt: `${base}\n\n${method}`
  };
}
