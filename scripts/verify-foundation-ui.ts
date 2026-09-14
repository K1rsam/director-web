import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { migrateDatabase } from "@/lib/database-migration";
import { deriveProjectCardState } from "@/lib/project-entry";
import { deriveProjectGuidance } from "@/lib/ui-guidance";
import { getProjectStudio } from "@/lib/studio";
import { buildFoundationStageViews } from "@/lib/studio";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildEpisodeFoundationPackets } from "@/lib/foundation-state";
import { buildSourceIndex } from "@/lib/project-foundation-contracts";

// Node SSR checks render the real component; CSS compilation belongs to Next/browser checks.
createRequire(import.meta.url).extensions['.css'] = module => { module.exports = {}; };

const checks: Array<[string, () => void | Promise<void>]> = [];
const check = (name: string, run: () => void | Promise<void>) => checks.push([name, run]);
const read = (path: string) => readFileSync(path, "utf8");

function displayFixture(): Parameters<typeof buildFoundationStageViews>[0] {
  const common = { schema: "FOUNDATION_CANDIDATE_V1" as const, createdAt: new Date(0).toISOString(), sourceVersion: "source", inputVersion: "input", batchToken: "batch", scope: [1], mechanicalIssues: [] };
  const run = (stageCode: string) => ({ id: `${stageCode}-run`, projectId: "project", episodeId: null, stageCode, roleName: stageCode, provider: "CLI", model: "test-model", status: "SUCCEEDED" as const, inputSummary: null, outputSummary: null, log: null, error: null, startedAt: null, finishedAt: null, durationMs: 10, createdAt: new Date(0) });
  return {
    preprocessReady: true, planningReady: true, assetsReady: true, dataReady: true, dataIssues: [], f2Recovery: null, reviewReady: true, ready: true, draftComplete: true, finalOutput: null,
    sourceContext: { version: "fixture", background: [], unresolved: [], issues: [], complete: true, notices: [], coverage: "COMPLETE" }, recoveries: { F1: null, F2: null, Q1: null }, methodVersions: { F1: "fixture-f1", F2: "fixture-f2", Q1: "fixture-q1" },
    message: "当前版本资料已批准", sourceVersion: "source", inputVersion: "input",
    candidates: {
      f1: { ...common, id: "f1", runId: "F1-run", stageCode: "F1", upstreamSnapshotIds: {}, output: { coverage: [1], overview: "后台全剧理解", episodes: [{ number: 1, summary: "本集摘要", context: "F1消费者上下文", sourceSelections: [] }], issues: [] } },
      f2: { ...common, id: "f2", runId: "F2-run", stageCode: "F2", upstreamSnapshotIds: { f1: "f1" }, output: { coverage: [1], assets: [{ key: "hero", name: "人物一", type: "CH", aliases: [], description: "后台身份说明", sourceRefs: [], appearances: [] }], episodes: [{ number: 1, context: "F2消费者上下文", assetKeys: ["hero"] }], issues: [] } }
    },
    review: { ...common, id: "q1", runId: "Q1-run", stageCode: "Q1", upstreamSnapshotIds: { f1: "f1", f2: "f2" }, output: { coverage: [1], verdict: "READY", summary: "独审结论正文", issues: [] } },
    approved: null, historyRuns: [], latestRuns: { f1: run("F1"), f2: run("F2"), q1: run("Q1") }
  };
}

