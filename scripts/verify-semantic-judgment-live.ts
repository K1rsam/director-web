/** Explicit opt-in: one synthetic request only; never reads a project, database or source file. */
import { createJevProvider, type SemanticJudgmentRequest } from "../lib/semantic-judgment";

async function main() {
  if (!process.argv.includes("--synthetic-once")) {
    console.log("SKIP: pass --synthetic-once to allow one synthetic Jev request.");
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey?.trim()) {
    console.log("SKIP: server-side TYPESAFE_API_KEY unavailable; no request sent.");
    return;
  }
  const request: SemanticJudgmentRequest = {
    scope: { accountId: "synthetic-qa", projectId: "synthetic-qa", sourceVersion: "synthetic-two-lines-v1", questionVersion: "format-smoke-v1" },
    state: { lines: [{ id: "L1", text: "甲（低声）" }, { id: "L2", text: "他说：“别拆：等我回来。”" }] },
    questions: {
      block_kind: { type: "choice", instructions: "根据给定剧本上下文，lines[1]最适合归入哪种正文类型？保留文字，不改写。", criteria: {
        dialogue: "角色实际说出的台词，包含转述也仍属于台词。", action: "发生但并非说出的身体行动。", annotation: "作者给制作方的辅助说明，不是角色发言。", unknown: "现有上下文无法判断。",
      } },
      follows_speaker_cue: { type: "noul", instructions: "lines[1]是否承接lines[0]所标记的角色发言？", criteria: {
        true: "前一行给出说者/语气，后一行是其发言。", false: "后一行另起动作、备注或不同说者，不能接到前一行发言。",
      } },
    },
  };
  const started = Date.now();
  const result = await createJevProvider({ apiKey, timeoutMs: 15000 }).evaluate(request);
  console.log(JSON.stringify({
    scope: "one synthetic transport smoke test; not domain accuracy calibration",
    requestAttempts: 1, actualProjectReads: 0, result: result.status, reason: result.reason,
    model: result.model, answers: result.answers, usage: result.usage, elapsedMs: Date.now() - started,
    acceptedForProduction: false,
  }, null, 2));
  if (result.status === "failed" || result.status === "unavailable" || !result.answers) process.exitCode = 1;
}
main().catch(() => { console.error("Synthetic smoke test could not complete; no retry performed."); process.exitCode = 1; });
