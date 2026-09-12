/** Isolated browser → action → worker → fake CLI regression. No real model or user database. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { seedTestAccounts } from "@/lib/account-seed";
import { migrateDatabase } from "@/lib/database-migration";
import type { buildFoundationExport } from "@/lib/foundation-export";

type Exported = Awaited<ReturnType<typeof buildFoundationExport>>;
const PASSWORD = "isolated-foundation-e2e-password";
const COOKIE = "director_foundation_e2e_session";
const SOURCE = "卷首说明：这只是隔离工程测试。\r\n保留卷首、空行和行尾空格。  \r\n\r\n第0集 起点\r\n0-1 内 测试室 日\r\n测试人物穿婚服，交出钥匙。测试人物：零集完整正文。  \r\n\r\n第2集 后续\r\n2-1 外 测试庭院 夜\r\n测试人物伤后左臂缺失。测试人物：二集完整正文。  \r\n";
const EPISODES = [
  { number: 0, content: SOURCE.slice(SOURCE.indexOf("第0集"), SOURCE.indexOf("第2集")) },
  { number: 2, content: SOURCE.slice(SOURCE.indexOf("第2集")) }
];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(url: string, server: ChildProcess, logs: () => string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (server.exitCode !== null) throw new Error(`测试网站提前退出：${logs()}`);
    try { if ((await fetch(`${url}/login`, { redirect: "manual" })).status < 500) return; } catch { /* Starting. */ }
    await delay(250);
  }
  throw new Error(`测试网站启动超时：${logs()}`);
}

async function stopServer(server: ChildProcess) {
  if (!server.pid || server.exitCode !== null) return;
  try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  await Promise.race([new Promise<void>((resolve) => server.once("exit", () => resolve())), delay(3_000)]);
  if (server.exitCode === null) {
    try { process.kill(-server.pid, "SIGKILL"); } catch { server.kill("SIGKILL"); }
  }
}

function browserOptions() {
  if (existsSync(chromium.executablePath())) return {};
  const executablePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "需要已安装的 Chrome/Chromium；测试不会安装浏览器。");
  return { executablePath };
}