check("运行、失败、拒收与同源旧Q1不会显示当前通过", async () => {
  const state = displayFixture();
  const views = (value: typeof state) => buildFoundationStageViews(value);
  assert.deepEqual(views(state).map((stage) => stage.status), ["执行成功", "执行成功", "执行成功"]);
  const stale = { ...state, planningReady: false, assetsReady: false, reviewReady: false, ready: false };
  assert.ok(views(stale).every((stage) => stage.status === "执行成功"), "批准链未就绪不能把成功记录变成待重跑");
  assert.equal(views({ ...stale, historyRuns: [], latestRuns: { ...state.latestRuns, f1: { ...state.latestRuns.f1!, status: "RUNNING" } } })[0].status, "进行中");
  assert.equal(views({ ...stale, historyRuns: [], latestRuns: { ...state.latestRuns, f1: { ...state.latestRuns.f1!, status: "FAILED", error: "模型失败" } } })[0].status, "失败");
  assert.equal(views({ ...stale, historyRuns: [], latestRuns: { ...state.latestRuns, f1: { ...state.latestRuns.f1!, status: "CANCELED" } } })[0].status, "已停止");
  const rejected = { ...state, reviewReady: false, ready: false, review: { ...state.review!, output: { ...state.review!.output, verdict: "BLOCKED" as const } } };
  assert.equal(views(rejected)[2].status, "执行成功", "运行成功与成果是否批准分别表达");
  const rerunF2 = { ...rejected, candidates: { ...state.candidates, f2: { ...state.candidates.f2!, id: "new-f2" } } };
  assert.equal(views(rerunF2)[2].status, "执行成功", "没有运行版本不匹配证据时，不因批准链变化要求重跑");
  const { FoundationViewer } = await import("@/app/projects/[projectId]/foundation-viewer");
  const html = renderToStaticMarkup(createElement(FoundationViewer, { state: rerunF2 }));
  for (const text of ["后台全剧理解", "F1消费者上下文", "后台身份说明", "F2消费者上下文", "独审结论正文", "历史审查"]) assert.ok(html.includes(text), `未呈现${text}`);
  assert.ok(!html.includes("当前版本已批准"));
});

check("旧资产和快照数量不能冒充当前批准", () => {
  const metrics = { episodeCount: 12, snapshotCount: 999, assetCount: 999, unitEpisodeCount: 12, foundationReady: false };
  assert.equal(deriveProjectCardState(metrics).stage, "全剧资料");
  assert.equal(deriveProjectCardState({ ...metrics, foundationReady: true }).stage, "全剧资料就绪");
  assert.equal(deriveProjectCardState({ ...metrics, foundationReady: undefined } as unknown as typeof metrics).stage, "全剧资料", "缺少明确批准也必须未就绪");
  assert.equal(deriveProjectGuidance({ pendingContracts: 0, foundationReady: false, planningReady: true, assetsReady: true, episodes: [] } as Parameters<typeof deriveProjectGuidance>[0]).kind, "foundation");
});

check("上游重跑后的旧错误标为历史，当前失败和活动执行仍明确显示", () => {
  const state = displayFixture();
  state.ready = false; state.reviewReady = false;
  state.latestRuns.f2!.createdAt = new Date(2000);
  state.latestRuns.q1 = { ...state.latestRuns.q1!, createdAt: new Date(1000), status: "CANCELED", error: "旧F1整数错误", inputSummary: JSON.stringify({ sourceVersion: "source", inputVersion: "input" }) };
  const old = buildFoundationStageViews(state)[2];
  assert.equal(old.status, "已停止 · 历史版本");
  assert.equal(old.error, "旧F1整数错误", "历史错误正文不能删掉");
  assert.equal(old.errorHistorical, true);
  assert.equal(old.errorCreatedAt, new Date(1000).toISOString());
  state.latestRuns.q1 = { ...state.latestRuns.q1!, createdAt: new Date(3000), status: "FAILED", error: "本次失败" };
  assert.equal(buildFoundationStageViews(state)[2].status, "失败");
  assert.equal(buildFoundationStageViews(state)[2].errorHistorical, false);
  state.latestRuns.q1.inputSummary = JSON.stringify({ sourceVersion: "old-source", inputVersion: "input" });
  assert.equal(buildFoundationStageViews(state)[2].errorHistorical, true, "源版本变化后的错误属于历史");
  state.latestRuns.q1.status = "RUNNING";
  assert.equal(buildFoundationStageViews(state)[2].status, "进行中", "仍在运行的旧版本任务不能隐藏，须保留停止入口");
});

