import { buildRoleProgress, deriveActivePipelineScope, parseJsonRecord, ROLE_STAGES } from "../lib/studio";

const parsed = parseJsonRecord('{"scene":"森林"}');
if (parsed.scene !== "森林") throw new Error("JSON parse failed");
if (Object.keys(parseJsonRecord("not-json")).length !== 0) throw new Error("Invalid JSON must return an empty object");

const progress = buildRoleProgress([
  {
    stageCode: "E0",
    status: "SUCCEEDED",
    model: "gpt-5.6-terra",
    durationMs: 5200,
    createdAt: new Date("2026-08-14T07:59:00Z")
  },
  {
    stageCode: "E2",
    status: "SUCCEEDED",
    model: "gpt-5.6-terra",
    durationMs: 9300,
    createdAt: new Date("2026-08-14T08:00:00Z")
  },
  {
    stageCode: "E1",
    status: "RUNNING",
    model: "gpt-5.6-sol",
    durationMs: null,
    createdAt: new Date("2026-08-14T08:01:00Z")
  }
]);

if (progress.length !== ROLE_STAGES.length || ROLE_STAGES.length !== 6) {
  throw new Error("E0-E5 progress must always contain six stages");
}
if (progress[0].code !== "E0" || progress[0].status !== "已完成") throw new Error("E0 completed state missing");
if (progress[1].code !== "E1" || progress[1].status !== "进行中") throw new Error("E1 running state missing");
if (progress[2].code !== "E2" || progress[2].status !== "已完成" || progress[2].duration !== "9.3秒") {
  throw new Error("E2 completed state missing");
}
if (progress[3].status !== "未开始") throw new Error("Empty role must be pending");

const singleScope = deriveActivePipelineScope([
  { stageCode: "E0", status: "RUNNING", inputSummary: JSON.stringify({ batchToken: "single", singleStage: true }), createdAt: new Date("2026-08-21T10:00:00Z") }
]);
if (singleScope?.kind !== "single" || singleScope.label !== "正在运行 E0" || singleScope.stages.join(",") !== "E0") {
  throw new Error("Single-stage execution must identify only its actual role");
}

const fullScope = deriveActivePipelineScope(ROLE_STAGES.map(([stageCode], index) => ({
  stageCode,
  status: index === 0 ? "RUNNING" : "QUEUED",
  inputSummary: JSON.stringify({ batchToken: "full" }),
  createdAt: new Date(`2026-08-21T10:00:0${index}Z`)
})));
if (fullScope?.kind !== "full" || fullScope.label !== "正在生成 E0–E5" || fullScope.stages.length !== 6) {
  throw new Error("Full execution must identify the complete E0-E5 pipeline");
}

const repairScope = deriveActivePipelineScope([
  { stageCode: "E3", status: "RUNNING", inputSummary: JSON.stringify({ batchToken: "repair", repairPipeline: true }), createdAt: new Date("2026-08-21T10:00:00Z") },
  { stageCode: "E5", status: "QUEUED", inputSummary: JSON.stringify({ batchToken: "repair", repairPipeline: true }), createdAt: new Date("2026-08-21T10:00:01Z") }
]);
if (repairScope?.kind !== "repair" || repairScope.label !== "正在修复") {
  throw new Error("Repair execution must list only the selected repair roles");
}

if (deriveActivePipelineScope([{ stageCode: "E1", status: "SUCCEEDED", inputSummary: "{}", createdAt: new Date() }]) !== null) {
  throw new Error("Completed runs must not create an active pipeline scope");
}

console.log("studio view verification passed");