function createFakeCli(directory: string) {
  const executable = join(directory, "fake-codex.cjs");
  // The executable cannot escape this test's explicit database and environment boundary.
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const directory = ${JSON.stringify(directory)};
if (process.env.FOUNDATION_E2E_DIRECTORY !== directory || process.env.DATABASE_URL !== "file:" + path.join(directory, "e2e.db") || process.env.DEEPSEEK_API_KEY !== "" || !process.env.DEEPSEEK_API_BASE.endsWith(".invalid")) throw new Error("Unsafe fake CLI environment");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli fake-foundation-e2e"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { console.log("Logged in fake-foundation-e2e"); process.exit(0); }
if (args[0] !== "exec" || args.includes("resume") || !args.includes("--ephemeral")) throw new Error("Unexpected real/session command");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  const task = prompt.slice(prompt.lastIndexOf("### 当前任务"));
  const stage = task.match(/执行(F1|F2|Q1)(?:当前资料|制作资料)任务/)[1];
  const input = JSON.parse(task.slice(task.lastIndexOf("INPUT_JSON:") + "INPUT_JSON:".length).trim());
  const scope = input.scope;
  const production = input.workflow === "PRODUCTION_FOUNDATION_V3";
  if (!Array.isArray(scope) || !scope.length || (!production && (!input.sourceVersion || !input.inputVersion))) throw new Error("Missing scoped input");
  if (input.source.schema !== "NUMBERED_SOURCE_V1" || (!production && input.source.version !== input.sourceVersion) || JSON.stringify(input.source.episodes.map(episode => episode.number)) !== JSON.stringify(scope)) throw new Error("Missing numbered current source");
  if (input.source.episodes.some(episode => "content" in episode || !Array.isArray(episode.lines) || episode.lines.length !== episode.lineCount || episode.lines.some((line, index) => !Array.isArray(line) || line[0] !== index + 1 || typeof line[1] !== "string"))) throw new Error("Invalid numbered source lines or duplicate raw content");
  if (!production && stage === "F2" && ("processedChunks" in input.prior || input.prior.registry.some(asset => "appearances" in asset))) throw new Error("Repeated F2 history in normal input");
  if (!production && stage === "F2" && !input.f1.episodes.every(episode => episode.f2Notes.includes("BACKEND_F2_LEAD"))) throw new Error("F1 backend notes did not reach F2");
  if (!production && stage === "Q1" && [input.candidates.f1, input.candidates.f2].some(candidate => candidate.projection !== "SCOPE_PROJECTION" || JSON.stringify(candidate.output.coverage) !== JSON.stringify(scope))) throw new Error("Q1 candidate scope mismatch");
  if (!production && stage === "Q1" && (input.candidates.f2.output.assets.some(asset => asset.appearances.some(appearance => appearance.sourceName !== "测试角色" || appearance.sourceNameMatch !== "NON_LITERAL")) || input.episodePackets.some(packet => packet.identities.some(identity => identity.name !== "测试角色" || identity.nameBasis !== "WORKING_LABEL")))) throw new Error("Q1 did not receive preserved working labels and recomputed nonliteral markers");
  if (!production && stage === "Q1" && !/工作|字面|称谓/.test(input.reviewScopeNote)) throw new Error("Q1 is missing the naming interpretation note");
  if (production && stage === "F2" && ("f1" in input || "prior" in input || input.registry.some(asset => "appearances" in asset))) throw new Error("New F2 input repeats plot/state history");
  if (production && stage === "Q1" && ("episodePackets" in input || JSON.stringify(input.candidates).includes("appearances"))) throw new Error("New Q1 input repeats the full packet or ledger");
  const refs = scope.map(episode => {
    const line = input.source.episodes.find(source => source.number === episode).lines.find(line => line[1].includes("测试人物"));
    if (!line) throw new Error("Missing actual actor source text");
    return { episode, startLine: line[0], endLine: line[0] };
  });
  const control = JSON.parse(fs.readFileSync(path.join(directory, "control.json"), "utf8"));
  let data = stage === "F1"
    ? { coverage: scope, overview: "FAKE-ONLY：工程回归输出，不代表专业内容验收。", episodes: scope.map(number => ({ number, summary: "工程测试第" + number + "集", context: "FAKE-ONLY F1 context " + number, f2Notes: "BACKEND_F2_LEAD：仅给F2核对的线索", sourceSelections: number === 0 ? null : [{ episode: number, startLine: 1, endLine: 1, purpose: "仅验证原文定位传递" }] })), issues: [] }
    : stage === "F2"
      ? { coverage: scope, assets: [{ key: "fixture-only-character", name: "工程测试身份", type: "CH", aliases: [], description: "FAKE-ONLY：固定身份测试数据", sourceRefs: refs }], episodes: scope.map(number => ({ number, context: "FAKE-ONLY F2 context " + number, uses: [{ key: "fixture-only-character", sourceName: "测试角色", sourceNameMatch: "LITERAL", presence: "ONSTAGE", state: "FAKE-ONLY：固定状态", sourceRefs: [refs.find(ref => ref.episode === number)] }] })) }
      : { coverage: scope, verdict: control.q1Verdict, summary: "FAKE-ONLY：固定审核输出，不代表内容质量。", issues: control.q1Verdict === "READY" ? [] : [{ severity: "MAJOR", owner: "F1", coordinate: "episodes.0.context", problem: "FAKE-ONLY：模拟需返修，不批准当前资料", sourceRefs: [refs[0]] }] };
  if (production) {
    const known = stage === "F2" ? [...(input.registry || []), ...(input.previousAssetKeys || [])].find(asset => asset.name === "测试人物") : null;
    data = stage === "F1" ? { coverage: scope, overview: "FAKE-ONLY：简明工程测试导航", episodes: scope.map(number => ({ number, summary: "工程测试第" + number + "集", sourceSelections: null })) }
      : stage === "F2" ? { format: "ASSET_CATALOG_V2", coverage: scope, assets: [{ ...(known ? {key:known.key} : {}), name: "测试人物", type: "CH", episodes: scope, preparation: {mode:"REFERENCE"},
          variants: scope.map(number => ({ name: number === 0 ? "婚服" : number === 2 ? "伤后独臂" : "常服", episodes: [number], note: number === 2 ? "左臂缺失" : "", preparation:{mode:"DERIVE"} })) }] }
        : { format: "FOUNDATION_OPTIMIZATION_V2", coverage: scope, summary: "FAKE-ONLY：已直接完成资料优化", changes: control.q1Verdict === "REPAIR" ? {
            episodes: scope.map(number => ({ number, summary: "已优化第" + number + "集导航", context: "" })),
            assets: scope.includes(0) ? [{ name: "钥匙", type: "PROP", episodes: [0], preparation:{mode:"REFERENCE"} }] : []
          } : {}, notes: [] };
    if (stage === "F2" && control.addUnusedDefinition) {
      const location = [...(input.registry || []), ...(input.previousAssetKeys || [])].find(asset => asset.name === "工程测试后台总场景");
      data.assets.push({ ...(location ? {key:location.key} : {}), name: "工程测试后台总场景", type: "LOC", episodes: scope, preparation:{mode:"REFERENCE"} });
    }
  } else {
    if (stage === "F2" && control.addUnusedDefinition) data.assets.push({ key: "unused-background-site", name: "工程测试后台总场景", type: "LOC", description: "FAKE-ONLY：保留有源后台定义，不编造逐集使用。", sourceRefs: [{ episode: scope[0], startLine: 1, endLine: 1 }] });
    if (stage === "Q1" && control.addUnusedDefinition && !input.candidates.f2.output.assets.some(asset => asset.key === "unused-background-site")) throw new Error("Q1 missed sourced unused backend definition");
  }
  fs.appendFileSync(path.join(directory, "calls.jsonl"), JSON.stringify({ stage, scope, pid: process.pid, sourceVersion: input.sourceVersion, inputVersion: input.inputVersion, ephemeral: true, verdict: data.verdict || null }) + "\\n");
  fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(data));
  console.log(JSON.stringify({ type: "fake.foundation.completed", stage }));
});
`);
  chmodSync(executable, 0o700);
  writeFileSync(join(directory, "control.json"), JSON.stringify({ q1Verdict: "READY" }));
  return executable;
}

async function login(page: Page, baseUrl: string, username: string) {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

async function readExport(context: BrowserContext, url: string): Promise<Exported> {
  const response = await context.request.get(url, { maxRedirects: 0, headers: await testSessionHeaders(context) });
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-type"], /application\/json/);
  assert.equal(response.headers()["cache-control"], "private, no-store");
  const result = await response.json();
  assert.equal(result.schema, "PROJECT_FOUNDATION_EXPORT_V1");
  return result;
}

async function testSessionHeaders(context: BrowserContext) {
  // Chromium accepts Secure cookies on loopback; Playwright's Node HTTP client does not.
  // Forward only the synthetic cookie actually issued by this test's login, not a fabricated token.
  const cookie = (await context.cookies()).find((item) => item.name === COOKIE);
  assert.ok(cookie, "测试浏览器必须已通过真实登录取得专有cookie");
  return { Cookie: `${cookie.name}=${cookie.value}` };
}

async function waitForRuns(db: PrismaClient, projectId: string, count: number, syntheticFailedRunId?: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const runs = await db.pipelineRun.findMany({ where: { projectId, stageCode: { in: ["F1", "F2", "Q1"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    if (syntheticFailedRunId) assert.equal(runs.find((run) => run.id === syntheticFailedRunId)?.status, "FAILED", "仅允许指定的合成失败来源保留FAILED");
    const failed = runs.find((run) => run.id !== syntheticFailedRunId && (run.status === "FAILED" || run.status === "CANCELED"));
    if (failed) throw new Error(`${failed.stageCode} ${failed.status}: ${failed.error}; ${failed.log?.slice(-2_000)}`);
    if (runs.length === count && runs.every((run) => run.id === syntheticFailedRunId || run.status === "SUCCEEDED")) return runs;
    await delay(250);
  }
  throw new Error(`等待${count}条岗位记录完成超时。`);
}

function assertSource(exported: Exported) {
  assert.equal(exported.sourceImports.length, 1);
  assert.equal(JSON.parse(exported.sourceImports[0].content).sourceText, SOURCE, "导入源文应完整保留含CRLF");
  assert.deepEqual(exported.project.episodes.map(({ number, content }) => ({ number, content })), EPISODES);
  assert.ok(exported.sourceVersions.length >= 1);
  const source = JSON.parse(exported.sourceVersions.at(-1)!.content);
  assert.equal(source.schema, "FOUNDATION_SOURCE_V1");
  assert.equal(source.sourceVersion, exported.currentState.sourceVersion);
  assert.deepEqual(source.sourceIndex.episodes.map(({ number, content }: { number: number; content: string }) => ({ number, content })), EPISODES);
  for (const packetRow of exported.approvedEpisodePackets) {
    const packet = JSON.parse(packetRow.content);
    assert.equal(packet.schema, "EPISODE_FOUNDATION_V1");
    assert.equal(packet.source.content, EPISODES.find((episode) => episode.number === packet.episode)?.content);
    const boundQ1 = exported.candidates.q1.find((row) => row.id === JSON.parse(packetRow.metadata!).q1SnapshotId);
    const finalOutput = boundQ1 ? JSON.parse(boundQ1.content).finalOutput : null;
    if (finalOutput) {
      const episode = finalOutput.f1.episodes.find((episode: { number: number }) => episode.number === packet.episode);
      assert.equal(packet.f1Context, [episode.summary, episode.context].filter(Boolean).join("\n\n"));
      assert.equal(packet.f2Context, ""); assert.deepEqual(packet.sourceSelections, []);
      assert.equal(packet.identities[0].name, "测试人物");
      assert.ok(packet.identities[0].variants.length);
      assert.ok(packet.identities[0].variants.every((variant: {episodes:number[]}) => variant.episodes.includes(packet.episode)));
    } else {
    assert.equal(packet.f1Context, `FAKE-ONLY F1 context ${packet.episode}`);
    assert.equal(packet.f2Context, `FAKE-ONLY F2 context ${packet.episode}`);
    if (packet.episode === 0) assert.deepEqual(packet.sourceSelections, [], "null补文应规范为空，不删除本集原文");
    if (packet.episode === 2) {
      assert.equal(packet.sourceSelections.length, 1);
      assert.equal(packet.sourceSelections[0].content, EPISODES[1].content.slice(0, EPISODES[1].content.indexOf("\n") + 1), "另一集合法行号补文仍完整传递");
    }
    assert.ok(!JSON.stringify(packet).includes("BACKEND_F2_LEAD"), "后台F2线索不能混入消费者包");
    assert.equal(packet.identities[0].name, "测试角色", "工作标签保留，不偷改成后台统一名或声称是原文字面称谓");
    assert.equal(packet.identities[0].nameBasis, "WORKING_LABEL");
    assert.equal(packet.identities[0].appearances[0].sourceNameMatch, "NON_LITERAL");
    assert.ok(packet.identities[0].appearances[0].sourceRefs[0].startLine > 1);
    assert.ok(packet.source.content.includes("测试人物") && !packet.source.content.includes("测试角色"), "标签不能反写原文来伪造字面命中");
    }
    assert.equal(packet.sourceVersion, exported.currentState.sourceVersion);
    assert.equal(packet.inputVersion, exported.currentState.inputVersion);
  }
}

function assertEvidence(exported: Exported, count: number) {
  const runs = exported.pipelineRuns.filter((run) => ["F1", "F2", "Q1"].includes(run.stageCode));
  assert.equal(runs.length, count);
  for (const run of runs) {
    assert.equal(run.projectId, exported.project.id);
    assert.equal(run.status, "SUCCEEDED");
    assert.equal(run.provider, "Codex CLI");
    const evidence = JSON.parse(run.log!);
    const production = evidence.workflow === "PRODUCTION_FOUNDATION_V3";
    assert.equal(evidence.schema, "FOUNDATION_RUN_EVIDENCE_V1");
    assert.equal(evidence.calls.length, 1);
    assert.equal(evidence.sourceVersion, exported.currentState.sourceVersion);
    assert.equal(evidence.inputVersion, exported.currentState.inputVersion);
    const call = evidence.calls[0];
    assert.equal(call.status, "SUCCEEDED");
    assert.ok(call.systemPrompt.length > 100);
    assert.match(call.taskPrompt, /INPUT_JSON:/);
    assert.deepEqual(call.input.scope, [0, 2]);
    assert.equal(call.input.source.schema, "NUMBERED_SOURCE_V1");
    assert.equal(call.input.source.version, exported.currentState.sourceVersion);
    const reconstructed = call.input.source.episodes.map((episode: { number: number; lineCount: number; lines: Array<[number, string]> }) => {
      const expected = EPISODES.find((entry) => entry.number === episode.number)!;
      assert.ok(expected);
      assert.equal("content" in episode, false, "实际任务不重复携带无编号原文副本");
      const lineCount = (expected.content.match(/\r\n|\r|\n/g)?.length ?? 0) + 1; // The source index retains a final empty line.
      assert.equal(episode.lineCount, lineCount); assert.equal(episode.lines.length, lineCount);
      const content = episode.lines.map((line, index) => {
        assert.equal(line.length, 2); assert.equal(line[0], index + 1); assert.equal(typeof line[1], "string"); return line[1];
      }).join("");
      return { number: episode.number, content };
    });
    assert.deepEqual(reconstructed, EPISODES, "模型实际接收的编号原文须逐字还原含CRLF的原始分集");
    assert.deepEqual(JSON.parse(call.taskPrompt.slice(call.taskPrompt.lastIndexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length)).source, call.input.source, "原始prompt和decoded证据中的编号原文须一致");
    assert.deepEqual(JSON.parse(call.response.rawOutput), call.response.data);
    if (run.stageCode === "F1") assert.equal(call.response.data.episodes.find((episode: { number: number }) => episode.number === 0).sourceSelections, null, "原模型null不得在调用证据中被改写");
    if (run.stageCode === "F2" && production) {
      assert.deepEqual(Object.keys(call.response.data).sort(), ["assets", "coverage", "format"]);
      const snapshot = exported.candidates.f2.find((snapshot) => JSON.parse(snapshot.content).runId === run.id)!;
      assert.equal(JSON.parse(snapshot.content).output.format, "ASSET_CATALOG_V2");
      assert.ok(JSON.parse(snapshot.content).output.assets[0].variants.length);
    } else if (run.stageCode === "F2") {
      assert.deepEqual(Object.keys(call.response.data).sort(), ["assets", "coverage", "episodes"], "正常F2省略issues也须保留原响应形状");
      assert.ok(call.response.data.episodes.every((episode: { uses: Array<{ sourceName: string; sourceNameMatch: string }> }) => episode.uses.every((use) => use.sourceName === "测试角色" && use.sourceNameMatch === "LITERAL")), "不能改写原模型自填的标记来冒充程序判定");
      const snapshot = exported.candidates.f2.find((snapshot) => JSON.parse(snapshot.content).runId === run.id)!;
      assert.ok(snapshot);
      const output = JSON.parse(snapshot.content).output; assert.deepEqual(output.issues, []);
      assert.ok(output.assets.every((asset: { appearances: Array<{ sourceNameMatch: string }> }) => asset.appearances.every((appearance) => appearance.sourceNameMatch === "NON_LITERAL")));
    }
    if (run.stageCode === "Q1" && production) { assert.equal("episodePackets" in call.input, false); assert.equal(call.response.data.format, "FOUNDATION_OPTIMIZATION_V2"); }
    else if (run.stageCode === "Q1") assert.ok(call.input.episodePackets.every((packet: { identities: Array<{ nameBasis: string }> }) => packet.identities.every((identity) => identity.nameBasis === "WORKING_LABEL")));
    assert.match(call.response.stdout, /fake.foundation.completed/);
    assert.deepEqual(call.response.data.coverage, [0, 2]);
    assert.ok(evidence.promptHashes[run.stageCode]);
    assert.equal(call.response.sessionId, null, "临时调用不得保存用户会话");
  }
}

async function verifyUnknownRetryConfirmation(db: PrismaClient, page: Page, baseUrl: string, directory: string, ownerProjectId: string, projectIds: Set<string>) {
  const { importProjectFromText } = await import("@/lib/workflow");
  const owner = await db.projectRole.findFirstOrThrow({ where: { projectId: ownerProjectId }, select: { userId: true } });
  const { project } = await importProjectFromText({ ownerUserId: owner.userId, title: "未知请求确认隔离测试", sourceName: "confirmation.txt", sourceText: SOURCE, executionMode: "CLI" }, db);
  projectIds.add(project.id);
  writeFileSync(join(directory, "control.json"), JSON.stringify({ q1Verdict: "READY" }));
  await page.goto(`${baseUrl}/projects/${project.id}`);
  await page.getByRole("button", { name: "运行 F1", exact: true }).click();
  await waitForRuns(db, project.id, 1); await page.reload();
  await page.getByRole("button", { name: "运行 F2", exact: true }).click();
  const completed = (await waitForRuns(db, project.id, 2)).find(run => run.stageCode === "F2")!;
  const originalF1 = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: project.id, sceneKey: "FOUNDATION_F1" } });
  const log = JSON.parse(completed.log!); const id = randomUUID(); const batchToken = randomUUID();
  log.runId = id; log.batchToken = batchToken; delete log.mergedOutput;
  const call = log.calls[0]; call.status = "FAILED"; call.requestOutcome = "UNKNOWN"; delete call.response; delete call.checkpoint;
  call.error = "FAKE-ONLY：发出后未收到确认响应";
  const failed = await db.pipelineRun.create({ data: { ...completed, id, status: "FAILED", createdAt: new Date(), outputSummary: null, error: call.error,
    inputSummary: JSON.stringify({ ...JSON.parse(completed.inputSummary!), batchToken, workerPid: 0 }), log: JSON.stringify(log) } });
  const countCalls = () => readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").length;
  const before = countCalls();
  await page.reload();
  await page.getByRole("button", { name: "接续F2并完成Q1", exact: true }).first().click();
  await page.waitForURL(url => url.searchParams.get("foundationNotice") === "call-unknown");
  assert.equal(countCalls(), before, "普通继续不能重发未确认请求");
  assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 3);
  const retry = page.getByRole("button", { name: "确认重发F2未获结果的片段", exact: true });
  assert.equal(await retry.count(), 1);
  page.once("dialog", dialog => { assert.match(dialog.message(), /可能重复计费/); void dialog.dismiss(); });
  await retry.click(); await delay(200);
  assert.equal(countCalls(), before, "取消确认不应发起调用");
  assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 3);
  page.once("dialog", dialog => { assert.match(dialog.message(), /新增1次F2/); void dialog.accept(); });
  await retry.click();
  await waitForRuns(db, project.id, 4, id);
  assert.equal(countCalls(), before + 1, "明确确认仅重发指定F2范围，不自动运行Q1");
  assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id } }), failed, "未知原记录原样保留");
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({ where: { id: originalF1.id } }), originalF1);
  console.log("PASS browser unknown request: ordinary continue and canceled confirmation make 0 calls; explicit confirmation sends only specified F2 request");
}

async function verifyCapturedPrefixContinuation(db: PrismaClient, page: Page, context: BrowserContext, baseUrl: string, directory: string, artifacts: string, ownerProjectId: string, projectIds: Set<string>) {
  const { preprocessProject } = await import("@/lib/project-preprocess");
  const membership = await db.projectRole.findFirstOrThrow({ where: { projectId: ownerProjectId }, select: { userId: true, role: true } });
  const project = await db.project.create({ data: { title: "接续与失败草稿隔离测试", executionMode: "CLI", style: "3D漫剧", aspectRatio: "16:9", roles: { create: membership }, episodes: { create: [0, 1, 2].map((number) => ({ number, title: `工程测试第${number}集`, content: `第${number}集 工程测试后台总场景\r\n测试人物：这是完整合成正文。\r\n${"合成环境信息。".repeat(1800)}\r\n  ` })) } } });
  projectIds.add(project.id);
  await preprocessProject(project.id, db);
  const projectUrl = `${baseUrl}/projects/${project.id}`; const exportUrl = `${projectUrl}/foundation/export`;
  writeFileSync(join(directory, "control.json"), JSON.stringify({ q1Verdict: "REPAIR", addUnusedDefinition: true }));
  await page.goto(projectUrl);
  await page.getByRole("button", { name: "运行 F1", exact: true }).click();
  const firstRuns = await waitForRuns(db, project.id, 1);
  const f1Run = firstRuns[0]; const f1Snapshot = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: project.id, sceneKey: "FOUNDATION_F1" } });
  assert.equal(JSON.parse(f1Run.log!).calls.length, 3, "完整作者三个分片用于真实接续链");
  await page.reload();
  assert.ok(await page.getByRole("button", { name: "接续F2并完成Q1", exact: true }).count(), "有效F1后主入口必须接续，不重做F1");
  // Seed an exact, explicit historical capture using real successful worker evidence.
  // This successful fixture is kept as history; the latest synthetic failed source contains only its first response.
  await page.getByRole("button", { name: "运行 F2", exact: true }).click();
  const seededRuns = await waitForRuns(db, project.id, 2);
  const completedF2 = seededRuns.find((run) => run.stageCode === "F2")!;
  const completeLog = JSON.parse(completedF2.log!);
  assert.equal(completeLog.calls.length, 3);
  const capturedProtocol = completeLog.protocolVersion;
  const sourceRunId = randomUUID(); const batchToken = randomUUID();
  const firstCall = structuredClone(completeLog.calls[0]);
  firstCall.status = "FAILED"; firstCall.error = "FAKE-ONLY：完整目录响应保存后的模拟中断";
  firstCall.protocolVersion = capturedProtocol; delete firstCall.checkpoint;
  const summary = { ...JSON.parse(completedF2.inputSummary!), batchToken, protocolVersion: capturedProtocol, workerPid: 0 };
  for (const field of ["chunks", "providerCalls", "reusedCalls", "inputChars"]) delete summary[field];
  const historical = { ...completeLog, runId: sourceRunId, batchToken, protocolVersion: capturedProtocol, calls: [firstCall], error: firstCall.error };
  delete historical.mergedOutput; delete historical.mechanicalIssues;
  const source = await db.pipelineRun.create({ data: { ...completedF2, id: sourceRunId, status: "FAILED", createdAt: new Date(), error: firstCall.error,
    inputSummary: JSON.stringify(summary), outputSummary: null, log: JSON.stringify(historical) } });
  const callsBefore = readFileSync(join(directory, "calls.jsonl"), "utf8");
  await page.reload();
  const draft = page.locator(`#foundation-drafts [data-run-id="${sourceRunId}"][data-stage-code="F2"]`);
  assert.equal(await draft.count(), 1, "失败首片必须有独立可读草稿，不只藏在JSON导出中");
  for (const details of await draft.locator("details").all()) {
    if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
  }
  const draftText = await draft.innerText();
  assert.match(draftText, /婚服/);
  assert.match(draftText, /工程测试后台总场景/);
  assert.match(draftText, /未验收|未批准/);
  assert.doesNotMatch(draftText, /fake\.foundation\.completed/);
  await draft.evaluate((element) => element.scrollIntoView({ block: "start" }));
  for (const details of await draft.locator("details").all()) {
    const label = await details.locator(":scope > summary").innerText();
    if (/完整原始/.test(label) && await details.getAttribute("open") !== null) await details.locator(":scope > summary").click();
  }
  await draft.evaluate((element) => { element.scrollIntoView({ block: "start", behavior: "instant" }); });
  await page.screenshot({ path: join(artifacts, "captured-f2-draft.png"), fullPage: false, animations: "disabled" });
  const beforeStale = await db.pipelineRun.count({ where: { projectId: project.id } });
  await db.pipelineRun.update({ where: { id: sourceRunId }, data: { status: "CANCELED" } });
  await page.getByRole("button", { name: "接续F2并完成Q1", exact: true }).first().click();
  await page.waitForURL((url) => url.searchParams.get("foundationNotice") === "state-changed");
  assert.equal(await page.getByText("页面状态已更新，本次未发起新调用；请核对当前范围后再继续。", { exact: true }).isVisible(), true);
  assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), beforeStale);
  assert.equal(readFileSync(join(directory, "calls.jsonl"), "utf8"), callsBefore, "旧页面提交必须0模型调用且0新run");
  await db.pipelineRun.update({ where: { id: sourceRunId }, data: { status: "FAILED" } });
  await page.reload();
  await page.getByRole("button", { name: "接续F2并完成Q1", exact: true }).first().click();
  await page.waitForURL((url) => url.pathname === `/projects/${project.id}` && !url.search);
  const finished = await waitForRuns(db, project.id, 5, sourceRunId);
  const additions = finished.filter((run) => ![f1Run.id, completedF2.id, sourceRunId].includes(run.id));
  assert.deepEqual(additions.map((run) => run.stageCode), ["F2", "Q1"]);
  const newCalls = readFileSync(join(directory, "calls.jsonl"), "utf8").slice(callsBefore.length).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(newCalls.map((call) => `${call.stage}:${call.scope.join(",")}`), ["F2:1", "F2:2", "Q1:0", "Q1:1", "Q1:2"], "实际新worker只调用剩余F2和Q1，不重新调用F1或首片");
  const resumed = JSON.parse(additions.find((run) => run.stageCode === "F2")!.log!);
  assert.equal(resumed.calls[0].providerCallCount, 0);
  assert.deepEqual(resumed.calls[0].reusedFrom, { runId: sourceRunId, sequence: 1 });
  for (const field of ["input", "taskPrompt", "systemPrompt", "response", "startedAt", "finishedAt"]) assert.deepEqual(resumed.calls[0][field], firstCall[field], `复用不得改原${field}`);
  assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: sourceRunId } }), source);
  assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: f1Run.id } }), f1Run);
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({ where: { id: f1Snapshot.id } }), f1Snapshot);
  const exported = await readExport(context, exportUrl);
  assert.equal(exported.currentState.ready, true); assert.equal(exported.currentState.draftComplete, true); assert.equal(exported.approvals.length, 1);
  assert.equal(JSON.parse(exported.candidates.q1.at(-1)!.content).output.verdict, "READY");
  assert.ok(exported.finalOutput!.f2.assets.some((asset) => asset.name === "钥匙"));
  assert.ok(exported.finalOutput!.f1.episodes.every((episode) => episode.summary.startsWith("已优化")));
  const candidate = JSON.parse(exported.candidates.f2.at(-1)!.content).output;
  assert.equal(candidate.episodes.length, 3); assert.deepEqual(candidate.assets.find((asset: { name: string }) => asset.name === "工程测试后台总场景").appearances, []);
  await page.reload();
  const readLink = page.getByRole("link", { name: "查看最终资料", exact: true }).first();
  assert.ok(await readLink.count());
  await readLink.click();
  assert.equal(await db.pipelineRun.count({ where: { projectId: project.id, stageCode: { in: ["F1", "F2", "Q1"] } } }), 5);
  await page.screenshot({ path: join(artifacts, "completed-optimized-draft.png"), fullPage: false, animations: "disabled" });
  writeFileSync(join(artifacts, "completion-repair-export.json"), JSON.stringify(exported, null, 2));
  console.log("PASS actual continuation action/worker: captured FAILED prefix visible, F1 and source preserved, only 2 new F2 + 3 Q1 calls, Q1 edits delivered as final catalog");
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "director-foundation-e2e-"));
  const databaseUrl = `file:${join(directory, "e2e.db")}`;
  process.env.DATABASE_URL = databaseUrl;
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const artifacts = join(process.cwd(), "scripts", "tmp", `foundation-e2e-${Date.now()}`);
  let browser: Browser | null = null;
  let server: ChildProcess | null = null;
  let projectId = "";
  const projectIds = new Set<string>();
  let serverLogs = "";
  try {
    assert.ok(directory.startsWith(join(tmpdir(), "director-foundation-e2e-")));
    const executable = createFakeCli(directory);
    await migrateDatabase({ databaseUrl, schemaPath: join(process.cwd(), "prisma/schema.prisma"), quiet: true });
    await seedTestAccounts(db, PASSWORD);
    assert.equal(await db.project.count(), 0, "测试必须从全新数据库开始");
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const nextMode = process.env.FOUNDATION_E2E_USE_BUILD === "1" ? "start" : "dev";
    server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), nextMode, "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DATABASE_URL: databaseUrl, DIRECTOR_SESSION_COOKIE_NAME: COOKIE, NEXT_TELEMETRY_DISABLED: "1",
        CODEX_CLI_PATH: executable, CODEX_CLI_TIMEOUT_MS: "10000", FOUNDATION_E2E_DIRECTORY: directory,
        DEEPSEEK_API_KEY: "", DEEPSEEK_API_BASE: "https://foundation-e2e.invalid", OPENAI_API_KEY: "", OPENAI_BASE_URL: "https://foundation-e2e.invalid",
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` }
    });
    for (const output of [server.stdout, server.stderr]) output?.on("data", (chunk) => { serverLogs = `${serverLogs}${String(chunk)}`.slice(-8_000); });
    await waitForServer(baseUrl, server, () => serverLogs);
    console.log("PASS isolated SQLite + fake CLI + random localhost server");
    browser = await chromium.launch({ headless: true, ...browserOptions() });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseUrl);
    assert.equal(new URL(page.url()).pathname, "/login");
    await login(page, baseUrl, "tester01");
    const cookie = (await context.cookies()).find((item) => item.name === COOKIE);
    assert.ok(cookie?.httpOnly);
    assert.equal(cookie.sameSite, "Lax");
    assert.equal((await context.cookies()).some((item) => item.name === "director_session"), false);

    await page.goto(`${baseUrl}/projects/new`);
    await page.getByRole("tab", { name: "粘贴文本", exact: true }).click();
    await page.getByLabel("剧本正文", { exact: true }).fill(SOURCE);
    await page.getByLabel("项目名称", { exact: true }).fill("第一阶段隔离工程 QA");
    await page.locator('select[name="executionMode"]').selectOption("CLI");
    await page.getByRole("button", { name: "创建项目并开始解析" }).click();
    await page.waitForURL((url) => url.pathname !== "/projects/new" && /^\/projects\/[^/]+$/.test(url.pathname));
    projectId = new URL(page.url()).pathname.split("/")[2];
    projectIds.add(projectId);
    const exportUrl = `${baseUrl}/projects/${projectId}/foundation/export`;
    const initial = await readExport(context, exportUrl);
    assertSource(initial);
    assert.equal(initial.currentState.preprocessReady, true);
    assert.equal(initial.currentState.ready, false);
    assert.equal(await page.locator(".foundationRole.automatic em").innerText(), "已完成");
    assert.equal(await page.getByRole("button", { name: "运行 F1", exact: true }).isEnabled(), true);
    for (const code of ["F2", "Q1"]) assert.equal(await page.getByRole("button", { name: `运行 ${code}`, exact: true }).isDisabled(), true);
    assert.equal(await page.getByText("当前资料未批准", { exact: true }).count(), 1);
    assert.equal(existsSync(join(directory, "calls.jsonl")), false, "P0不得产生模型调用");
    console.log("PASS login/private cookie + paste/preface/episode 0,2/CRLF + P0 + upstream gates");

    const anonymous = await browser.newContext();
    // A valid token under the old cookie name must not authenticate this dedicated website.
    await anonymous.addCookies([{ name: "director_session", value: cookie.value, url: baseUrl }]);
    const noSession = await anonymous.request.get(exportUrl, { maxRedirects: 0 });
    assert.equal(noSession.status(), 401);
    assert.ok((await noSession.json()).error);
    const foreign = await browser.newContext();
    await login(await foreign.newPage(), baseUrl, "tester02");
    assert.equal((await foreign.request.get(exportUrl, { maxRedirects: 0, headers: await testSessionHeaders(foreign) })).status(), 404);
    await anonymous.close();
    await foreign.close();
    console.log("PASS export unauthenticated 401 + foreign-account 404 + no default-cookie crossover");

    await page.getByRole("button", { name: "开始整理全剧资料", exact: true }).first().click();
    await waitForRuns(db, projectId, 3);
    await page.reload();
    const approved = await readExport(context, exportUrl);
    assertSource(approved);
    assertEvidence(approved, 3);
    assert.equal(approved.currentState.ready, true);
    assert.equal(approved.currentState.reviewReady, true);
    assert.equal(approved.approvals.length, 1);
    assert.equal(approved.approvedEpisodePackets.length, 2);
    for (const stage of ["f1", "f2", "q1"] as const) assert.equal(approved.candidates[stage].length, 1);
    assert.equal(JSON.parse(approved.candidates.q1[0].content).output.verdict, "READY");
    const calls = readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => call.stage), ["F1", "F2", "Q1"]);
    assert.equal(await page.getByRole("heading", { name: "Q1已完成最终优化", exact: true }).count(), 1);
    assert.equal(await page.getByText("当前资料已整理", { exact: true }).count(), 1);
    assert.equal(await page.getByRole("heading", { name: "资产目录与必要变体", exact: true }).count(), 1);
    assert.equal(await page.getByRole("heading", { name: "v0.2 后续阶段尚未启用", exact: true }).count(), 1);
    assert.match(approved.targetArchitecture, /v0\.2/);
    assert.match(approved.currentTestScope, /P0.*F1.*F2.*Q1/);
    for (const run of approved.pipelineRuns) {
      const brief = JSON.parse(run.log!).calls[0].input;
      assert.equal(brief.workflow, "PRODUCTION_FOUNDATION_V3");
      assert.doesNotMatch(JSON.stringify([brief.consumer, brief.consumerQuestions]), /E[0-5]/);
    }
    assert.equal(await db.cliRoleSession.count(), 0);
    assert.equal(await db.apiRoleSession.count(), 0);
    assert.equal(await db.pipelineRun.count({ where: { stageCode: { startsWith: "E" } } }), 0);
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, "ready.png"), fullPage: false, animations: "disabled" });
    await page.locator("#foundation-assets").screenshot({ path: join(artifacts, "asset-catalog.png"), animations: "disabled" });
    await page.locator("#foundation-review").screenshot({ path: join(artifacts, "final-optimization.png"), animations: "disabled" });
    // Exercise the actual download link, not only a successful HTTP response.
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "导出第一阶段完整 JSON", exact: true }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), `foundation-${projectId}.json`);
    const downloadPath = join(artifacts, "approved-export.json");
    await download.saveAs(downloadPath);
    const downloaded: Exported = JSON.parse(readFileSync(downloadPath, "utf8"));
    assertSource(downloaded);
    assertEvidence(downloaded, 3);
    assert.equal(downloaded.currentState.approvalId, approved.currentState.approvalId);
    console.log("PASS browser/action/worker/fake CLI F1→F2→Q1: exactly 3 calls; approved packets + complete download evidence");

    writeFileSync(join(directory, "control.json"), JSON.stringify({ q1Verdict: "REPAIR" }));
    await page.getByRole("button", { name: "重跑 Q1", exact: true }).click();
    await waitForRuns(db, projectId, 4);
    await page.reload();
    const repair = await readExport(context, exportUrl);
    assertSource(repair);
    assertEvidence(repair, 4);
    assert.equal(repair.currentState.ready, true);
    assert.equal(repair.currentState.reviewReady, true);
    assert.notEqual(repair.currentState.approvalId, approved.currentState.approvalId);
    assert.equal(repair.approvals.length, 2);
    assert.equal(repair.approvals[0].id, approved.approvals[0].id, "旧批准证据不得丢失");
    assert.equal(repair.candidates.q1.length, 2);
    assert.equal(JSON.parse(repair.candidates.q1.at(-1)!.content).output.verdict, "READY");
    assert.equal(await page.getByRole("heading", { name: "Q1已完成最终优化", exact: true }).count(), 1);
    assert.equal(await page.getByText("需返修", { exact: true }).count(), 0);
    assert.ok(await page.getByRole("link", { name: "查看最终资料", exact: true }).count(), "Q1优化后直接引导读取最终资料");
    assert.deepEqual(repair.candidates.f1, approved.candidates.f1); assert.deepEqual(repair.candidates.f2, approved.candidates.f2);
    assert.ok(repair.finalOutput!.f1.episodes.every((episode) => episode.summary.startsWith("已优化")));
    assert.ok(repair.finalOutput!.f2.assets.some((asset) => asset.name === "钥匙"));
    assert.equal(await page.getByRole("button", { name: "开始整理全剧资料", exact: true }).count(), 0);
    assert.equal(await db.pipelineRun.count({ where: { stageCode: { startsWith: "E" } } }), 0);
    await page.screenshot({ path: join(artifacts, "repair.png"), fullPage: false, animations: "disabled" });
    writeFileSync(join(artifacts, "repair-export.json"), JSON.stringify(repair, null, 2));

    // Rerun after publication: replay must compare the same published identity input, not the initial empty prior.
    await page.getByRole("button", { name: "重跑 F2", exact: true }).click();
    const beforeReplayRuns = await waitForRuns(db, projectId, 5);
    const completedF2 = beforeReplayRuns.filter((run) => run.stageCode === "F2").at(-1)!;
    const completedEvidence = JSON.parse(completedF2.log!);
    assert.equal(completedEvidence.calls.length, 1);
    assert.equal(completedEvidence.calls[0].input.previousAssetKeys.length, 2);
    const callsBeforeReplay = readFileSync(join(directory, "calls.jsonl"), "utf8");
    assert.deepEqual(callsBeforeReplay.trim().split("\n").map((line) => JSON.parse(line).stage), ["F1", "F2", "Q1", "Q1", "F2"]);
    const syntheticRunId = randomUUID();
    const syntheticBatchToken = randomUUID();
    const syntheticError = "FAKE-ONLY：合成的完整响应后失败记录，仅用于浏览器离线复验测试。";
    const syntheticSource = await db.pipelineRun.create({ data: {
      ...completedF2, id: syntheticRunId, status: "FAILED", createdAt: new Date(), error: syntheticError,
      inputSummary: JSON.stringify({ ...JSON.parse(completedF2.inputSummary!), batchToken: syntheticBatchToken, workerPid: 0 }),
      outputSummary: null,
      log: JSON.stringify({ ...completedEvidence, runId: syntheticRunId, batchToken: syntheticBatchToken, error: syntheticError })
    } });
    await page.reload();
    const replayButton = page.getByRole("button", { name: "复验已有F2完整结果（不调用模型）", exact: true });
    assert.equal(await replayButton.isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "继续F2未完成分片", exact: true }).count(), 0, "全部分片已保存时不能假称仍有未完成分片");
    await replayButton.click();
    const afterReplayRuns = await waitForRuns(db, projectId, 7, syntheticRunId);
    const priorRunIds = new Set([...beforeReplayRuns.map((run) => run.id), syntheticRunId]);
    const newRuns = afterReplayRuns.filter((run) => !priorRunIds.has(run.id));
    assert.equal(newRuns.length, 1, "离线复验仅新增一次F2运行，不自动运行Q1");
    const replayRun = newRuns[0];
    assert.equal(replayRun.stageCode, "F2");
    assert.equal(replayRun.status, "SUCCEEDED");
    assert.equal(readFileSync(join(directory, "calls.jsonl"), "utf8"), callsBeforeReplay, "离线复验不得新增任何fake模型调用");
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: syntheticRunId } }), syntheticSource, "合成失败来源须逐字段保留");
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: completedF2.id } }), completedF2, "原成功F2运行不得改写为失败或复验");
    const replayEvidence = JSON.parse(replayRun.log!);
    const replaySummary = JSON.parse(replayRun.inputSummary!);
    assert.deepEqual(replaySummary.recovery, { resumeFromRunId: syntheticRunId, replayOnly: true });
    assert.equal(replaySummary.providerCalls, 0);
    assert.equal(replaySummary.reusedCalls, 1);
    assert.equal(replayEvidence.calls.length, 1);
    const replayCall = replayEvidence.calls[0];
    assert.equal(replayCall.providerCallCount, 0);
    assert.deepEqual(replayCall.reusedFrom, { runId: syntheticRunId, sequence: 1 });
    assert.equal(replayCall.revalidatedUnder.protocolVersion, replayEvidence.protocolVersion);
    for (const field of ["systemPrompt", "taskPrompt", "input", "response", "startedAt", "finishedAt"]) {
      assert.deepEqual(replayCall[field], completedEvidence.calls[0][field], `复验须保留原${field}`);
    }
    await page.reload();
    const replayed = await readExport(context, exportUrl);
    assertSource(replayed);
    assert.equal(replayed.currentState.ready, false);
    assert.equal(replayed.currentState.reviewReady, false);
    assert.equal(replayed.currentState.approvalId, null);
    assert.equal(replayed.currentState.assetsReady, true);
    assert.equal(replayed.candidates.f2.length, 3);
    assert.equal(JSON.parse(replayed.candidates.f2.at(-1)!.content).runId, replayRun.id, "新候选须经新运行追溯到合成FAILED来源");
    assert.deepEqual(replayed.candidates.f1, repair.candidates.f1, "F1候选不得随F2复验改变");
    assert.deepEqual(replayed.candidates.q1, repair.candidates.q1, "F2复验不得代跑Q1");
    for (const stage of ["F1", "Q1"]) assert.deepEqual(replayed.pipelineRuns.filter((run) => run.stageCode === stage), repair.pipelineRuns.filter((run) => run.stageCode === stage));
    assert.equal(replayed.approvals.length, 2);
    assert.deepEqual(replayed.approvals, repair.approvals);
    assert.deepEqual(replayed.approvedEpisodePackets, repair.approvedEpisodePackets);
    assert.equal(await page.getByText("当前版本已批准", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "复验已有F2完整结果（不调用模型）", exact: true }).count(), 0, "已有新成功稿后不得再推荐旧复验");
    assert.equal(await page.getByRole("button", { name: "继续F2未完成分片", exact: true }).count(), 0);
    await page.screenshot({ path: join(artifacts, "f2-replay.png"), fullPage: false, animations: "disabled" });
    writeFileSync(join(artifacts, "f2-replay-export.json"), JSON.stringify(replayed, null, 2));
    console.log("PASS browser/action/worker F2 offline replay: 0 new calls, preserved synthetic FAILED source/F1/old approval, no automatic Q1");

    // Synthetic display fixture only: the latest Q1 predates the new F2 and carries a long old upstream error.
    const oldQ1 = beforeReplayRuns.filter((run) => run.stageCode === "Q1").at(-1)!;
    const oldError = `FAKE-ONLY：因旧F1失败停止：${Array.from({ length: 84 }, (_, index) => `episodes.number.${index} 须为大于等于0的整数`).join("；")}`;
    await db.pipelineRun.update({ where: { id: oldQ1.id }, data: { status: "CANCELED", error: oldError } });
    await page.reload();
    // Measure settled layout, not the route animation's temporary translateX(28px).
    await page.locator(".appMain").evaluate(async (el) => { await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {}))); });
    const collapsedWidth = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    assert.ok(collapsedWidth.content <= collapsedWidth.viewport + 1, `长历史错误撑宽了页面：${JSON.stringify(collapsedWidth)}`);
    const historicalError = page.locator("details.foundationRunError");
    assert.equal(await historicalError.count(), 1);
    assert.equal(await historicalError.getAttribute("open"), null);
    assert.equal(await historicalError.locator("time").getAttribute("datetime"), oldQ1.createdAt.toISOString());
    await page.getByText("Q1 · 历史运行错误", { exact: true }).click();
    assert.equal(await historicalError.locator(".roleRunError").innerText(), oldError, "折叠展示不删错误全文");
    for (const width of [1280, 1470]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      assert.ok(bounds.content <= bounds.viewport + 1, `展开长错误后不应出现横向溢出：${JSON.stringify(bounds)}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: join(artifacts, "history-error.png"), fullPage: false, animations: "disabled" });
    assert.equal(readFileSync(join(directory, "calls.jsonl"), "utf8"), callsBeforeReplay, "查看历史错误不产生调用");
    console.log("PASS long historical error folds with its timestamp, retains full text and stays within desktop viewport when expanded");

    await page.goto(`${baseUrl}/projects/${projectId}/episodes/${repair.project.episodes[0].id}`);
    assert.equal(await page.getByRole("heading", { name: "v0.2 后续阶段尚未启用", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: /运行 E[0-5]|生成本集|准备本集/ }).count(), 0);
    assert.equal(await db.pipelineRun.count({ where: { stageCode: { startsWith: "E" } } }), 0);
    assert.deepEqual(pageErrors, []);
    console.log("PASS Q1 directly optimizes and publishes final data without rewriting original F1/F2 or prior result history");
    await verifyCapturedPrefixContinuation(db, page, context, baseUrl, directory, artifacts, projectId, projectIds);
    await verifyUnknownRetryConfirmation(db, page, baseUrl, directory, projectId, projectIds);
    assert.deepEqual(pageErrors, []);
    console.log(`foundation end-to-end verification passed; screenshots and fake-only exports: ${artifacts}`);
  } catch (error) {
    if (serverLogs) console.error(serverLogs);
    throw error;
  } finally {
    await browser?.close();
    for (const testProjectId of projectIds) {
      const runs = await db.pipelineRun.findMany({ where: { projectId: testProjectId, stageCode: { in: ["F1", "F2", "Q1"] } } }).catch(() => []);
      const workers = new Set(runs.map((run) => Number(JSON.parse(run.inputSummary || "{}").workerPid)).filter((pid) => Number.isInteger(pid) && pid > 0));
      for (const pid of workers) {
        try {
          const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
          if (command.includes("run-project-foundation.ts") && command.includes(testProjectId)) process.kill(-pid, "SIGTERM");
        } catch { /* Only this test's verified worker process groups may be stopped. */ }
      }
    }
    if (server) await stopServer(server);
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
    console.log("CLEANUP test browser, server, worker groups and temporary SQLite/fake directory");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