check("F2描述来源并存及资料缺口不能被Q1 READY掩盖", async () => {
  const state = displayFixture();
  const gap = { severity: "BLOCKER" as const, owner: "F2" as const, coordinate: "episodes.28.assetKeys.hero", problem: "必须补本集状态或说明背景用途", sourceRefs: [] };
  state.dataReady = false; state.dataIssues = [gap]; state.ready = false; state.reviewReady = false;
  state.candidates.f2!.output.assets[0].descriptionVariants = [
    { text: "第一批完整身份说明", sourceRefs: [{ episode: 1, startLine: 1, endLine: 1 }] },
    { text: "后续片段新增依据", sourceRefs: [{ episode: 2, startLine: 3, endLine: 4 }] }
  ];
  state.candidates.f2!.output.episodes[0].backgroundRefs = [{ key: "hero", purpose: "只供背景理解，不声称在场", sourceRefs: [{ episode: 0, startLine: 1, endLine: 2 }] }];
  const views = buildFoundationStageViews(state);
  assert.equal(views.find((view) => view.stageCode === "F2")!.status, "执行成功");
  assert.equal(views.find((view) => view.stageCode === "Q1")!.status, "执行成功");
  const { FoundationViewer } = await import("@/app/projects/[projectId]/foundation-viewer");
  const html = renderToStaticMarkup(createElement(FoundationViewer, { state }));
  for (const text of ["第一批完整身份说明", "后续片段新增依据", "第2集 L3–4", "只供背景理解，不声称在场", "必须补本集状态", "资料缺口（程序检查）"]) assert.ok(html.includes(text), `遗漏${text}`);
  assert.ok(!html.includes("当前版本已批准"));
});

check("F1给F2的后台线索单列展示，不冒充当集消费者上下文", async () => {
  const state = displayFixture();
  state.candidates.f1!.output.episodes[0].f2Notes = "BACKEND_F2_NOTES_ONLY";
  const { FoundationViewer } = await import("@/app/projects/[projectId]/foundation-viewer");
  const html = renderToStaticMarkup(createElement(FoundationViewer, { state }));
  assert.ok(html.includes("给F2的后台核对线索（不进入消费者包）"));
  assert.ok(html.includes("BACKEND_F2_NOTES_ONLY"));
  assert.equal(state.candidates.f1!.output.episodes[0].context, "F1消费者上下文");
});

check("单集名称保留工作标签但不自动升级为已登记别名", () => {
  const state = displayFixture();
  const index = buildSourceIndex([{ number: 1, title: "第一集", content: "第一集\n甲与乙遇见一道黑色的影子；当场登记名在墙上。" }]);
  const appearance = (label: string, match?: "LITERAL" | "NON_LITERAL") => Object.assign({ episode: 1, presence: "ONSTAGE" as const, state: "本集原述", sourceRefs: [{ episode: 1, startLine: 2, endLine: 2 }] }, { sourceName: label, ...(match ? { sourceNameMatch: match } : {}) });
  const base = state.candidates.f2!.output.assets[0];
  state.candidates.f2!.output.assets = [
    { ...base, key: "shadow", name: "后台真名", aliases: ["当场登记名", "未来称谓"], appearances: [appearance("黑色影子", "NON_LITERAL"), appearance("黑影短称", "NON_LITERAL")] },
    { ...base, key: "literal", appearances: [appearance("甲", "LITERAL")] },
    { ...base, key: "registered", name: "后台丙" },
    { ...base, key: "background" },
    { ...base, key: "legacy", appearances: [appearance("乙")] }
  ];
  state.candidates.f2!.output.episodes[0].assetKeys = state.candidates.f2!.output.assets.map((asset) => asset.key);
  state.candidates.f2!.output.episodes[0].backgroundRefs = [Object.assign({ key: "background", purpose: "往事背景", sourceRefs: [{ episode: 1, startLine: 2, endLine: 2 }] }, { sourceName: "远处旧堡", sourceNameMatch: "NON_LITERAL" as const })];
  const before = JSON.stringify(state.candidates);
  const [packet] = buildEpisodeFoundationPackets(index, "input", state.candidates.f1!, state.candidates.f2!);
  assert.deepEqual(packet.identities.map((item) => item.name), ["黑色影子", "甲", "后台丙", "远处旧堡", "乙"]);
  assert.deepEqual(packet.identities.map((item) => (item as { nameBasis?: string }).nameBasis), ["WORKING_LABEL", "SOURCE_WORDING", "REGISTERED_IDENTITY", "WORKING_LABEL", "WORKING_LABEL"]);
  assert.deepEqual(packet.identities[0].aliases, ["当场登记名"], "工作标签保留在事件中，不能自动进入已登记aliases");
  assert.deepEqual(packet.identities[0].appearances.map((item) => item.sourceName), ["黑色影子", "黑影短称"]);
  assert.equal(JSON.stringify(state.candidates), before, "供给构建不能改写候选原值");
});

