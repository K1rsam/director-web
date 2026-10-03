import assert from "node:assert/strict";
import { deriveView } from "../app/projects/[projectId]/episodes/[episodeId]/storyboard/view-state";
import * as presentation from "../app/projects/[projectId]/episodes/[episodeId]/storyboard/view-state";
import type { Run } from "../app/projects/[projectId]/episodes/[episodeId]/storyboard/types";

const base: Run = { id: "fixture", status: "created", createdAt: "2026-09-27T01:00:00Z", active: false, sourceStale: false,
  settings: { maxUnitSeconds: 30, fantasyMode: "recommended" }, sourceRows: [], choice: { mode: "recommended" },
  adopted: [], operations: [], candidates: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, complete: true },
  budget: { maxCalls: 32, maxTokens: 300000, maxRepairs: 2 } };
const ready: Run = { ...base, status: "text_ready_for_review", assembly: { text: "完整原稿", errors: [], warnings: [] } };
assert.equal(deriveView(ready, true).canRun, false, "A completed draft must not offer a redundant paid continue action");
assert.equal(deriveView({ ...base, status: "unknown" }, true).canChangeChoice, false, "Unknown requests must be resolved before choice mutations");
assert.equal(deriveView({ ...base, active: true, status: "running" }, true).canPause, true);
assert.equal(deriveView({ ...base, active: true, status: "pausing" }, true).canPause, false);
assert.equal(deriveView({ ...base, sourceStale: true }, true).canRun, false);
assert.equal(deriveView(base, false).canRun, false);
assert.equal(deriveView({ ...base, budget: { ...base.budget, maxCalls: 0 } }, true).canRun, false);
assert.equal(deriveView({ ...base, usage: { ...base.usage, totalTokens: 300000 } }, true).canRun, false, "A reached token stop line must not look runnable");
assert.equal(deriveView({ ...base, operations: [{ attemptId: "old", stage: "plan", packageIds: [], status: "running", createdAt: base.createdAt }] }, true).canRun, false);
assert.equal(deriveView({ ...base, status: "interrupted", operations: [{ attemptId: "old", stage: "plan", packageIds: [], status: "running", createdAt: base.createdAt }] }, true).current.length, 0, "Unconfirmed historical running records must not light up a live stage");
assert.equal(deriveView(base, true).canRun, true);
const checking:Run={...base,sourceCheckPending:true,preparation:{ready:false,checking:true}};
assert.equal(deriveView(checking,true).canRun,false,'a readable saved snapshot is not freshness approval');
assert.equal(deriveView({...ready,sourceCheckPending:true},true).downloadable,false);
assert.equal(deriveView(base,true).nextLabel,'连续完成本集');
const localReceipt:Run={...base,active:true,status:'running',operations:[{attemptId:'receipt-only',stage:'plan',packageIds:[],createdAt:base.createdAt,status:'running',localPhase:'executing',feedbackRepair:true}]};
assert.match(deriveView(localReceipt,true).title,/局部回执修复/);
assert.match(deriveView(localReceipt,true).description,/不重写/);
const waitingPlan: Run = {...base,active:true,status:'running',operations:[{attemptId:'waiting-plan',stage:'plan',packageIds:[],status:'running',localPhase:'executing',createdAt:base.createdAt,execution:{phase:'waiting',startedAt:'2026-09-27T01:00:03Z',lastProgressAt:null}}]};
const waitingView = deriveView(waitingPlan,true);
assert.match(waitingView.title,/情绪统筹.*等待首个输出/,'waiting must retain the actual production step');
assert.match(waitingView.description,/CLI.*已启动.*等待.*输出/,'explain what the observed waiting means');
assert.doesNotMatch(waitingView.description,/模型正在生成|远端已受理/,'lifecycle events are not proof of remote generation');
assert.equal(waitingView.current.length,0,'waiting is not a confirmed generation event');
assert.equal(waitingView.currentStartedAt,'2026-09-27T01:00:03Z','waiting time must not disappear from the live display');
assert.equal(deriveView({...waitingPlan,active:false,status:'interrupted'},true).currentStartedAt,undefined,'old unresolved requests do not start a live clock');
console.log("PASS: stage3 paid-action, unknown, stale, pause and budget guards");

