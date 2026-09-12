import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFoundationPrompt, FOUNDATION_TASK_CONTRACT, hashFoundationPrompt, loadFoundationSystemPrompt,
  type FoundationStageCode
} from "@/lib/project-foundation-contracts";

// Deterministic only: no environment file, provider, Prisma import or database access.
const root = process.cwd();
const stages = ["F1", "F2", "Q1"] as const;
let checks = 0;
let failures = 0;
function check(name: string, run: () => void) {
  try { run(); checks++; console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function activeSnapshot() {
  const systemPrompts = Object.fromEntries(stages.map((stage) => [stage, loadFoundationSystemPrompt(stage)]));
  const promptHashes = Object.fromEntries(stages.map((stage) => [stage, hashFoundationPrompt(systemPrompts[stage])]));
  const versionInputs = {
    sourceVersion: "synthetic-source-version",
    projectConditions: { title: "隔离合成资料", style: "未选择", aspectRatio: "9:16", unitMode: "未选择；本轮只整理文字资料，不排时", ruleVersion: "synthetic-rule-version" },
    presentationConditions: [], promptHashes, taskContract: FOUNDATION_TASK_CONTRACT
  };
  return {
    systemPrompts, promptHashes, taskContract: JSON.stringify(FOUNDATION_TASK_CONTRACT),
    f1Task: buildFoundationPrompt("F1", { ...versionInputs, scope: [1], source: "合成原文", prior: null }, "只处理第1集。"),
    versionInputs: JSON.stringify(versionInputs), inputVersion: hashFoundationPrompt(JSON.stringify(versionInputs)),
    activeSource: ["lib/project-foundation-contracts.ts", "lib/foundation-state.ts", "lib/project-foundation.ts"]
      .map((file) => readFileSync(path.join(root, file), "utf8"))
  };
}

async function main() {
  assert.ok(existsSync(path.join(root, "lib/foundation-calibration-profile.ts")), "calibration profile loader must exist before dynamic import");
  checks++;
  console.log("PASS calibration profile loader exists before dynamic import");
  const before = activeSnapshot();
  const { loadFoundationCalibrationProfile } = await import("@/lib/foundation-calibration-profile");
  const profiles = stages.map((stage) => loadFoundationCalibrationProfile(stage));

  for (const profile of profiles) check(`${profile.stageCode} composes exact base and method bytes in calibration-only mode`, () => {
    const base = loadFoundationSystemPrompt(profile.stageCode);
    const method = readFileSync(path.join(root, "prompts/foundation/calibration-v1", `${profile.stageCode}.md`), "utf8");
    assert.ok(method.trim());
    assert.deepEqual(Object.keys(profile).sort(), ["stageCode", "mode", "version", "basePromptHash", "methodHash", "systemPrompt"].sort());
    assert.equal(profile.mode, "CALIBRATION_ONLY");
    assert.equal(profile.basePromptHash, hashFoundationPrompt(base));
    assert.equal(profile.methodHash, hashFoundationPrompt(method));
    assert.equal(profile.systemPrompt, `${base}\n\n${method}`);
    assert.match(profile.version, /^CALIBRATION_V1:[a-f0-9]{64}$/);
  });

  check("unchanged profile files produce deterministic versions and values", () => {
    assert.deepEqual(stages.map((stage) => loadFoundationCalibrationProfile(stage)), profiles);
    assert.equal(new Set(profiles.map((profile) => profile.version)).size, 3);
  });

  check("F1 appendix explicitly distinguishes questions and uncorroborated self-claims from confirmation", () => {
    const method = readFileSync(path.join(root, "prompts/foundation/calibration-v1/F1.md"), "utf8");
    assert.match(method, /问句.*未获印证.*自称.*不能.*客观确认/, "F1 must explicitly preserve the question and uncorroborated self-claim boundary");
  });
  check("F2 appendix explicitly time-bounds provisional descriptions and preserves sourced increments", () => {
    const method = readFileSync(path.join(root, "prompts/foundation/calibration-v1/F2.md"), "utf8");
    assert.match(method, /阶段性后台描述.*尚未出现.*适用时点/, "F2 must time-bound provisional backend descriptions");
    assert.match(method, /后来.*有源状态.*描述增量.*分别保留/, "F2 must preserve later sourced states and description increments separately");
    assert.match(method, /不能把早期描述当永久事实/, "F2 must not turn early descriptions into permanent facts");
  });
  check("Q1 appendix documents unscoped F2 appearances and episode-only event filtering", () => {
    const method = readFileSync(path.join(root, "prompts/foundation/calibration-v1/Q1.md"), "utf8");
    assert.match(method, /有assetKey且无episode可定位[^。\n]*sourceRefs、appearances（当前已供批的全部事件）/, "Q1 must allow all supplied appearances without an episode filter");
    assert.match(method, /有assetKey和episode仅可定位appearances，按该集过滤/, "Q1 must restrict keyed episode targets to appearance filtering");
  });

  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "foundation-calibration-profile-"));
  const temporaryPrompts = path.join(temporaryRoot, "prompts/foundation");
  const temporaryMethods = path.join(temporaryPrompts, "calibration-v1");
  const base = loadFoundationSystemPrompt("F1");
  const method = readFileSync(path.join(root, "prompts/foundation/calibration-v1/F1.md"), "utf8");
  try {
    process.chdir(temporaryRoot);
    check("runtime role whitelist rejects invalid roles before any file lookup", () => {
      for (const invalid of ["", "F1.md", "f1", "../F1", "../../F1", "/F1", "__proto__", "constructor", "toString", undefined, null, 1, {}, { toString: () => "F1" }]) {
        assert.throws(() => loadFoundationCalibrationProfile(invalid as FoundationStageCode), /岗位|role/i);
      }
    });
    mkdirSync(temporaryMethods, { recursive: true });
    for (const stage of stages) {
      writeFileSync(path.join(temporaryPrompts, `${stage}.md`), base);
      writeFileSync(path.join(temporaryMethods, `${stage}.md`), method);
    }
    const equalContent = stages.map((stage) => loadFoundationCalibrationProfile(stage));
    check("stage identity is version-bound even when all base and method files match", () => {
      assert.equal(new Set(equalContent.map((profile) => profile.basePromptHash)).size, 1);
      assert.equal(new Set(equalContent.map((profile) => profile.methodHash)).size, 1);
      assert.equal(new Set(equalContent.map((profile) => profile.version)).size, 3);
    });
    check("changing only method bytes changes method hash and version without changing base", () => {
      writeFileSync(path.join(temporaryMethods, "F1.md"), `${method}\n`);
      const changed = loadFoundationCalibrationProfile("F1");
      assert.notEqual(changed.methodHash, equalContent[0].methodHash);
      assert.notEqual(changed.version, equalContent[0].version);
      assert.equal(changed.basePromptHash, equalContent[0].basePromptHash);
      assert.equal(changed.systemPrompt, `${base}\n\n${method}\n`);
      assert.deepEqual(loadFoundationCalibrationProfile("F2"), equalContent[1]);
    });
    check("changing only base bytes changes base hash and version without changing method", () => {
      const previous = loadFoundationCalibrationProfile("F1");
      writeFileSync(path.join(temporaryPrompts, "F1.md"), `${base}\n`);
      const changed = loadFoundationCalibrationProfile("F1");
      assert.notEqual(changed.basePromptHash, previous.basePromptHash);
      assert.notEqual(changed.version, previous.version);
      assert.equal(changed.methodHash, previous.methodHash);
      assert.equal(changed.systemPrompt, `${base}\n\n\n${method}\n`);
    });
    for (const stage of stages) check(`${stage} rejects an empty or missing method, never falling back to the base`, () => {
      const methodPath = path.join(temporaryMethods, `${stage}.md`);
      for (const empty of ["", " \r\n\t"]) {
        writeFileSync(methodPath, empty);
        assert.throws(() => loadFoundationCalibrationProfile(stage), /附录|method/i);
      }
      rmSync(methodPath);
      assert.throws(() => loadFoundationCalibrationProfile(stage), /ENOENT/);
    });
  } finally {
    process.chdir(root);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  check("active loader, complete F1 task, common contract and current version inputs remain unchanged", () => {
    assert.deepEqual(activeSnapshot(), before);
    for (const file of ["lib/foundation-state.ts", "lib/project-foundation.ts"]) {
      assert.doesNotMatch(readFileSync(path.join(root, file), "utf8"), /foundation-calibration-profile|loadFoundationCalibrationProfile|CALIBRATION_V1/);
    }
  });
  console.log(`foundation calibration profile verification: ${checks} passed, ${failures} failed (deterministic only; temporary copies only)`);
  if (failures) process.exitCode = 1;
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