check("页面展示工作标签与非逐字提示但不自动报错或通过", async () => {
  const state = displayFixture();
  state.ready = false; state.reviewReady = false; state.review = null; state.latestRuns.q1 = null;
  state.message = "当前候选尚未经Q1独立审核";
  state.candidates.f2!.output.assets[0].appearances = [Object.assign({ episode: 1, presence: "ONSTAGE" as const, state: "跟随皮球", sourceRefs: [{ episode: 1, startLine: 3, endLine: 3 }] }, { sourceName: "黑色影子", sourceNameMatch: "NON_LITERAL" as const })];
  state.candidates.f2!.output.episodes[0].backgroundRefs = [Object.assign({ key: "hero", purpose: "历史背景", sourceRefs: [{ episode: 0, startLine: 17, endLine: 17 }] }, { sourceName: "背景工作短称", sourceNameMatch: "NON_LITERAL" as const })];
  const { FoundationViewer } = await import("@/app/projects/[projectId]/foundation-viewer");
  const html = renderToStaticMarkup(createElement(FoundationViewer, { state }));
  for (const text of ["黑色影子", "背景工作短称", "当集标签", "非逐字表述", "词面匹配不等于身份确认", "第1集 L3–3", "第0集 L17–17"]) assert.ok(html.includes(text), `遗漏${text}`);
  assert.ok(!html.includes("当前版本已批准"));
  assert.deepEqual(state.dataIssues, []);
});

check("旧三岗恢复协议保留，主页面仅开放连续交付入口且仍鉴权", () => {
  const controls = read("app/projects/[projectId]/foundation-actions.tsx");
  const page = read("app/projects/[projectId]/page.tsx");
  const actions = read("app/actions.ts");
  const action = actions.slice(actions.indexOf("export async function runFoundationStageAction"), actions.indexOf("export async function stopProjectFoundationAction"));
  assert.ok(controls.includes("复验已有{stage}完整结果（不调用模型）"));
  assert.ok(controls.includes("继续{stage}未完成分片"));
  assert.ok(controls.includes('["F1", "F2", "Q1"]'));
  assert.ok(controls.includes('name="allowUnknownRetry"') && controls.includes("window.confirm") && controls.includes("可能重复计费"));
  assert.ok(controls.includes('name="resumeFromRunId"') && controls.includes('name="replayOnly"'));
  assert.ok(page.includes("FoundationDeliveryPanel") && !page.includes("<FoundationActions"));
  const delivery = read("app/projects/[projectId]/foundation-delivery-panel.tsx");
  assert.ok(delivery.includes('name="expectedState"') && delivery.includes('type="checkbox" name="allowUnknownRetry" value="yes" required'));
  const start = actions.slice(actions.indexOf("export async function startFoundationDeliveryAction"), actions.indexOf("export async function stopFoundationDeliveryAction"));
  assert.ok(start.indexOf("requireProjectAccess") < start.indexOf("await queueFoundationDelivery"));
  assert.ok(action.includes("resumeFromRunId") && action.includes("replayOnly"));
  assert.ok(action.indexOf("requireProjectAccess") < action.indexOf("queueSingleFoundationStage(projectId"));
});