const phaseSteps = (presentation as unknown as { derivePhaseSteps?: (run: Run | null, runnerReady?: boolean) => { id: string; state: string; label: string; detail:string; isCurrent:boolean }[] }).derivePhaseSteps;
assert.equal(typeof phaseSteps, "function", "The step rail needs an explicit state projection instead of treating every inactive step as pending");
const phases = (run: Run | null) => phaseSteps!(run).map(step => [step.id, step.state, step.label]);
assert.deepEqual(phases(null).map(item => item[1]), ["idle", "idle", "idle"]);
assert.deepEqual(phases(checking)[0],['plan','waiting','核对资料更新'],'loading checks must not look like broken source or running AI');
const planned: Run = { ...base, status: "planned", plan: { emotionArc: "", workPackages: [{ id: "P1", sourceRefs: [], emotionContract: { subject: "甲", contextTone: "", audienceEffect: "", change: "", landing: "", retain: [] }, dependsOn: [] }], provisionalUnits: [], fantasyCandidates: [] } };
assert.equal(phaseSteps!(waitingPlan)[0].isCurrent,true,'an executing step remains current while waiting for output');
assert.match(phaseSteps!(waitingPlan)[0].detail,/等待首个输出/);
assert.doesNotMatch(phaseSteps!(waitingPlan)[0].detail,/等待分析/,'already-started analysis must not look unstarted');
const finishing:Run={...planned,active:true,status:'running',operations:[{...waitingPlan.operations[0],stage:'finish'}]};
assert.equal(deriveView(finishing,true).stage,'finish','actual local repair/finish operations outrank saved coverage inference');
assert.equal(phaseSteps!(finishing).filter(step=>step.isCurrent).map(step=>step.id).join(','),'finish');
assert.match(deriveView(finishing,true).title,/统一整编.*等待首个输出/);
assert.match(deriveView({...finishing,production:{boundary:null,materialNeeds:[],sharedBudget:null,pendingRepair:{packageIds:['P1'],reason:'CONSUMED_MATERIAL',changedKeys:[]},blocking:false,chainComplete:false,chainMode:'SINGLE'}},true).title,/统一整编.*等待首个输出/,'a running local check must not be displayed as inactive material waiting');
assert.match(deriveView({...waitingPlan,operations:[{...waitingPlan.operations[0],execution:{...waitingPlan.operations[0].execution!,lastProgressAt:base.createdAt}}]},true).activityLabel,/等待后续输出/,'previous progress must not be mislabeled as waiting for its first output');
assert.match(deriveView({...waitingPlan,status:'pausing'},true).description,/保存.*暂停.*不会继续/,'a requested pause must not promise automatic continuation');
assert.equal(phaseSteps!({...waitingPlan,legacyReadOnly:true})[0].isCurrent,false,'read-only history cannot be a current production step');
const timeout: Run = { ...planned, status: "unknown", operations: [{ attemptId: "timeout", stage: "author", packageIds: ["P1"], status: "unknown", createdAt: base.createdAt, error: { code: "TIMEOUT", message: "Request timed out" } }] };
assert.deepEqual(phases(timeout), [["plan", "complete", "已完成"], ["author", "attention", "超时待核对"], ["finish", "idle", "待推进"]]);
const acknowledged: Run = { ...timeout, status: "paused", operations: timeout.operations.map(operation => ({ ...operation, cancelAcknowledgement: { at: base.createdAt, acceptUnknownUsage: true } })) };
assert.equal(phases(acknowledged)[1][1], "paused");
assert.equal(deriveView(acknowledged, true).canRun, true, "Acknowledged unknown evidence permits a separate explicit continuation, not automatic execution");
assert.equal(phases({ ...planned, active: true, status: "running", operations: [{ attemptId: "active", stage: "author", packageIds: ["P1"], status: "running", localPhase: "executing", createdAt: base.createdAt }] })[1][1], "running");
for (const localPhase of ["queued", "preparing", null] as const) {
  const queued: Run = { ...planned, active: true, status: "running", operations: [{ attemptId: "queued", stage: "author", packageIds: ["P1"], status: "running", localPhase, createdAt: base.createdAt }] };
  assert.equal(phases(queued)[1][1], "waiting", "Active coordination does not prove the request has entered the local executor");
  assert.equal(deriveView(queued, true).current.length, 0);
  if (localPhase === "queued") assert.match(deriveView(queued, true).title, /排队/);
}
assert.equal(phases({ ...planned, status: "interrupted", operations: [{ attemptId: "old-active", stage: "author", packageIds: ["P1"], status: "running", createdAt: base.createdAt }] })[1][1], "attention");
assert.equal(phases({ ...planned, selection: { status: "awaiting_confirmation", selectedIds: [], fingerprint: "choice" } })[1][1], "waiting");
console.log("PASS: real running vs stale activity, completed plan, timeout attention, explicit acknowledgement and user-choice stage states");