check("页面使用持续资料状态，不以旧批准或场次数量冒称完成", () => {
  const page = read("app/projects/[projectId]/page.tsx");
  const controls = read("app/projects/[projectId]/foundation-actions.tsx");
  const studio = read("lib/studio.ts");
  const actions = read("app/actions.ts");
  assert.ok(studio.includes("getFoundationState"));
  assert.ok(page.includes("FoundationDocumentViewer") && page.includes("getFoundationDeliveryState"));
  assert.ok(!page.includes("studio.firstPhase.ready") && page.includes("complete: delivery.complete"));
  assert.ok(page.includes("foundation/export"));
  assert.ok(page.includes("全剧资料工作台"));
  assert.ok(page.includes("后续阶段尚未启用"));
  assert.ok(!page.includes("/episodes/"), "第一阶段工作台不得链接旧E生产页");
  assert.ok(!read("app/ui/app-chrome.tsx").includes("/episodes/"), "侧栏不得引导旧E生产");
  assert.ok(read("app/ui/app-chrome.tsx").includes("v0.2 第一阶段测试"));
  assert.ok(read("app/page.tsx").includes("v0.2 第一阶段测试"));
  assert.ok(read("app/ui/app-chrome.tsx").includes("原文 · 整理 · 完善"), "侧栏用资料处理文案而非岗位编号");
  assert.ok(page.includes("处理历史与运行设置") && page.includes("run.stageCode"), "岗位记录仍保留在折叠历史中");
  assert.ok(read("app/page.tsx").includes("foundationReady"));
  const contextExport = read("scripts/context-export.ts");
  assert.ok(contextExport.includes("getFoundationState") && contextExport.includes("foundationReady"), "旧context导出也必须读取真实批准");
  assert.ok(!contextExport.includes("function deriveStage"), "旧context导出不得复制数量猜测进度");
  assert.ok(controls.includes("直接优化并交付结果"));
  assert.ok(controls.includes("非 AI"));
  for (const retired of ["validationReady", "确定性校验", 'statusOf("P1")']) assert.ok(!controls.includes(retired), retired);
  assert.ok(!page.includes("sceneCount > 0"));
  assert.ok(!studio.includes("planningReady: Boolean(memory)"));
  assert.ok(!studio.includes("assetsReady: project.assets.length > 0"));
  const single = actions.slice(actions.indexOf("export async function runFoundationStageAction"), actions.indexOf("export async function stopProjectFoundationAction"));
  for (const code of ["F1", "F2", "Q1"]) assert.ok(single.includes(`\"${code}\"`), `缺少${code}单岗入口`);
  const stop = actions.slice(actions.indexOf("export async function stopProjectFoundationAction"));
  assert.match(stop, /stageCode: \{ in: \["F1", "F2", "Q1"\] \}/);
  assert.ok(stop.includes('status: "CANCELED"'));
  assert.match(stop, /where: \{ id: \{ in: runs\.map\(\(run\) => run\.id\) \}, status: \{ in: \["QUEUED", "RUNNING"\] \} \}/, "停止不能把已完成的岗位改为取消");
  assert.ok(stop.indexOf("requireProjectAccess") < stop.indexOf("pipelineRun.findMany"));
});

check("导出路由在读取资料前检查项目权限", () => {
  const path = "app/projects/[projectId]/foundation/export/route.ts";
  assert.ok(existsSync(path), "尚无第一阶段资料导出入口");
  const route = read(path);
  assert.ok(route.indexOf("await requireProjectAccess") >= 0);
  assert.ok(route.indexOf("await requireProjectAccess") < route.indexOf("await buildFoundationExport"));
  assert.ok(route.includes("getCurrentUser") && route.includes("status: 401"), "未登录下载返回401而非HTML登录页");
  assert.ok(route.includes('"Cache-Control": "private, no-store"'));
  assert.ok(!route.includes("project.title"), "下载文件名不得使用可注入header的title");
});

check("直接访问旧单集URL只显示鉴权后的阶段告知", () => {
  const page = read("app/projects/[projectId]/episodes/[episodeId]/page.tsx");
  const activePage = page.slice(page.indexOf("export default async function EpisodeStudioPage"), page.indexOf("async function LegacyEpisodeStudioPage"));
  assert.ok(activePage.includes("v0.2 后续阶段尚未启用"), "旧URL也必须只读提示，不能继续显示生产控件");
  assert.ok(activePage.includes("await requireEpisodeAccess(projectId, episodeId)"));
  assert.ok(activePage.indexOf("await requireEpisodeAccess") < activePage.indexOf("return ("));
  assert.ok(activePage.includes("返回第一阶段资料"));
  assert.doesNotMatch(activePage, /<form|<EpisodePipelineButton|<ResetEpisodeButton|<UnitPromptCard/);
});

check("临时库导出全量原文、历史版本与完整调用证据", async () => {
  assert.ok(existsSync("lib/foundation-export.ts"), "尚无第一阶段完整导出实现");
  const { buildFoundationExport, foundationExportFilename, serializeFoundationExport } = await import("@/lib/foundation-export");
  const directory = mkdtempSync(join(tmpdir(), "director-foundation-ui-"));
  const databaseUrl = `file:${join(directory, "test.db")}`;
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await migrateDatabase({ databaseUrl, schemaPath: join(process.cwd(), "prisma/schema.prisma"), quiet: true });
    const user = await db.user.create({ data: { email: "foundation-ui@example.test", username: "foundation-ui-test", passwordHash: "not-a-real-login" } });
    const project = await db.project.create({ data: {
      title: '普通剧本\r\nX-Injected: true', roles: { create: { userId: user.id, role: "ADMIN" } },
      episodes: { create: { number: 1, title: "第一集", content: "  第一集\r\n逐字正文  \r\n" } }
    }, include: { episodes: true } });
    const foreign = await db.project.create({ data: { title: "不在导出范围的项目" } });
    const emptyRunning = await db.project.create({ data: { title: "原文缺失但任务仍活动", roles: { create: { userId: user.id, role: "ADMIN" } } } });
    await db.pipelineRun.create({ data: { projectId: emptyRunning.id, stageCode: "F1", roleName: "F1", status: "RUNNING" } });
    const emptyStudio = await getProjectStudio(emptyRunning.id, user.id, db);
    assert.equal(emptyStudio?.firstPhase.ready, false);
    assert.equal(emptyStudio?.firstPhase.stages[0].status, "进行中", "源文失效时也要保留活动任务状态，确保停止按钮可用");
    const sourceText = `原文开头\r\n${"原始资料  ".repeat(4000)}\r\n原文末尾\r\n`;
    const raw = `RAW-HEAD-${"完整模型输出".repeat(5000)}-RAW-TAIL`;
    const log = JSON.stringify({ schema: "FOUNDATION_RUN_EVIDENCE_V1", calls: [{ systemPrompt: "实际系统提示词", taskPrompt: "实际任务输入", promptHash: "hash", response: { rawOutput: raw, data: { overview: "已解析输出" } }, mechanicalIssues: [{ problem: "机械问题" }], modelIssues: [{ problem: "作者问题" }] }], error: "失败原因" });
    const rows = [
      { sceneKey: "SOURCE_IMPORT", content: JSON.stringify({ sourceName: "原稿.docx", sourceText }), metadata: '{"textOrigin":"DOCX_EXTRACTED_TEXT"}' },
      { sceneKey: "FOUNDATION_SOURCE", content: '{"sourceVersion":"v-old","sourceIndex":{"episodes":[]}}' },
      { sceneKey: "FOUNDATION_SOURCE", content: '{"sourceVersion":"v-new","sourceIndex":{"episodes":[]}}' },
      { sceneKey: "FOUNDATION_F1", content: '{"schema":"FOUNDATION_CANDIDATE_V1","stageCode":"F1","output":{"overview":"候选理解"}}' },
      { sceneKey: "FOUNDATION_F2", content: '{"schema":"FOUNDATION_CANDIDATE_V1","stageCode":"F2","output":{"assets":[]}}' },
      { sceneKey: "FOUNDATION_Q1", content: '{"schema":"FOUNDATION_CANDIDATE_V1","stageCode":"Q1","output":{"verdict":"REPAIR","issues":[]}}' },
      { sceneKey: "FOUNDATION_APPROVED", content: '{"schema":"FOUNDATION_APPROVED_V1","sourceVersion":"v-old"}' },
      { sceneKey: "EP-1-CONTEXT", episodeId: project.episodes[0].id, content: '{"schema":"EPISODE_FOUNDATION_V1","episode":1,"f1Context":"批准单集供给"}' },
      { sceneKey: "PROJECT_MEMORY", content: "旧版资料，只作历史" }
    ];
    await db.sceneSnapshot.createMany({ data: rows.map((row) => ({ projectId: project.id, ...row })) });
    await db.asset.create({ data: { projectId: project.id, code: "CH-999", type: "CH", name: "旧版资产", status: "confirmed" } });
    await db.sceneSnapshot.create({ data: { projectId: foreign.id, sceneKey: "SOURCE_IMPORT", content: "别人的原文不得导出" } });
    await db.pipelineRun.createMany({ data: [
      ...Array.from({ length: 35 }, (_, index) => ({ projectId: project.id, stageCode: index % 2 ? "F1" : "P1", roleName: "资料岗位", provider: "CLI", model: "test-model", status: "FAILED" as const, log, inputSummary: JSON.stringify({ index, sourceVersion: "v-old", taskInput: "原始输入" }), error: `错误-${index}` })),
      { projectId: project.id, episodeId: project.episodes[0].id, stageCode: "E1", roleName: "第二阶段", log: "第二阶段不属于本次导出" },
      { projectId: foreign.id, stageCode: "F1", roleName: "别人的岗位", log: "别人的调用不得导出" }
    ] });
    const studio = await getProjectStudio(project.id, user.id, db);
    assert.equal(studio?.firstPhase.ready, false, "旧记忆与旧资产不应让工作台放行");
    const exported = await buildFoundationExport(project.id, db);
    assert.equal(exported.schema, "PROJECT_FOUNDATION_EXPORT_V1");
    assert.equal(JSON.parse(exported.sourceImports[0].content).sourceText, sourceText);
    assert.match(exported.notes.join(" "), /旧版.*提取文本.*原文件字节/);
    assert.match(exported.notes.join(" "), /新版.*恢复副本/);
    assert.match(exported.notes.join(" "), /providerCallCount.*reusedFrom.*revalidatedUnder/);
    assert.match(exported.notes.join(" "), /历史.*耗时.*不.*归零/);
    assert.equal(exported.currentState.dataReady, false);
    assert.equal(Reflect.get(exported.currentState, "draftComplete"), false, "导出须单列完整初稿状态，不能以ready替代");
    assert.deepEqual(exported.currentState.dataIssues, []);
    assert.equal(exported.sourceVersions.length, 2);
    assert.equal(exported.candidates.f1.length, 1);
    assert.equal(exported.candidates.f2.length, 1);
    assert.equal(exported.candidates.q1.length, 1);
    assert.equal(exported.approvals.length, 1);
    assert.equal(exported.approvedEpisodePackets.length, 1);
    assert.equal(exported.pipelineRuns.length, 35, "不能截成最近30条或12k尾部");
    assert.equal(exported.pipelineRuns[0].log, log);
    assert.equal(JSON.parse(exported.pipelineRuns[0].log!).calls[0].response.rawOutput, raw);
    assert.equal(exported.project.episodes[0].content, project.episodes[0].content);
    const serialized = serializeFoundationExport(exported);
    assert.ok(!serialized.includes("别人的原文") && !serialized.includes("别人的调用"));
    assert.ok(!serialized.includes("第二阶段不属于本次导出"));
    assert.ok(!serialized.includes("passwordHash"));
    assert.equal(serializeFoundationExport({ text: "sk-fiction 是剧中普通文本；known-secret" }, ["known-secret"]), '{\n  "text": "sk-fiction 是剧中普通文本；[REDACTED_API_KEY]"\n}');
    const filename = foundationExportFilename('id\r\n"测试');
    assert.ok(!/[\r\n"]/.test(filename));
    assert.ok(filename.includes(encodeURIComponent('id\r\n"测试')));
  } finally {
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function main() {
  let failures = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  }
  assert.equal(failures, 0, `${failures} foundation UI/export checks failed`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