const legacy = { ...ready, legacyReadOnly: true, sourceStale: true, blocked: true } as Run;
const legacyView = deriveView(legacy, true);
for (const key of ['canRun','canChangeChoice','canPause','canReplan','canRepair','canRecheck'] as const) assert.equal(legacyView[key],false,`legacy ${key} stays read-only`);
assert.equal(legacyView.downloadable,true,'saved legacy text remains exportable even when its source is old');
assert.match(legacyView.title,/旧版.*只读/);
const pendingRepair = { ...ready, production:{boundary:{status:'REPAIR_REQUIRED',actualVersion:'v2',changedKeys:['position']},materialNeeds:[],sharedBudget:null,pendingRepair:{packageIds:['P1'],reason:'位置待补',changedKeys:['position']},blocking:false,chainComplete:false,chainMode:'CHAIN'} } as Run;
assert.equal(deriveView(pendingRepair,true).ready,false,'a saved draft with pending boundary repair must not be marked complete');
assert.match(deriveView(pendingRepair,true).title,/局部待补/);
const stoppedForBudget: Run = {...pendingRepair,status:'budget_stop',usage:{...base.usage,knownTokens:340420,totalTokens:340420}};
const budgetView=deriveView(stoppedForBudget,true);
assert.match(budgetView.title,/停止线/,'the actual paid-stop cause must not be hidden by a secondary material notice');
assert.match(budgetView.description,/340,420|340420/,'show actual known usage');
assert.match(budgetView.description,/300,000|300000/,'show the unchanged stop line');
assert.equal(budgetView.canRun,false);
assert.match(deriveView({...pendingRepair,production:{...pendingRepair.production!,pendingRepair:{...pendingRepair.production!.pendingRepair!,reason:'CONSUMED_MATERIAL'}}},true).description,/资料|材料/,'never display raw CONSUMED_MATERIAL to the user');
for(const phase of ['starting','waiting','generating','receiving'] as const){
 const active={...planned,active:true,status:'running',operations:[{attemptId:'new',stage:'author',packageIds:['P1'],status:'running',localPhase:'executing',createdAt:base.createdAt,execution:{phase}}]} as Run;
 const step=phaseSteps!(active)[1];
 assert.equal(step.state,phase==='generating'?'running':'waiting',`${phase} does not invent generation`);
 assert.match(step.label,phase==='waiting'?/等待首个输出/:phase==='generating'?/生成中/:phase==='receiving'?/接收回包/:/本机启动/);
}
console.log('PASS: legacy read-only with saved export, pending local repair, and observed execution phases');
