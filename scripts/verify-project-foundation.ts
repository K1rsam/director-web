import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FoundationStageRunner } from "@/lib/project-foundation";

// Always isolate the database, including when the caller supplies --env-file.
const scratch = mkdtempSync(path.join(tmpdir(), "foundation-core-"));
const databaseUrl = `file:${path.join(scratch, "test.db")}`;
process.env.DATABASE_URL = databaseUrl;
copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], {
  cwd: scratch, env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "info" }, stdio: "pipe"
});
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

async function main() {
  const core = await import("@/lib/project-foundation");
  const contracts = await import("@/lib/project-foundation-contracts");
  assert.deepEqual(contracts.PROJECT_FOUNDATION_STAGES.map((stage) => stage.code), ["F1", "F2", "Q1"], "第一阶段必须包含两个作者岗和独立Q1");
  const stateApi = await import("@/lib/foundation-state");
  const { preprocessProject } = await import("@/lib/project-preprocess");
  type Stage = "F1" | "F2" | "Q1";
  let checks = 0;
  const source = [{ number: 1, title: "第一集", content: "1-1\r\n客厅 日 内\r\n甲：你看。  \r\n" }, { number: 2, title: "第二集", content: "2-1\n教室 日 内\n甲走进教室。\n乙：迟到了。" }];
  async function project(episodes = source) {
    const record = await db.project.create({ data: { title: "__isolated_foundation__", style: "3D漫剧", aspectRatio: "16:9", executionMode: "CLI", episodes: { create: episodes } }, include: { episodes: true } });
    await preprocessProject(record.id, db);
    return record;
  }
  async function queue(projectId: string, stages: Stage[] = ["F1", "F2", "Q1"], provider = "API", recovery?: { resumeFromRunId?: string; replayOnly?: boolean }) {
    const token = randomUUID();
    const input = await stateApi.loadFoundationInputs(projectId, db);
    for (const stageCode of stages) await db.pipelineRun.create({ data: { projectId, stageCode, roleName: stageCode, provider, status: "QUEUED", inputSummary: JSON.stringify({ batchToken: token, provider, foundation: true, sourceVersion: input.sourceVersion, inputVersion: input.inputVersion, methodVersion: input.methodVersions[stageCode], workerPid: 98765, ...(recovery ? { recovery } : {}) }) } });
    return token;
  }
  const ref = (episode: number) => ({ episode, startLine: 1, endLine: 1 });
  function output(stage: Stage, scope: number[], verdict = "READY"): Record<string, unknown> {
    if (stage === "F1") return { coverage: scope, overview: "BACKEND_OVERVIEW_FUTURE_MARKER", episodes: scope.map((number) => ({ number, summary: `第${number}集理解`, context: `F1-CURRENT-${number}`, sourceSelections: [{ ...ref(number), purpose: "本集开场定位" }] })), issues: [] };
    if (stage === "F2") return { coverage: scope, assets: [{ key: "person-jia", name: "甲", type: "CH", aliases: ["甲同学", "BACKEND_ALIAS_FUTURE_MARKER"], description: "BACKEND_IDENTITY_FUTURE_MARKER", sourceRefs: scope.map(ref) }], episodes: scope.map((number) => ({ number, context: `F2-CURRENT-${number}`, uses: [{ key: "person-jia", presence: "ONSTAGE", state: `本集${number}状态`, sourceRefs: [ref(number)] }] })), issues: [] };
    return { coverage: scope, verdict, summary: "独立核对本范围的供给与身份稿", issues: verdict === "READY" ? [] : [{ severity: verdict === "BLOCKED" ? "BLOCKER" : "MAJOR", owner: "F2", coordinate: "assets.person-jia", problem: "身份解释需人工复核", sourceRefs: [ref(scope[0])] }] };
  }
  const parse = (prompt: string) => JSON.parse(prompt.split("INPUT_JSON:").at(-1)!.trim());
  function assertNumberedSource(value: unknown, expected: Array<{ number: number; title: string | null; content: string }>, version: string) {
    assert.ok(contracts.isRecord(value));
    assert.equal(value.schema, "NUMBERED_SOURCE_V1"); assert.equal(value.version, version);
    assert.ok(Array.isArray(value.episodes));
    assert.deepEqual(value.episodes.map((episode: { number: number }) => episode.number), expected.map((episode) => episode.number));
    const expectedIndex = expected.length ? contracts.buildSourceIndex(expected).episodes : [];
    for (const [position, episode] of value.episodes.entries()) {
      assert.equal(episode.title, expected[position].title);
      assert.equal(episode.lineCount, expectedIndex[position].lineCount);
      assert.ok(Array.isArray(episode.lines)); assert.equal(episode.lines.length, episode.lineCount);
      const text = episode.lines.map((line: unknown, index: number) => {
        assert.ok(Array.isArray(line)); assert.equal(line.length, 2);
        assert.equal(line[0], index + 1); assert.equal(typeof line[1], "string"); return line[1];
      }).join("");
      assert.equal(text, expected[position].content, "编号原文须按行逐字还原，不能trim、改换行或漏末行");
      assert.equal("content" in episode, false, "编号原文不重复携带content副本");
    }
  }
  const runner: FoundationStageRunner = async (stage, prompt) => ({ data: output(stage, parse(prompt).scope), rawOutput: "RAW_FULL_OUTPUT", sessionId: null, stdout: "events", stderr: "" });
  const execute = (id: string, token: string, stageRunner = runner, singleStage?: Stage) => core.executeProjectFoundation(id, token, { stageRunner, singleStage, db });
  async function check(name: string, run: () => Promise<void>) {
    if (process.argv[2] && !name.includes(process.argv[2])) return;
    await run(); checks++; console.log(`PASS ${name}`);
  }
  const workingLabels = [
    { key: "lin-manager", label: "林管理", line: 3, presence: "ONSTAGE", state: "林姓管理人员抬起头。" },
    { key: "dark-shadow", label: "黑色影子", line: 17, presence: "ONSTAGE", state: "乌黑身影沿墙滑过，未确认具体身份。" },
    { key: "hoarse-voice", label: "沙哑VO", line: 40, presence: "PROFILE", state: "仅画外嘶哑声音，不与黑影自动合并。" }
  ];
  const workingRef = (number: number, line: number) => ({ episode: number, startLine: line, endLine: line });
  function workingEpisode(number = 7, oversized = false) {
    const lines = Array.from({ length: 45 }, (_, index) => index === 0 ? `${number}-1 夜 内`
      : index === 2 ? "姓林的管理人员抬起头。" : index === 16 ? "一团乌黑身影沿墙滑过。"
        : index === 39 ? "画外声音（嗓音嘶哑）：别回头。" : index === 44 ? `甲仍站在门边。  ${oversized ? "源".repeat(24_001) : ""}` : `场内静默记号${index + 1}。`);
    return { number, title: "合成工作标签场景", content: lines.join("\r\n") };
  }
  function workingWire(number = 7): Record<string, unknown> {
    return {
      coverage: [number],
      assets: workingLabels.map((item) => ({ key: item.key, name: item.label, type: "CH", description: "合成工作识别标签，不表示真实身份关系已核实。", sourceRefs: [workingRef(number, item.line)] })),
      episodes: [{ number, context: "当前段工作标签；三个主体不自动归并。", uses: workingLabels.map((item) => ({ key: item.key, presence: item.presence, state: item.state, sourceRefs: [workingRef(number, item.line)], sourceName: item.label, sourceNameMatch: "LITERAL" })) }]
    };
  }

  await check("normal working labels with omitted issues reach Q1 as nonliteral labels and may be independently approved", async () => {
    const episode = workingEpisode(); const p = await project([episode]); const seen: Stage[] = [];
    await execute(p.id, await queue(p.id), async (stage, prompt) => {
      const input = parse(prompt); seen.push(stage);
      if (stage === "Q1") {
        assertNumberedSource(input.source, [episode], input.sourceVersion);
        assert.match(input.reviewScopeNote, /工作|字面|称谓/);
        for (const item of workingLabels) {
          const asset = input.candidates.f2.output.assets.find((asset: { key: string }) => asset.key === item.key);
          assert.equal(asset.appearances[0].sourceName, item.label);
          assert.equal(asset.appearances[0].sourceNameMatch, "NON_LITERAL", "不能相信模型自行填写的LITERAL标记");
          assert.deepEqual(asset.appearances[0].sourceRefs, [workingRef(7, item.line)]);
          const identity = input.episodePackets[0].identities.find((identity: { key: string }) => identity.key === item.key);
          assert.equal(identity.name, item.label); assert.equal(identity.nameBasis, "WORKING_LABEL");
          assert.deepEqual(identity.aliases, [], "未登记的工作标签不能自动变成别名");
        }
      }
      const data = stage === "F2" ? workingWire() : output(stage, input.scope);
      if (stage === "F2") assert.deepEqual(Object.keys(data).sort(), ["assets", "coverage", "episodes"]);
      return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic working-label calls", stderr: "" };
    });
    assert.deepEqual(seen, ["F1", "F2", "Q1"]);
    const state = await stateApi.getFoundationState(p.id, db); assert.equal(state.ready, true);
    assert.deepEqual(state.candidates.f2!.output.issues, []);
    const call = JSON.parse((await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f2!.runId } })).log!).calls[0];
    assert.deepEqual(Object.keys(call.response.data).sort(), ["assets", "coverage", "episodes"]);
    assert.deepEqual(JSON.parse(call.response.rawOutput), call.response.data);
    assert.ok(call.response.data.episodes[0].uses.every((use: { sourceNameMatch: string }) => use.sourceNameMatch === "LITERAL"), "原响应中的自填标记保留，程序只改规范化候选");
    const packet = await stateApi.readApprovedEpisodeFoundation(p.id, 7, db);
    assert.equal(packet.source.content, episode.content);
    for (const item of workingLabels) {
      const identity = packet.identities.find((identity) => identity.key === item.key)! as unknown as Record<string, unknown>;
      assert.equal(identity.name, item.label); assert.equal(identity.nameBasis, "WORKING_LABEL");
    }
    assert.equal(await db.asset.count({ where: { projectId: p.id } }), 3);
  });

  await check("future names and AI-only naming explanations still reach a real non-ready Q1 gate without publication", async () => {
    for (const kind of ["future-name", "AI-explanation"]) {
      const current = workingEpisode(7); const future = workingEpisode(8);
      future.content = future.content.replace("一团乌黑身影沿墙滑过。", "本集才揭示影子的姓名为未来影王。");
      const p = await project([current, future]);
      const label = kind === "future-name" ? "未来影王" : "AI_ONLY_LABEL";
      const problem = kind === "future-name" ? "第7集提前使用第8集才揭示的真实姓名，必须退回当前源称谓。" : "AI解释不能自证当前原文身份，须修正来源与消费者名称。";
      let reviewed = false;
      await execute(p.id, await queue(p.id), async (stage, prompt) => {
        const input = parse(prompt); let data = output(stage, input.scope);
        if (stage === "F1") {
          const first = (data.episodes as Array<Record<string, unknown>>).find((episode) => episode.number === 7)!;
          first.context = `AI_ONLY_LABEL只是生成解释，不是原文；第8集后揭示信息不得前置。`;
          first.sourceSelections = [{ ...workingRef(8, 17), purpose: "核对后续揭示边界，不作为本集已知姓名" }];
        }
        if (stage === "F2") {
          data = workingWire(7); data.coverage = input.scope;
          data.episodes = input.scope.flatMap((number: number) => workingWire(number).episodes as unknown[]);
          const episodes = data.episodes as Array<{ number: number; uses: Array<Record<string, unknown>> }>;
          episodes.find((episode) => episode.number === 7)!.uses.find((use) => use.key === "dark-shadow")!.sourceName = label;
          if (kind === "future-name") episodes.find((episode) => episode.number === 8)!.uses.find((use) => use.key === "dark-shadow")!.sourceName = label;
        }
        if (stage === "Q1") {
          const packet = input.episodePackets.find((packet: { episode: number }) => packet.episode === 7);
          const identity = packet.identities.find((identity: { key: string }) => identity.key === "dark-shadow");
          assert.equal(identity.name, label); assert.equal(identity.nameBasis, "WORKING_LABEL");
          assert.equal(identity.appearances[0].sourceNameMatch, "NON_LITERAL");
          assert.ok(packet.f1Context.includes("AI_ONLY_LABEL"), "程序不得偷偷删改作者解释伪装内容已通过");
          assertNumberedSource(input.source, [current, future], input.sourceVersion);
          data = { coverage: input.scope, verdict: "REPAIR", summary: "合成独审：语义命名风险未清，不能发布", issues: [{ severity: "MAJOR", owner: "F2", coordinate: "episodes.7.uses.dark-shadow.sourceName", problem, sourceRefs: [workingRef(7, 17), workingRef(8, 17)] }] };
          reviewed = true;
        }
        return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic semantic review calls", stderr: "" };
      });
      assert.equal(reviewed, true);
      const state = await stateApi.getFoundationState(p.id, db);
      assert.equal(state.assetsReady, true); assert.equal(state.dataReady, true);
      assert.equal(state.review!.output.verdict, "REPAIR"); assert.equal(state.ready, false); assert.equal(state.reviewReady, false);
      assert.ok(state.review!.output.issues.some((issue) => issue.problem === problem));
      assert.equal(state.candidates.f2!.output.assets.find((asset) => asset.key === "dark-shadow")!.appearances.find((appearance) => appearance.episode === 7)!.sourceName, label);
      assert.equal((await db.pipelineRun.findUniqueOrThrow({ where: { id: state.review!.runId } })).status, "SUCCEEDED", "真实非READY判断不是运行异常，也不能被改成READY");
      assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_APPROVED" } }), 0);
    }
  });

  await check("auxiliary nil combinations normalize across all roles while known-key uses retain only newly sourced states", async () => {
    const p = await project([7, 8, 9].map((number) => workingEpisode(number, true)));
    const captured = new Map<string, string>(); const counts = { F1: 0, F2: 0, Q1: 0 };
    const freeze = <T,>(value: T): T => {
      if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
      return value;
    };
    await execute(p.id, await queue(p.id), async (stage, prompt, call) => {
      const input = parse(prompt); const number = input.scope[0]; counts[stage]++;
      let data = output(stage, input.scope);
      if (stage === "F1") {
        if (call.chunkIndex === 1) delete data.issues; else data.issues = null;
        for (const episode of data.episodes as Array<Record<string, unknown>>) { episode.f2Notes = null; episode.sourceSelections = null; }
      }
      if (stage === "F2") {
        data = workingWire(number);
        const uses = (data.episodes as Array<{ uses: Array<Record<string, unknown>> }>)[0].uses;
        for (const use of uses) { use.sourceName = null; use.purpose = null; use.state = `仅第${number}集新交状态，禁止从7集回填。`; }
        if (call.chunkIndex === 1) {
          for (const asset of data.assets as Array<Record<string, unknown>>) { asset.aliases = asset.key === "lin-manager" ? ["管理人员"] : null; asset.descriptionVariants = null; }
        } else {
          assert.equal(input.prior.registry.length, 3);
          assert.ok(input.prior.registry.every((asset: Record<string, unknown>) => !("appearances" in asset)));
          data.issues = null;
          data.assets = call.chunkIndex === 2 ? null : workingLabels.map((item) => ({ key: item.key, name: null, type: null, description: null, sourceRefs: null, aliases: null, descriptionVariants: null }));
          if (call.chunkIndex === 3) {
            uses[2] = { key: "hoarse-voice", presence: "BACKGROUND", purpose: "本集仅以前集声音作为警戒背景，不声称再次发声。", sourceRefs: [workingRef(8, 40)], sourceName: null, state: null };
            data.issues = [{ severity: "MINOR", owner: "F2", coordinate: "unanchored.fixture", problem: "合成未定位问题仍须保留", sourceRefs: null }];
          }
        }
      }
      if (stage === "Q1") {
        assert.ok(input.unscopedIssues.some((issue: { problem: string; sourceRefs: unknown[]; severity: string }) => issue.problem === "合成未定位问题仍须保留" && !issue.sourceRefs.length && issue.severity === "MINOR"));
        if (call.chunkIndex % 2) delete data.issues; else data.issues = null;
      }
      const rawOutput = JSON.stringify(data); captured.set(`${stage}:${call.chunkIndex}`, rawOutput);
      return { data: freeze(data), rawOutput, sessionId: null, stdout: "synthetic auxiliary-nil calls", stderr: "" };
    });
    assert.deepEqual(counts, { F1: 3, F2: 3, Q1: 3 });
    const state = await stateApi.getFoundationState(p.id, db); assert.equal(state.ready, true);
    assert.equal(state.dataReady, true); assert.deepEqual(state.candidates.f1!.output.issues, []);
    assert.ok(state.candidates.f1!.output.episodes.every((episode) => !episode.sourceSelections.length && !("f2Notes" in episode)));
    const assets = state.candidates.f2!.output.assets;
    for (const asset of assets) {
      assert.ok(asset.description.length > 0); assert.equal(asset.type, "CH");
      assert.deepEqual(asset.appearances.map((appearance) => appearance.episode), asset.key === "hoarse-voice" ? [7, 8] : [7, 8, 9]);
      assert.ok(asset.appearances.every((appearance) => appearance.state.startsWith(`仅第${appearance.episode}集`) && appearance.sourceRefs.every((ref) => ref.episode === appearance.episode)));
    }
    assert.deepEqual(assets.find((asset) => asset.key === "lin-manager")!.aliases, ["管理人员"], "nil增量不清空已登记别名");
    assert.deepEqual(state.candidates.f2!.output.issues[0].sourceRefs, []);
    const packet = await stateApi.readApprovedEpisodeFoundation(p.id, 9, db);
    const voice = packet.identities.find((identity) => identity.key === "hoarse-voice")! as unknown as Record<string, unknown>;
    assert.equal(voice.nameBasis, "REGISTERED_IDENTITY"); assert.deepEqual(voice.appearances, []);
    assert.deepEqual(packet.backgroundRefs![0].sourceRefs, [workingRef(8, 40)]);
    for (const run of await db.pipelineRun.findMany({ where: { projectId: p.id } })) {
      for (const call of JSON.parse(run.log!).calls) {
        assert.equal(call.response.rawOutput, captured.get(`${run.stageCode}:${call.sequence}`));
        assert.equal(JSON.stringify(call.response.data), call.response.rawOutput, "nil或省略只在规范化视图默认，不能改写原响应");
      }
    }
  });

  await check("auxiliary defaults never swallow non-nil bad types primary omissions or broken fact references", async () => {
    const cases: Array<{ name: string; delayed?: boolean; mutate: (data: any) => void }> = [
      { name: "issues-object", mutate: (data) => { data.issues = {}; } },
      { name: "assets-object", mutate: (data) => { data.assets = {}; } },
      { name: "aliases-string", mutate: (data) => { data.assets[0].aliases = "别名不是数组"; } },
      { name: "variants-object", mutate: (data) => { data.assets[0].descriptionVariants = {}; } },
      { name: "sourceName-number", mutate: (data) => { data.episodes[0].uses[0].sourceName = 7; } },
      { name: "new-name-object", mutate: (data) => { data.assets[0].name = {}; } },
      { name: "new-type-invalid", mutate: (data) => { data.assets[0].type = "UNKNOWN"; } },
      { name: "new-description-object", mutate: (data) => { data.assets[0].description = {}; } },
      { name: "issue-refs-object", mutate: (data) => { data.issues = [{ severity: "MINOR", owner: "F2", coordinate: "fixture", problem: "有问题但refs错型", sourceRefs: {} }]; } },
      { name: "coverage-missing", mutate: (data) => { delete data.coverage; } },
      { name: "coverage-null", mutate: (data) => { data.coverage = null; } },
      { name: "episodes-missing", mutate: (data) => { delete data.episodes; } },
      { name: "episodes-null", mutate: (data) => { data.episodes = null; } },
      { name: "uses-missing", mutate: (data) => { delete data.episodes[0].uses; } },
      { name: "uses-null", mutate: (data) => { data.episodes[0].uses = null; } },
      { name: "state-null", mutate: (data) => { data.episodes[0].uses[0].state = null; } },
      { name: "state-empty", mutate: (data) => { data.episodes[0].uses[0].state = " "; } },
      { name: "state-refs-null", mutate: (data) => { data.episodes[0].uses[0].sourceRefs = null; } },
      { name: "state-refs-empty", mutate: (data) => { data.episodes[0].uses[0].sourceRefs = []; } },
      { name: "refs-overflow", mutate: (data) => { data.episodes[0].uses[0].sourceRefs = [workingRef(7, 99)]; } },
      { name: "new-identity-refs-null", mutate: (data) => { data.assets[0].sourceRefs = null; } },
      { name: "new-variant-refs-null", mutate: (data) => { data.assets[0].descriptionVariants = [{ text: "新增说明", sourceRefs: null }]; } },
      { name: "unknown-key", mutate: (data) => { data.episodes[0].uses[0].key = "never-registered"; } },
      { name: "background-purpose-null", mutate: (data) => { const use = data.episodes[0].uses[0]; use.presence = "BACKGROUND"; delete use.state; use.purpose = null; } },
      { name: "background-refs-null", mutate: (data) => { const use = data.episodes[0].uses[0]; use.presence = "BACKGROUND"; delete use.state; use.purpose = "仅作为背景"; use.sourceRefs = null; } },
      { name: "changed-known-type", delayed: true, mutate: (data) => { data.assets[0].type = "PROP"; } },
      { name: "wrong-episode-state-refs", delayed: true, mutate: (data) => { data.episodes[0].uses[0].sourceRefs = [workingRef(7, 3)]; } }
    ];
    for (const test of cases) {
      const p = await project(test.delayed ? [workingEpisode(7, true), workingEpisode(8)] : [workingEpisode()]);
      let f2Calls = 0; let q1Calls = 0; let invalidRaw = "";
      const token = await queue(p.id);
      await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
        const input = parse(prompt); const data = stage === "F2" ? workingWire(input.scope[0]) : output(stage, input.scope);
        if (stage === "F2") {
          f2Calls++;
          if (!test.delayed || call.chunkIndex === 2) { test.mutate(data); invalidRaw = JSON.stringify(data); }
        }
        if (stage === "Q1") q1Calls++;
        return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic strict-boundary calls", stderr: "" };
      }), contracts.FoundationContractError, test.name);
      assert.equal(f2Calls, test.delayed ? 2 : 1, test.name); assert.equal(q1Calls, 0, test.name);
      const failed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" } });
      assert.equal(failed.status, "FAILED", test.name);
      const call = JSON.parse(failed.log!).calls.at(-1);
      assert.equal(call.response.rawOutput, invalidRaw, test.name); assert.equal(JSON.stringify(call.response.data), invalidRaw, test.name);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: { in: ["FOUNDATION_F2", "FOUNDATION_Q1", "FOUNDATION_APPROVED"] } } }), 0, test.name);
      assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0, test.name);
    }
  });

  await check("non-ready Q1 still requires actionable issues and READY cannot contain major issues after nil defaults", async () => {
    for (const verdict of ["REPAIR", "BLOCKED", "READY"]) {
      for (const missing of verdict === "READY" ? ["major"] : ["omitted", "null", "empty"]) {
        const p = await project([workingEpisode()]); let q1Calls = 0;
        const token = await queue(p.id);
        await assert.rejects(() => execute(p.id, token, async (stage, prompt) => {
          const input = parse(prompt); const data = stage === "F2" ? workingWire() : output(stage, input.scope);
          if (stage === "Q1") {
            q1Calls++; data.verdict = verdict;
            if (missing === "omitted") delete data.issues;
            else if (missing === "null") data.issues = null;
            else if (missing === "empty") data.issues = [];
            else data.issues = [{ severity: "MAJOR", owner: "F2", coordinate: "episodes.7.naming", problem: "重大身份关系未清，不能同时READY", sourceRefs: [workingRef(7, 17)] }];
          }
          return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic Q1-verdict guard", stderr: "" };
        }), contracts.FoundationContractError);
        assert.equal(q1Calls, 1);
        const run = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "Q1" } });
        assert.equal(run.status, "FAILED");
        const call = JSON.parse(run.log!).calls[0]; assert.equal(call.response.data.verdict, verdict);
        assert.deepEqual(JSON.parse(call.response.rawOutput), call.response.data);
        assert.equal((await stateApi.getFoundationState(p.id, db)).ready, false);
        assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0);
        assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_APPROVED" } }), 0);
      }
    }
  });

  await check("F2-only protocol repair and new Q1 keep the successful three-call F1 evidence and common input unchanged", async () => {
    const p = await project([7, 8, 9].map((number) => workingEpisode(number, true)));
    await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
    const originalState = await stateApi.getFoundationState(p.id, db);
    const f1Snapshot = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: originalState.candidates.f1!.id } });
    const f1Run = await db.pipelineRun.findUniqueOrThrow({ where: { id: originalState.candidates.f1!.runId } });
    assert.equal(JSON.parse(f1Run.log!).calls.length, 3);
    const counts = { F1: 0, F2: 0, Q1: 0 };
    const later: FoundationStageRunner = async (stage, prompt) => {
      counts[stage]++; assert.notEqual(stage, "F1", "F2修复不能偷偷重新执行成功F1");
      const input = parse(prompt); const data = stage === "F2" ? workingWire(input.scope[0]) : output(stage, input.scope);
      return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic retained-F1 calls", stderr: "" };
    };
    await execute(p.id, await queue(p.id, ["F2"]), later, "F2");
    await execute(p.id, await queue(p.id, ["Q1"]), later, "Q1");
    const approved = await stateApi.getFoundationState(p.id, db); assert.equal(approved.ready, true);
    const oldQ1 = await db.pipelineRun.findUniqueOrThrow({ where: { id: approved.review!.runId } });
    const oldF2 = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: approved.candidates.f2!.id } });
    await db.sceneSnapshot.update({ where: { id: oldF2.id }, data: { content: JSON.stringify({ ...JSON.parse(oldF2.content), protocolVersion: "synthetic-previous-F2-only-protocol" }) } });
    const outdated = await stateApi.getFoundationState(p.id, db);
    assert.equal(outdated.planningReady, true); assert.equal(outdated.assetsReady, false); assert.equal(outdated.ready, false);
    assert.equal(outdated.inputVersion, originalState.inputVersion);
    await execute(p.id, await queue(p.id, ["F2"]), later, "F2");
    const newF2 = await stateApi.getFoundationState(p.id, db);
    assert.equal(newF2.assetsReady, true); assert.equal(newF2.ready, false); assert.equal(newF2.reviewReady, false);
    assert.notEqual(newF2.candidates.f2!.id, oldF2.id); assert.equal(counts.Q1, 3, "新F2不代跑Q1，也不能沿用旧Q1批准");
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: oldQ1.id } }), oldQ1, "旧Q1原结论和证据保留不改");
    await execute(p.id, await queue(p.id, ["Q1"]), later, "Q1");
    const final = await stateApi.getFoundationState(p.id, db); assert.equal(final.ready, true);
    assert.equal(final.review!.upstreamSnapshotIds.f2, final.candidates.f2!.id);
    assert.equal(final.inputVersion, originalState.inputVersion); assert.equal(final.sourceVersion, originalState.sourceVersion);
    assert.deepEqual(counts, { F1: 0, F2: 6, Q1: 6 });
    assert.equal(await db.pipelineRun.count({ where: { projectId: p.id, stageCode: "F1" } }), 1);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: f1Run.id } }), f1Run);
    assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({ where: { id: f1Snapshot.id } }), f1Snapshot);
  });

  await check("empty or invalid source is explicit nonready state, not a page error", async () => {
    for (const invalid of [false, true]) {
      const p = await db.project.create({ data: { title: "__no_valid_source__", ...(invalid ? { episodes: { create: { number: -1, content: "bad" } } } : {}) } });
      const state = await stateApi.getFoundationState(p.id, db);
      assert.equal(state.preprocessReady, false); assert.equal(state.ready, false);
      assert.match(state.message, /原文|源/);
    }
  });

  await check("second F1 batch receives exact numbered predecessor without expanding coverage", async () => {
    const lines27 = Array.from({ length: 71 }, (_, index) => index === 0 ? `\uFEFF27-1 甲 ${"源".repeat(24_001)}\r\n`
      : index === 1 ? "\r\n" : index === 70 ? "甲：第71行，末尾空格保留。  " : `甲：第${index + 1}行。${index % 2 ? "\r\n" : "\n"}`);
    const episodes = [
      { number: 27, title: "合成前接集", content: lines27.join("") },
      { number: 28, title: "合成本批集", content: "28-1\r\n甲：接续第27集。\r\n甲：本集原句。  \r\n" }
    ];
    const p = await project(episodes); const seen = { F1: 0, F2: 0, Q1: 0 };
    const sourceIndex = contracts.buildSourceIndex(episodes);
    const whole = { episode: 27, wholeEpisode: true, purpose: "合成测试：需完整前接集核对连续因果" };
    const canonical = { episode: 27, startLine: 1, endLine: 71, purpose: whole.purpose };
    let f2WholeSource = "";
    await execute(p.id, await queue(p.id), async (stage, prompt, call) => {
      const input = parse(prompt); seen[stage]++;
      if (stage === "F1" && call.chunkIndex === 2) {
        assert.equal(input.precedingSource?.schema, "NUMBERED_SOURCE_V1", "第二批必须实际收到直接前接集的编号原文，不能只收到prior解释");
        assert.equal(input.precedingSource.version, input.sourceVersion);
        assert.deepEqual(input.precedingSource.episodes.map((episode: { number: number }) => episode.number), [27]);
        const previous = input.precedingSource.episodes[0];
        assert.equal(previous.lineCount, 71); assert.equal(previous.lines.length, 71);
        assert.deepEqual(previous.lines, lines27.map((text, index) => [index + 1, text]));
        assert.equal(previous.lines.map((line: [number, string]) => line[1]).join(""), episodes[0].content);
        assert.equal("content" in previous, false, "编号原文不能再附一份无编号content副本");
        assert.deepEqual(input.scope, [28]); assert.deepEqual(input.targetEpisodes, [28]);
        assert.deepEqual(input.source.episodes.map((episode: { number: number }) => episode.number), [28]);
        assertNumberedSource(input.source, [episodes[1]], input.sourceVersion);
        assertNumberedSource(input.precedingSource, [episodes[0]], input.sourceVersion);
        assert.deepEqual(input.sourceCatalog, sourceIndex.episodes.map(({ number, lineCount }) => ({ number, lineCount })), "目录只有真实编号和行数，不假称已读全项目原文");
      }
      if (stage === "F2" && call.chunkIndex === 2) {
        assert.deepEqual(input.f1.episodes[0].sourceSelections, [canonical]);
        const selection = input.f1.selectedSource[0].selections[0];
        assert.equal(selection.startLine, 1); assert.equal(selection.endLine, 71);
        assert.equal(selection.content, episodes[0].content); f2WholeSource = selection.content;
      }
      const data = output(stage, input.scope);
      if (stage === "F1" && call.chunkIndex === 2) (data.episodes as Array<Record<string, unknown>>)[0].sourceSelections = [whole];
      return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic numbered-source events", stderr: "" };
    });
    assert.deepEqual(seen, { F1: 2, F2: 2, Q1: 2 }, "提供前接原文不增加模型调用");
    const state = await stateApi.getFoundationState(p.id, db);
    assert.equal(state.ready, true);
    assert.deepEqual(state.candidates.f1!.output.coverage, [27, 28]);
    assert.deepEqual(state.candidates.f1!.output.episodes.find((episode) => episode.number === 28)!.sourceSelections, [canonical]);
    assert.equal(f2WholeSource, episodes[0].content);
    const f1Run = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f1!.runId } });
    const evidence = JSON.parse(f1Run.log!);
    assert.equal(evidence.calls.length, 2);
    assertNumberedSource(evidence.calls[0].input.source, [episodes[0]], sourceIndex.version);
    assertNumberedSource(evidence.calls[0].input.precedingSource, [], sourceIndex.version);
    const second = evidence.calls[1];
    assert.deepEqual(parse(second.taskPrompt), second.input, "原始taskPrompt与decoded调用输入必须一致");
    assertNumberedSource(parse(second.taskPrompt).precedingSource, [episodes[0]], sourceIndex.version);
    assertNumberedSource(second.input.precedingSource, [episodes[0]], sourceIndex.version);
    assert.deepEqual(JSON.parse(second.response.rawOutput), second.response.data);
    assert.deepEqual(second.response.data.episodes[0].sourceSelections, [whole], "保存原wholeEpisode请求，不把原模型响应改成程序生成行号");
    assert.deepEqual(second.response.data.coverage, [28], "前接和目录不得扩写作者生成coverage");
    const packet = await stateApi.readApprovedEpisodeFoundation(p.id, 28, db);
    assert.equal(packet.source.content, episodes[1].content);
    assert.equal(packet.sourceSelections.length, 1); assert.equal(packet.sourceSelections[0].content, episodes[0].content);
    assert.equal(packet.sourceSelections[0].endLine, 71);
    assert.deepEqual(await db.episode.findMany({ where: { projectId: p.id }, orderBy: { number: "asc" }, select: { number: true, title: true, content: true } }), episodes);
  });

  await check("normal F1 omitted or null selections normalize without rewriting saved author evidence", async () => {
    const p = await project(); const seen = { F1: 0, F2: 0, Q1: 0 };
    await execute(p.id, await queue(p.id), async (stage, prompt) => {
      const input = parse(prompt); const data = output(stage, input.scope); seen[stage]++;
      if (stage === "F1") {
        const episodes = data.episodes as Array<Record<string, unknown>>;
        delete episodes[0].sourceSelections; episodes[1].sourceSelections = null;
      }
      if (stage === "F2") {
        assert.ok(input.f1.episodes.every((episode: { sourceSelections: unknown[] }) => Array.isArray(episode.sourceSelections) && !episode.sourceSelections.length));
        assert.ok(input.f1.selectedSource.every((episode: { selections: unknown[] }) => !episode.selections.length));
      }
      return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic optional-selection events", stderr: "" };
    });
    assert.deepEqual(seen, { F1: 1, F2: 1, Q1: 1 });
    const state = await stateApi.getFoundationState(p.id, db); assert.equal(state.ready, true);
    assert.ok(state.candidates.f1!.output.episodes.every((episode) => episode.sourceSelections.length === 0));
    const run = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f1!.runId } });
    const call = JSON.parse(run.log!).calls[0];
    assert.deepEqual(JSON.parse(call.response.rawOutput), call.response.data);
    assert.equal("sourceSelections" in call.response.data.episodes[0], false);
    assert.equal(call.response.data.episodes[1].sourceSelections, null);
    for (const episode of source) {
      const packet = await stateApi.readApprovedEpisodeFoundation(p.id, episode.number, db);
      assert.equal(packet.source.content, episode.content); assert.deepEqual(packet.sourceSelections, []);
    }
  });

  await check("ordinary out-of-range selections and mixed whole-episode requests fail without clamping or downstream calls", async () => {
    for (const mixedWhole of [false, true]) {
      const episodes = [
        { number: 27, title: "合成71行前集", content: Array.from({ length: 71 }, (_, index) => `甲：第${index + 1}行。${index === 70 ? "" : "\r\n"}`).join("") },
        { number: 28, title: "合成后集", content: "28-1\n甲：当前原句。" }
      ];
      const p = await project(episodes); const seen = { F1: 0, F2: 0, Q1: 0 };
      const selection = mixedWhole ? { episode: 27, wholeEpisode: true, startLine: 1, endLine: 71, purpose: "不得混合两种定位" }
        : { episode: 27, startLine: 59, endLine: 79, purpose: "合成越界请求，不得截短为71行" };
      const token = await queue(p.id);
      await assert.rejects(() => execute(p.id, token, async (stage, prompt) => {
        const data = output(stage, parse(prompt).scope); seen[stage]++;
        if (stage === "F1") (data.episodes as Array<Record<string, unknown>>).find((episode) => episode.number === 28)!.sourceSelections = [selection];
        return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic invalid-selection events", stderr: "" };
      }), /sourceSelections|越界|wholeEpisode|行号|范围/);
      assert.deepEqual(seen, { F1: 1, F2: 0, Q1: 0 });
      const runs = await db.pipelineRun.findMany({ where: { projectId: p.id } });
      const f1 = runs.find((run) => run.stageCode === "F1")!; assert.equal(f1.status, "FAILED");
      assert.ok(runs.filter((run) => run.stageCode !== "F1").every((run) => run.status === "CANCELED"));
      const call = JSON.parse(f1.log!).calls[0];
      assert.deepEqual(call.response.data.episodes.find((episode: { number: number }) => episode.number === 28).sourceSelections, [selection]);
      assert.deepEqual(JSON.parse(call.response.rawOutput), call.response.data, "错误请求及79行边界必须在证据里原样保留");
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: { in: ["FOUNDATION_F1", "FOUNDATION_F2", "FOUNDATION_Q1", "FOUNDATION_APPROVED"] } } }), 0);
      assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0);
    }
  });

  await check("each real role input declares batch mode, consumers, questions and delivery level", async () => {
    const p = await project();
    await execute(p.id, await queue(p.id), async (stage, prompt, call) => {
      const input = parse(prompt);
      assert.equal(typeof input.workMode, "string", `${stage}缺少工作模式`);
      assert.match(input.targetArchitecture, /v0\.2/);
      assert.match(input.currentTestScope, /P0.*F1.*F2.*Q1/);
      assert.match(input.currentTestScope, /后续.*未/);
      assert.doesNotMatch(JSON.stringify({ consumer: input.consumer, consumerQuestions: input.consumerQuestions, deliveryLevel: input.deliveryLevel }), /E[0-5]/, "不能把旧E链当作v0.2目标消费者");
      assert.ok(Array.isArray(input.consumerQuestions) && input.consumerQuestions.length >= 2, `${stage}缺少待判断问题`);
      assert.deepEqual(input.targetEpisodes, input.scope, "按本批每集分别供给，不伪造用户指定的单集");
      assert.match(input.taskPermissions.source, /只读/);
      assert.match(input.taskPermissions.tools, /INPUT_JSON/);
      assert.match(input.taskPermissions.materials, /未.*核实/);
      const loaded = await stateApi.loadFoundationInputs(p.id, db);
      assert.deepEqual(input.consumerQuestions, loaded.taskContract.roles[stage].consumerQuestions, "实际投喂与版本计算使用同一份任务说明");
      if (stage === "F1") {
        assert.match(input.workMode, /初建/);
        assert.match(input.consumer, /叙事.*情绪.*对白.*粗排/);
        assert.match(input.deliveryLevel, /overview.*后台/);
        assert.match(input.deliveryLevel, /sourceSelections.*可为空/);
        assert.match(input.deliveryLevel, /按需|不能.*每岗/);
      }
      if (stage === "F2") assert.match(input.deliveryLevel, /assets.*后台.*episodes.*当集/);
      if (stage === "Q1") {
        assert.match(input.deliveryLevel, /episodePackets.*实际.*未发布/);
        assert.match(input.deliveryLevel, /不代表.*后续/);
      }
      return runner(stage, prompt, call);
    });
    assert.equal((await stateApi.getFoundationState(p.id, db)).ready, true);
  });

  await check("consumer-purpose changes invalidate approval without altering raw source or system prose", async () => {
    const p = await project(); await execute(p.id, await queue(p.id));
    const before = await stateApi.loadFoundationInputs(p.id, db);
    const briefs = contracts.FOUNDATION_TASK_CONTRACT as unknown as { roles: { F1: { consumer: string } } };
    const original = briefs.roles.F1.consumer;
    try {
      briefs.roles.F1.consumer = `${original}；临时测试用途变化`;
      const after = await stateApi.loadFoundationInputs(p.id, db);
      assert.equal(after.sourceVersion, before.sourceVersion);
      assert.deepEqual(after.promptHashes, before.promptHashes);
      assert.notEqual(after.inputVersion, before.inputVersion);
      assert.equal((await stateApi.getFoundationState(p.id, db)).ready, false);
    } finally { briefs.roles.F1.consumer = original; }
    assert.equal((await stateApi.getFoundationState(p.id, db)).ready, true);
  });

  await check("unpublished drafts; current F2/Q inputs; exact reviewed packet; complete log", async () => {
    const p = await project(); const token = await queue(p.id); const seen: Stage[] = []; let reviewedPackets: unknown[] = [];
    await execute(p.id, token, async (stage, prompt, call) => {
      seen.push(stage); const input = parse(prompt);
      assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0, "Q1返回前不发布资产");
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "PROJECT_MEMORY" } }), 0);
      assert.equal(call.sessionMode, "ephemeral"); assert.equal(call.provider, "API");
      assert.equal(call.role.skill, ""); assert.ok(call.role.systemPrompt?.length);
      assertNumberedSource(input.source, source.filter((episode) => input.scope.includes(episode.number)), input.sourceVersion);
      assert.match(input.project.unitMode, /未选|未确认/);
      const run = await db.pipelineRun.findUniqueOrThrow({ where: { id: call.runId } });
      assert.equal(JSON.parse(run.log!).calls.at(-1).status, "RUNNING");
      assert.equal(JSON.parse(run.log!).calls.at(-1).taskPrompt, prompt);
      if (stage === "F1") await db.project.update({ where: { id: p.id }, data: { executionMode: "CLI" } });
      if (stage === "F2") {
        assert.match(JSON.stringify(input.f1), /F1-CURRENT-1/);
        assert.ok(await db.sceneSnapshot.findUnique({ where: { id: input.f1.snapshotId } }));
      }
      if (stage === "Q1") {
        const f1 = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: input.candidates.f1.snapshotId } });
        const f2 = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: input.candidates.f2.snapshotId } });
        assert.ok(input.candidates.f1.projection && input.candidates.f2.projection, "Q1必须标明带原快照坐标的本批投影");
        for (const code of ["f1", "f2"] as const) {
          const saved = JSON.parse((code === "f1" ? f1 : f2).content).output;
          assert.deepEqual(input.candidates[code].output.coverage, input.scope);
          assert.deepEqual(input.candidates[code].output.episodes, saved.episodes.filter((episode: { number: number }) => input.scope.includes(episode.number)));
        }
        assert.deepEqual(input.candidates.f2.output.assets, JSON.parse(f2.content).output.assets, "单批涵盖全部集时，身份与状态仍须精确来自已保存候选");
        reviewedPackets = input.episodePackets;
        assert.equal(input.episodePackets[0].sourceSelections[0].content, "1-1\r\n");
      }
      return runner(stage, prompt, call);
    });
    assert.deepEqual(seen, ["F1", "F2", "Q1"]);
    const state = await stateApi.getFoundationState(p.id, db);
    assert.equal(state.ready, true); assert.equal(state.reviewReady, true);
    const packet = await stateApi.readApprovedEpisodeFoundation(p.id, 1, db);
    assert.equal(packet.source.content, source[0].content);
    assert.equal(packet.f1Context, "F1-CURRENT-1"); assert.equal(packet.f2Context, "F2-CURRENT-1");
    assert.equal(packet.sourceSelections[0].content, "1-1\r\n");
    assert.doesNotMatch(JSON.stringify(packet), /BACKEND_|F1-CURRENT-2|F2-CURRENT-2|本集2状态/);
    assert.equal(packet.assetKeys[0], "person-jia"); assert.match(packet.assetCodes[0], /^CH-\d{3}-1$/);
    const { assetCodes, ...publishedBody } = packet;
    assert.deepEqual(publishedBody, { ...(reviewedPackets[0] as object), identities: packet.identities }, "批准正文必须与Q1实际被审包一致，发布只补程序code");
    const runs = await db.pipelineRun.findMany({ where: { projectId: p.id } });
    assert.ok(runs.every((run) => run.status === "SUCCEEDED"));
    assert.ok(runs.every((run) => JSON.parse(run.inputSummary!).workerPid === 98765));
    assert.ok(runs.every((run) => JSON.parse(run.log!).calls[0].response.rawOutput === "RAW_FULL_OUTPUT"));
  });

  await check("REPAIR/BLOCKED remain successful review records without publication", async () => {
    for (const verdict of ["REPAIR", "BLOCKED"]) {
      const p = await project(); const token = await queue(p.id);
      await execute(p.id, token, async (stage, prompt) => ({ data: output(stage, parse(prompt).scope, verdict), sessionId: null, stdout: "", stderr: "" }));
      const state = await stateApi.getFoundationState(p.id, db);
      assert.equal(state.ready, false); assert.equal(state.reviewReady, false); assert.equal(state.review?.output.verdict, verdict);
      assert.equal((await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "Q1" } })).status, "SUCCEEDED");
      assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_APPROVED" } }), 0);
      await assert.rejects(() => stateApi.requireApprovedFoundation(p.id, db), /审核|审阅|批准|修|阻/);
    }
  });

  await check("single-role dependencies and late queued/failed authors invalidate approval", async () => {
    const missing = await project(); const token = await queue(missing.id, ["F2"]); let calls = 0;
    await assert.rejects(() => execute(missing.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), /F1|理解/);
    assert.equal(calls, 0);
    const p = await project(); await execute(p.id, await queue(p.id));
    const rerun = await queue(p.id, ["F1"]);
    assert.equal((await stateApi.getFoundationState(p.id, db)).ready, false);
    await execute(p.id, rerun, runner, "F1");
    const state = await stateApi.getFoundationState(p.id, db);
    assert.equal(state.planningReady, true); assert.equal(state.assetsReady, false);
    const qToken = await queue(p.id, ["Q1"]);
    await assert.rejects(() => execute(p.id, qToken, runner, "Q1"), /F2|版本|资产|身份/);
    const bad = await queue(p.id, ["F2"]);
    await assert.rejects(() => execute(p.id, bad, async () => { throw new Error("provider-failed"); }, "F2"));
    assert.equal((await stateApi.getFoundationState(p.id, db)).ready, false);
  });

  await check("source and confirmed production conditions invalidate approved versions", async () => {
    const p = await project(); await execute(p.id, await queue(p.id));
    const original = await stateApi.getFoundationState(p.id, db);
    await db.project.update({ where: { id: p.id }, data: { style: "2D" } });
    const changed = await stateApi.getFoundationState(p.id, db);
    assert.notEqual(changed.inputVersion, original.inputVersion); assert.equal(changed.ready, false);
    await db.project.update({ where: { id: p.id }, data: { style: "3D漫剧" } });
    await db.presentationContract.create({ data: { projectId: p.id, category: "system", question: "形态", options: "[]", status: "CONFIRMED", userAnswer: "只用声音" } });
    assert.equal((await stateApi.getFoundationState(p.id, db)).ready, false);
    await db.episode.update({ where: { id: p.episodes[0].id }, data: { content: `${source[0].content}新源` } });
    assert.notEqual((await stateApi.getFoundationState(p.id, db)).sourceVersion, original.sourceVersion);
    await assert.rejects(() => stateApi.readApprovedEpisodeFoundation(p.id, 1, db));
  });

  await check("rule text changes invalidate approval without modifying checked-in prompts", async () => {
    const p = await project(); await execute(p.id, await queue(p.id));
    const before = await stateApi.getFoundationState(p.id, db); const originalCwd = process.cwd();
    const promptDir = path.join(scratch, "prompts", "foundation"); mkdirSync(promptDir, { recursive: true });
    for (const stage of ["F1", "F2", "Q1"]) copyFileSync(path.join(originalCwd, "prompts", "foundation", `${stage}.md`), path.join(promptDir, `${stage}.md`));
    appendFileSync(path.join(promptDir, "F1.md"), "\n临时测试规则版本差异\n");
    try {
      process.chdir(scratch);
      const after = await stateApi.getFoundationState(p.id, db);
      assert.equal(after.ready, false); assert.equal(after.inputVersion, before.inputVersion);
      assert.notEqual(after.methodVersions.F1, before.methodVersions.F1);
      assert.equal(after.methodVersions.F2, before.methodVersions.F2);
      assert.equal(after.methodVersions.Q1, before.methodVersions.Q1);
    } finally { process.chdir(originalCwd); }
  });

  await check("queue-pinned versions fail before calling; removed source cannot strand QUEUED runs", async () => {
    for (const remove of [false, true]) {
      const p = await project(); const version = await stateApi.getFoundationState(p.id, db); const token = await queue(p.id);
      for (const run of await db.pipelineRun.findMany({ where: { projectId: p.id } })) await db.pipelineRun.update({ where: { id: run.id }, data: { inputSummary: JSON.stringify({ ...JSON.parse(run.inputSummary!), sourceVersion: version.sourceVersion, inputVersion: version.inputVersion }) } });
      if (remove) await db.episode.deleteMany({ where: { projectId: p.id } });
      else await db.project.update({ where: { id: p.id }, data: { aspectRatio: "9:16" } });
      let calls = 0;
      await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }));
      assert.equal(calls, 0);
      const runs = await db.pipelineRun.findMany({ where: { projectId: p.id } });
      assert.equal(runs.find((run) => run.stageCode === "F1")!.status, "FAILED");
      assert.ok(runs.filter((run) => run.stageCode !== "F1").every((run) => run.status === "CANCELED"));
      assert.match(runs.find((run) => run.stageCode === "F1")!.log!, /版本|原文/);
    }
  });

  await check("READY contradictions fail; Q cannot review a mismatched upstream snapshot", async () => {
    const p = await project(); const token = await queue(p.id);
    await assert.rejects(() => execute(p.id, token, async (stage, prompt) => {
      const result = output(stage, parse(prompt).scope, stage === "Q1" ? "REPAIR" : "READY");
      if (stage === "Q1") result.verdict = "READY";
      return { data: result, rawOutput: JSON.stringify(result), sessionId: null, stdout: "", stderr: "" };
    }));
    assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0);
    const f2 = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } });
    await db.sceneSnapshot.update({ where: { id: f2.id }, data: { content: JSON.stringify({ ...JSON.parse(f2.content), upstreamSnapshotIds: { f1: "wrong-snapshot" } }) } });
    const qToken = await queue(p.id, ["Q1"]); let calls = 0;
    await assert.rejects(() => execute(p.id, qToken, async (...args) => { calls++; return runner(...args); }, "Q1"), /F2|版本/);
    assert.equal(calls, 0);
  });

  await check("malformed/provider failure preserves full raw and model issues; cancels next roles", async () => {
    for (const providerFailure of [false, true]) {
      const p = await project(); const token = await queue(p.id); let calls = 0;
      const raw = `RAW-START${"x".repeat(40_000)}RAW-END`;
      await assert.rejects(() => execute(p.id, token, async () => {
        calls++;
        if (providerFailure) throw Object.assign(new Error("invalid JSON"), { rawOutput: raw, stdout: raw, stderr: "bad JSON" });
        return { data: { episodes: [], issues: [{ severity: "MAJOR", owner: "F1", coordinate: "episodes", problem: "MODEL-ISSUE-PRESERVED", sourceRefs: [ref(1)] }] }, rawOutput: raw, sessionId: null, stdout: raw, stderr: "" };
      }));
      assert.equal(calls, 1);
      const runs = await db.pipelineRun.findMany({ where: { projectId: p.id } });
      const failed = runs.find((run) => run.stageCode === "F1")!;
      assert.equal(failed.status, "FAILED");
      const call = JSON.parse(failed.log!).calls[0];
      assert.equal(call.response.rawOutput, raw); assert.equal(call.response.stdout, raw);
      if (!providerFailure) assert.match(failed.log!, /MODEL-ISSUE-PRESERVED/);
      assert.ok(runs.filter((run) => run.stageCode !== "F1").every((run) => run.status === "CANCELED"));
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F1" } }), 0);
    }
  });

  await check("stop/source change in callback cannot publish or overwrite user FAILED", async () => {
    for (const change of ["stop", "source"]) {
      const p = await project(); const token = await queue(p.id);
      await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
        if (stage === "Q1") {
          if (change === "stop") await db.pipelineRun.update({ where: { id: call.runId }, data: { status: "FAILED", error: "用户停止" } });
          else await db.episode.update({ where: { id: p.episodes[0].id }, data: { content: `${source[0].content}变更` } });
        }
        return runner(stage, prompt, call);
      }));
      const q = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "Q1" } });
      assert.equal(q.status, "FAILED"); if (change === "stop") assert.equal(q.error, "用户停止");
      assert.match(q.log!, /RAW_FULL_OUTPUT/);
      assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_APPROVED" } }), 0);
    }
  });

  await check("stable F2 keys retain IDs/codes/user metadata; approval history remains", async () => {
    const p = await project(); await execute(p.id, await queue(p.id));
    const old = await db.asset.findFirstOrThrow({ where: { projectId: p.id, name: "甲" } });
    await db.asset.update({ where: { id: old.id }, data: { status: "confirmed", notes: "用户笔记", metadata: JSON.stringify({ ...JSON.parse(old.metadata!), customMaterial: "keep-me" }) } });
    await execute(p.id, await queue(p.id, ["F2"]), async (stage, prompt, call) => {
      const input = parse(prompt);
      assert.match(JSON.stringify(input.prior), /person-jia/);
      assert.doesNotMatch(JSON.stringify(input.prior), /本集1状态/, "历史身份线索不能重复携带旧状态");
      const hint = input.prior.publishedIdentityHistory.assets[0];
      assert.equal(hint.name, "甲"); assert.equal(hint.type, "CH"); assert.ok(hint.aliases.includes("甲同学"));
      assert.deepEqual(Object.keys(hint).sort(), ["aliases", "key", "name", "type"], "已发布历史只供稳定身份线索，不重发整份后台描述和状态");
      return runner(stage, prompt, call);
    }, "F2");
    assert.equal((await stateApi.getFoundationState(p.id, db)).ready, false);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: old.id } })).status, "confirmed");
    await execute(p.id, await queue(p.id, ["Q1"]), runner, "Q1");
    const after = await db.asset.findUniqueOrThrow({ where: { id: old.id } });
    assert.equal(after.code, old.code); assert.equal(after.status, "confirmed"); assert.equal(after.notes, "用户笔记");
    assert.equal(JSON.parse(after.metadata!).customMaterial, "keep-me");
    assert.equal(await db.asset.count({ where: { projectId: p.id } }), 1);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_APPROVED" } }), 2);
  });

  await check("oversized source stays whole; later F1/F2 calls receive meaningful prior", async () => {
    const big = [{ ...source[0], content: `${source[0].content}${"长".repeat(24_001)}` }, source[1]];
    const p = await project(big); const token = await queue(p.id); const counts = { F1: 0, F2: 0, Q1: 0 };
    await execute(p.id, token, async (stage, prompt, call) => {
      counts[stage]++; const input = parse(prompt);
      assertNumberedSource(input.source, big.filter((episode) => input.scope.includes(episode.number)), input.sourceVersion);
      if (input.scope[0] === 1) {
        const run = await db.pipelineRun.findUniqueOrThrow({ where: { id: call.runId } });
        assert.equal(JSON.parse(run.log!).calls.at(-1).oversized, true);
      } else if (stage === "F1") {
        assert.match(JSON.stringify(input.prior), /F1-CURRENT-1/);
        assert.match(JSON.stringify(input.prior), /本集开场定位/);
      } else if (stage === "F2") {
        assert.match(JSON.stringify(input.prior.registry), /person-jia/);
        assert.doesNotMatch(JSON.stringify(input.prior), /本集1状态/);
        assert.equal("processedChunks" in input.prior, false);
        assert.ok(input.f1.selectedSource, "F2需要可核对的F1真实选材");
        assert.equal(input.f1.selectedSource[0].selections[0].content, "1-1\r\n", "跨片补文须传真实摘录，不能只有不可核的旧refs");
      }
      const result = await runner(stage, prompt, call);
      if (stage === "F1" && input.scope[0] === 2) (result.data.episodes as Array<{ sourceSelections: unknown[] }>)[0].sourceSelections = [{ ...ref(1), purpose: "接续上集开场" }];
      return result;
    });
    assert.deepEqual(counts, { F1: 2, F2: 2, Q1: 2 });
    assert.equal((await stateApi.getFoundationState(p.id, db)).ready, true);
  });

  await check("same-name distinct keys never merge legacy material; omitted identities remain history", async () => {
    const p = await project();
    const legacy = await db.asset.create({ data: { projectId: p.id, type: "CH", code: "CH-900-1", name: "甲", status: "confirmed", metadata: '{"customMaterial":"legacy"}' } });
    await execute(p.id, await queue(p.id), async (stage, prompt) => {
      const result = output(stage, parse(prompt).scope);
      if (stage === "F2") {
        const assets = result.assets as Array<Record<string, unknown>>;
        result.assets = [assets[0], { ...assets[0], key: "different-jia" }];
        result.episodes = (result.episodes as Array<Record<string, unknown>>).map((episode) => ({ ...episode, uses: (episode.uses as Array<Record<string, unknown>>).flatMap((use) => [use, { ...use, key: "different-jia" }]) }));
      }
      if (stage === "Q1") {
        const input = parse(prompt);
        assert.match(JSON.stringify([...input.mechanicalIssues, ...input.unscopedIssues]), /歧义/, "未定位的身份歧义仍须交Q1，不能因scope过滤丢失");
      }
      return { data: result, sessionId: null, stdout: "", stderr: "" };
    });
    assert.equal(await db.asset.count({ where: { projectId: p.id } }), 3);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: legacy.id } })).metadata, legacy.metadata);
    const packet = await stateApi.readApprovedEpisodeFoundation(p.id, 1, db);
    assert.equal(new Set(packet.assetCodes).size, 2); assert.ok(!packet.assetCodes.includes(legacy.code));
    await execute(p.id, await queue(p.id, ["F2"]), async (stage, prompt) => {
      const result = output(stage, parse(prompt).scope);
      result.assets = [];
      result.episodes = (result.episodes as Array<Record<string, unknown>>).map((episode) => ({ ...episode, uses: [] }));
      return { data: result, sessionId: null, stdout: "", stderr: "" };
    }, "F2");
    await execute(p.id, await queue(p.id, ["Q1"]), runner, "Q1");
    assert.equal(await db.asset.count({ where: { projectId: p.id } }), 3);
    assert.deepEqual((await stateApi.readApprovedEpisodeFoundation(p.id, 1, db)).assetKeys, []);
    const all = await db.asset.findMany({ where: { projectId: p.id, id: { not: legacy.id } } });
    assert.ok(all.every((asset) => JSON.parse(asset.metadata!).foundationCurrent === false));
  });
  await check("even one uniquely named legacy asset needs an explicit identity key to be reused", async () => {
    const p = await project();
    const legacy = await db.asset.create({ data: { projectId: p.id, type: "CH", code: "CH-900-1", name: "甲", status: "confirmed", sourceText: "另一个旧人物", metadata: '{"customMaterial":"legacy"}' } });
    await execute(p.id, await queue(p.id));
    assert.deepEqual(await db.asset.findUniqueOrThrow({ where: { id: legacy.id } }), legacy, "唯一同名也不得改写旧资产或继承其确认状态");
    const packet = await stateApi.readApprovedEpisodeFoundation(p.id, 1, db);
    assert.ok(!packet.assetCodes.includes(legacy.code));
    assert.equal(await db.asset.count({ where: { projectId: p.id } }), 2);
  });

  const splitSource = [1, 2, 3].map((number) => ({ number, title: `第${number}集`, content: `${number}-1\n甲在此。\n${"源".repeat(24_001)}` }));
  await check("F2 carries verified registry; changed descriptions and a prior alias preserve every source", async () => {
    const p = await project(splitSource);
    const reviewedVariants = new Map<string, unknown>();
    await execute(p.id, await queue(p.id), async (stage, prompt, call) => {
      const input = parse(prompt); const result = await runner(stage, prompt, call);
      if (stage === "F2") {
        assert.ok(Array.isArray(input.prior.registry), "F2必须获得本轮已验证累计registry");
        assert.equal("processedChunks" in input.prior, false, "不得再把完整已处理分片重复投喂");
        assert.ok(input.prior.registry.every((asset: Record<string, unknown>) => !("appearances" in asset)), "登记表不重复携带全部历史状态");
        assert.equal(input.prior.registry.length, call.chunkIndex === 1 ? 0 : 1);
        const asset = (result.data.assets as Array<Record<string, unknown>>)[0];
        asset.description = `第${call.chunkIndex}片不同描述`;
        if (call.chunkIndex > 1) asset.name = "甲同学";
        if (call.chunkIndex > 1) assert.equal(input.prior.registry[0].name, "甲");
      }
      if (stage === "Q1") {
        assert.ok(input.candidates.f2.projection);
        assert.deepEqual(input.candidates.f2.output.coverage, input.scope);
        assert.deepEqual(input.candidates.f2.output.episodes.map((episode: { number: number }) => episode.number), input.scope);
        for (const asset of input.candidates.f2.output.assets) {
          assert.ok(asset.appearances.every((appearance: { episode: number }) => input.scope.includes(appearance.episode)), "Q1本批投影不得重复携带其他集状态");
          for (const variant of asset.descriptionVariants ?? []) reviewedVariants.set(variant.text, variant.sourceRefs);
        }
      }
      return result;
    });
    const state = await stateApi.getFoundationState(p.id, db);
    assert.equal(state.ready, true); assert.equal(state.dataReady, true);
    assert.equal(state.candidates.f2?.protocolVersion, contracts.F2_PROTOCOL_VERSION);
    assert.deepEqual([...reviewedVariants.entries()].sort(), [1, 2, 3].map((number) => [`第${number}片不同描述`, [ref(number)]]), "各批Q1合计必须审到全部描述版本及原来源");
    const asset = await db.asset.findFirstOrThrow({ where: { projectId: p.id } });
    assert.equal(asset.name, "甲");
    for (const number of [1, 2, 3]) assert.match(asset.sourceText!, new RegExp(`第${number}片不同描述`));
    assert.equal(JSON.parse(asset.metadata!).foundation.descriptionVariants.length, 3);
  });

  await check("consumer identity names use source labels and AI notes cannot prove aliases", async () => {
    const p = await project([{ ...source[0], content: `${source[0].content}甲又被称作老甲，同学叫他甲同学。\n` }, { ...source[1], content: `${source[1].content}\nFUTURE_ALIAS_MARKER` }]);
    let checked = false;
    await execute(p.id, await queue(p.id), async (stage, prompt, call) => {
      const result = await runner(stage, prompt, call);
      if (stage === "F1") {
        const episodes = result.data.episodes as Array<Record<string, unknown>>;
        episodes[0].context = "AI_ONLY_ALIAS 只是作者解释，不是源文出现证据。";
        episodes[0].f2Notes = "PRIVATE_F2_NOTES 不进入消费者包。";
        episodes[0].sourceSelections = [{ episode: 2, startLine: 5, endLine: 5, purpose: "仅供审核后接边界" }];
      }
      if (stage === "F2") {
        assert.match(JSON.stringify(parse(prompt).f1), /PRIVATE_F2_NOTES/, "F2专用线索必须真正交给F2");
        const asset = (result.data.assets as Array<Record<string, unknown>>)[0];
        asset.name = "后台统一身份名"; asset.aliases = ["AI_ONLY_ALIAS", "FUTURE_ALIAS_MARKER", "甲同学"];
        for (const episode of result.data.episodes as Array<{ number: number; uses: Array<Record<string, unknown>> }>) {
          for (const use of episode.uses) { use.sourceName = "甲"; use.sourceRefs = [workingRef(episode.number, 3)]; }
          if (episode.number === 1) episode.uses.push({ key: "person-jia", presence: "MENTIONED", state: "同集以老甲这一称呼指代甲。", sourceRefs: [workingRef(1, 4)], sourceName: "老甲" });
        }
      }
      if (stage === "Q1") {
        const packet = parse(prompt).episodePackets.find((item: { episode: number }) => item.episode === 1);
        assert.equal(packet.identities[0].name, "甲");
        assert.equal(packet.identities[0].nameBasis, "SOURCE_WORDING");
        assert.deepEqual(packet.identities[0].aliases, ["甲同学"], "别名必须已登记且见于本集raw；未登记localName、AI解释和未来补文都不能新增别名");
        assert.ok(packet.identities[0].appearances.every((appearance: { sourceNameMatch: string }) => appearance.sourceNameMatch === "LITERAL"));
        assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_F2_NOTES/);
        assert.match(packet.f1Context, /AI_ONLY_ALIAS/, "不能靠程序偷偷删改作者context伪装内容通过");
        checked = true;
      }
      return result;
    });
    assert.equal(checked, true);
  });

  await check("normal F2 requires complete per-episode uses and never accepts legacy arrays instead", async () => {
    for (const malformed of ["missing-state", "legacy-arrays"]) {
      const p = await project(splitSource.slice(0, 2));
      const input = await stateApi.loadFoundationInputs(p.id, db);
      const token = await queue(p.id);
      let f2Calls = 0; let q1Calls = 0;
      await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
        const result = await runner(stage, prompt, call);
        if (stage === "F2") {
          f2Calls++;
          if (call.chunkIndex === 2 && malformed === "missing-state") {
            result.data.assets = [];
            delete (result.data.episodes as Array<{ uses: Array<Record<string, unknown>> }>)[0].uses[0].state;
          } else if (call.chunkIndex === 2) {
            result.data = { ...contracts.requireF2Output(result.data, input.sourceIndex, call.scope) };
          }
        }
        if (stage === "Q1") q1Calls++;
        return result;
      }), /uses|state|非空/);
      const state = await stateApi.getFoundationState(p.id, db);
      assert.equal(f2Calls, 2); assert.equal(q1Calls, 0);
      assert.equal(state.assetsReady, false); assert.equal(state.ready, false); assert.equal(state.candidates.f2, null);
      assert.equal((await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" } })).status, "FAILED");
      assert.equal((await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "Q1" } })).status, "CANCELED");
      assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: { in: ["FOUNDATION_F2", "FOUNDATION_APPROVED"] } } }), 0);
    }
  });

  await check("genuine F2 name/type conflicts stop at the second chunk before a third provider call", async () => {
    for (const conflict of ["name", "type"]) {
      const p = await project(splitSource); let f2Calls = 0;
      const token = await queue(p.id);
      await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
        const result = await runner(stage, prompt, call);
        if (stage === "F2") {
          f2Calls++;
          if (call.chunkIndex === 2) (result.data.assets as Array<Record<string, unknown>>)[0][conflict] = conflict === "name" ? "无关乙" : "PROP";
        }
        return result;
      }), /身份|冲突|别名|type|name/);
      assert.equal(f2Calls, 2);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), 0);
    }
  });

  await check("F2 transport version invalidates only F2 and its dependent Q1, not F1", async () => {
    const p = await project(); await execute(p.id, await queue(p.id));
    const before = await stateApi.getFoundationState(p.id, db);
    const row = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: before.candidates.f2!.id } });
    const body = JSON.parse(row.content); body.protocolVersion = "old-f2-transport";
    await db.sceneSnapshot.update({ where: { id: row.id }, data: { content: JSON.stringify(body) } });
    const after = await stateApi.getFoundationState(p.id, db);
    assert.equal(after.planningReady, true); assert.equal(after.assetsReady, false); assert.equal(after.ready, false);
    assert.equal(after.inputVersion, before.inputVersion); assert.equal(after.candidates.f1?.id, before.candidates.f1?.id);
  });

  async function failedF2(complete = false) {
    const p = await project(splitSource);
    await db.project.update({ where: { id: p.id }, data: { executionMode: "API" } });
    await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
    const token = await queue(p.id, ["F2"]);
    await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
      // This fixture fails before sending a request; these strings are local diagnostic output.
      if (!complete && call.chunkIndex === 2) throw Object.assign(new Error("fixture provider failure"), { requestOutcome: "NOT_SENT", rawOutput: "PARTIAL-FAILED-RAW", stdout: "fixture events", stderr: "fixture failure" });
      const result = await runner(stage, prompt, call);
      if (complete && call.chunkIndex === 3) await db.pipelineRun.update({ where: { id: call.runId }, data: { status: "FAILED", error: "fixture old aggregate failure" } });
      return result;
    }, "F2"));
    const failed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" } });
    return { p, failed };
  }
  async function makeLegacy(runId: string, withProcessedChunks = true) {
    const row = await db.pipelineRun.findUniqueOrThrow({ where: { id: runId } });
    const log = JSON.parse(row.log!); const summary = JSON.parse(row.inputSummary!);
    const input = await stateApi.loadFoundationInputs(row.projectId, db);
    const normalizedParts: Array<ReturnType<typeof contracts.requireF2Output>> = [];
    // Explicit synthetic compatibility data: normal producers above always return the new uses wire.
    log.syntheticFixture = "FAKE-ONLY: canonical legacy F2 response and original-input compatibility";
    delete log.protocolVersion; delete summary.protocolVersion;
    for (const call of log.calls) {
      delete call.protocolVersion; delete call.checkpoint; delete call.providerCallCount;
      if (withProcessedChunks) {
        delete call.input.prior.registry;
        call.input.prior.processedChunks = normalizedParts.map(({ assets, episodes }) => ({ assets, episodes }));
      }
      else delete call.input.prior.processedChunks;
      const envelope = call.taskPrompt.slice(0, call.taskPrompt.lastIndexOf("INPUT_JSON:\n"));
      call.taskPrompt = envelope.replace(/F2_PROTOCOL_VERSION:[\s\S]*?(?=OUTPUT_SCHEMA)/, "") + `INPUT_JSON:\n${JSON.stringify(call.input)}`;
      if (call.response?.data) {
        const prior = normalizedParts.length ? contracts.mergeF2Outputs(normalizedParts, input.sourceIndex, normalizedParts.flatMap((part) => part.coverage)).assets : [];
        const normalized = contracts.requireF2Output(call.response.data, input.sourceIndex, call.scope, prior);
        call.response.data = normalized;
        call.response.rawOutput = JSON.stringify(normalized);
        normalizedParts.push(normalized);
      }
    }
    await db.pipelineRun.update({ where: { id: runId }, data: { log: JSON.stringify(log), inputSummary: JSON.stringify(summary) } });
    return db.pipelineRun.findUniqueOrThrow({ where: { id: runId } });
  }

  await check("recovery cannot replace a newer normal F2 candidate or fall back past the latest attempt", async () => {
    for (const status of ["SUCCEEDED", "QUEUED", "RUNNING", "FAILED"] as const) {
      const { p, failed } = await failedF2();
      if (status === "SUCCEEDED") await execute(p.id, await queue(p.id, ["F2"]), runner, "F2");
      else await db.pipelineRun.create({ data: { projectId: p.id, stageCode: "F2", roleName: "newer fixture attempt", status, error: status === "FAILED" ? "newer failure without reusable response" : null } });
      const before = await stateApi.getFoundationState(p.id, db);
      assert.equal(before.f2Recovery, null, `${status}之后不得再推荐更旧失败稿`);
      const count = await db.pipelineRun.count({ where: { projectId: p.id } });
      // The old source is incomplete: even a broken latest guard cannot launch a replay worker here.
      await assert.rejects(() => core.queueSingleFoundationStage(p.id, "F2", { resumeFromRunId: failed.id, replayOnly: true }), /最新|更新|正在执行/);
      assert.equal(await db.pipelineRun.count({ where: { projectId: p.id } }), count, "拒绝的旧恢复不能创建运行");
      if (status === "SUCCEEDED") {
        let calls = 0;
        const candidates = await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } });
        const staleToken = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id });
        await assert.rejects(() => execute(p.id, staleToken, async (...args) => { calls++; return runner(...args); }, "F2"), /最新|更新/);
        assert.equal(calls, 0);
        assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), candidates);
        assert.equal((await stateApi.getFoundationState(p.id, db)).candidates.f2?.id, before.candidates.f2?.id);
      }
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
    }
  });

  await check("same-protocol F2 resume validates the checkpoint and calls only remaining chunks", async () => {
    const { p, failed } = await failedF2();
    const preview = (await stateApi.getFoundationState(p.id, db)).f2Recovery;
    assert.equal(preview?.resumeRunId, failed.id); assert.equal(preview?.resumeChunkCount, 1);
    assert.equal(preview?.totalChunks, 3); assert.equal(preview?.replayRunId, null);
    let calls = 0; const token = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id });
    await execute(p.id, token, async (stage, prompt, call) => {
      calls++; assert.ok(call.chunkIndex >= 2); return runner(stage, prompt, call);
    }, "F2");
    assert.equal(calls, 2);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed, "恢复不得改写原失败记录或日志");
    const state = await stateApi.getFoundationState(p.id, db); assert.equal(state.assetsReady, true);
    const resumed = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f2!.runId } });
    const evidence = JSON.parse(resumed.log!); const original = JSON.parse(failed.log!).calls[0];
    assert.deepEqual(evidence.calls[0].reusedFrom, { runId: failed.id, sequence: 1 });
    assert.equal(evidence.calls[0].providerCallCount, 0);
    assert.equal(evidence.calls[0].taskPrompt, original.taskPrompt);
    assert.equal(evidence.calls[0].startedAt, original.startedAt);
    assert.equal(evidence.calls[0].finishedAt, original.finishedAt);
    assert.deepEqual(evidence.calls[0].response, original.response);
    assert.equal(evidence.calls[0].revalidatedUnder.protocolVersion, contracts.F2_PROTOCOL_VERSION);
    assert.equal(evidence.calls.reduce((sum: number, call: { providerCallCount: number }) => sum + call.providerCallCount, 0), 2);
  });

  await check("full F2 response is saved before checkpoint eligibility is written", async () => {
    const p = await project(); await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
    const writes: Array<{ response: boolean; checkpoint: boolean }> = [];
    const recordingDb = new Proxy(db, { get(target, property, receiver) {
      if (property !== "pipelineRun") return Reflect.get(target, property, receiver);
      return new Proxy(target.pipelineRun, { get(delegate, method) {
        if (method !== "update") return Reflect.get(delegate, method);
        return async (args: Parameters<typeof db.pipelineRun.update>[0]) => {
          if (typeof args.data.log === "string") {
            const log = JSON.parse(args.data.log); const call = log.calls?.at(-1);
            if (call) writes.push({ response: Boolean(call.response?.data), checkpoint: Boolean(call.checkpoint?.validated) });
          }
          return delegate.update(args);
        };
      } });
    } });
    await core.executeProjectFoundation(p.id, await queue(p.id, ["F2"]), { db: recordingDb, singleStage: "F2", stageRunner: runner });
    const responseAt = writes.findIndex((write) => write.response && !write.checkpoint);
    const checkpointAt = writes.findIndex((write) => write.checkpoint);
    assert.ok(responseAt >= 0 && checkpointAt > responseAt, "完整响应先持久化，才允许写可恢复checkpoint");
  });

  await check("legacy complete F2 replay forms a current candidate with zero calls and preserves original evidence", async () => {
    for (const withProcessedChunks of [true, false]) {
      const { p, failed } = await failedF2(true); const original = await makeLegacy(failed.id, withProcessedChunks);
      const originalLog = JSON.parse(original.log!);
      assert.equal("uses" in originalLog.calls[0].response.data.episodes[0], false);
      assert.ok(Array.isArray(originalLog.calls[0].response.data.episodes[0].assetKeys));
      const preview = (await stateApi.getFoundationState(p.id, db)).f2Recovery;
      assert.equal(preview?.replayRunId, failed.id); assert.equal(preview?.replayChunkCount, 3);
      assert.equal(preview?.resumeRunId, null);
      let calls = 0;
      await execute(p.id, await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id, replayOnly: true }), async () => {
        calls++; throw new Error("replay must never call a provider");
      }, "F2");
      assert.equal(calls, 0);
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), original);
      const state = await stateApi.getFoundationState(p.id, db);
      assert.equal(state.assetsReady, true); assert.equal(state.candidates.f2?.protocolVersion, contracts.F2_PROTOCOL_VERSION);
      assert.equal(state.ready, false, "离线复验不代跑Q1或发布");
      assert.equal(state.f2Recovery, null, "复验成功后不能继续推荐更旧失败稿");
      const replayed = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f2!.runId } });
      const log = JSON.parse(replayed.log!);
      for (const [index, call] of log.calls.entries()) {
        assert.equal(call.providerCallCount, 0); assert.equal(call.reusedFrom.runId, failed.id);
        assert.equal(call.taskPrompt, originalLog.calls[index].taskPrompt);
        assert.deepEqual(call.response, originalLog.calls[index].response);
        assert.equal(call.startedAt, originalLog.calls[index].startedAt);
        assert.equal(call.finishedAt, originalLog.calls[index].finishedAt);
        assert.notEqual(call.taskPrompt, call.revalidatedUnder.taskPrompt, "不能假称原模型收到新运输规则");
      }
    }
  });

  await check("a failed offline replay can replay its complete legacy calls again without claiming a new model input", async () => {
    const { p, failed } = await failedF2(true); await makeLegacy(failed.id);
    const noProvider: FoundationStageRunner = async () => { throw new Error("offline replay called provider"); };
    await execute(p.id, await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id, replayOnly: true }), noProvider, "F2");
    const first = (await stateApi.getFoundationState(p.id, db)).candidates.f2!;
    await db.pipelineRun.update({ where: { id: first.runId }, data: { status: "FAILED", error: "fixture failure after complete offline evidence" } });
    const original = await db.pipelineRun.findUniqueOrThrow({ where: { id: first.runId } });
    assert.equal((await stateApi.getFoundationState(p.id, db)).f2Recovery?.replayRunId, first.runId);
    await execute(p.id, await queue(p.id, ["F2"], "API", { resumeFromRunId: first.runId, replayOnly: true }), noProvider, "F2");
    const state = await stateApi.getFoundationState(p.id, db); assert.equal(state.assetsReady, true);
    const latest = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f2!.runId } });
    const call = JSON.parse(latest.log!).calls[0];
    assert.equal(call.providerCallCount, 0); assert.deepEqual(call.reusedFrom, { runId: first.runId, sequence: 1 });
    assert.equal(call.taskPrompt, JSON.parse(original.log!).calls[0].taskPrompt);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: first.runId } }), original);
  });

  await check("legacy processed chunks must still match the saved prior responses exactly", async () => {
    const { p, failed } = await failedF2(true); const legacy = await makeLegacy(failed.id);
    const log = JSON.parse(legacy.log!); const call = log.calls[1];
    call.input.prior.processedChunks[0].assets[0].appearances[0].state = "FAKE-FORGED-PRIOR-STATE";
    call.taskPrompt = call.taskPrompt.slice(0, call.taskPrompt.lastIndexOf("INPUT_JSON:\n")) + `INPUT_JSON:\n${JSON.stringify(call.input)}`;
    await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log) } });
    const original = await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } });
    let calls = 0;
    const token = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id, replayOnly: true });
    await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), /原prior|前片|已保存/);
    assert.equal(calls, 0);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), original);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), 0);
  });

  await check("current-protocol offline replay cannot downgrade a changed task by relabeling one call", async () => {
    for (const downgrade of [false, true]) {
      const { p, failed } = await failedF2(true); const log = JSON.parse(failed.log!);
      log.calls[0].taskPrompt = log.calls[0].taskPrompt.replace("OUTPUT_SCHEMA", "只交付另一种未经确认的结果，不按原用途。\n\nOUTPUT_SCHEMA");
      if (downgrade) log.calls[0].protocolVersion = "legacy-call-transport";
      await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log) } });
      let calls = 0; const token = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id, replayOnly: true });
      await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), /原task|复验|来源|协议|复用/);
      assert.equal(calls, 0);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), 0);
    }
  });

  await check("a forged legacy revalidation witness must match its directly referenced original call", async () => {
    const { p, failed } = await failedF2(true);
    const originId = randomUUID(); const untouched = JSON.parse(failed.log!); untouched.runId = originId;
    const origin = await db.pipelineRun.create({ data: { id: originId, projectId: p.id, stageCode: "F2", roleName: "F2", provider: failed.provider, model: failed.model,
      status: "FAILED", createdAt: new Date(failed.createdAt.getTime() - 1), inputSummary: failed.inputSummary, log: JSON.stringify(untouched) } });
    const log = JSON.parse(failed.log!); const call = log.calls[0];
    call.reusedFrom = { runId: originId, sequence: 1 };
    call.revalidatedUnder = { protocolVersion: contracts.F2_PROTOCOL_VERSION, taskPrompt: call.taskPrompt, input: structuredClone(call.input), startedAt: call.startedAt, finishedAt: call.finishedAt };
    call.providerCallCount = 0; call.protocolVersion = "legacy-call-transport";
    call.taskPrompt = call.taskPrompt.replace("OUTPUT_SCHEMA", "只交付另一种未经确认的结果，不按原用途。\n\nOUTPUT_SCHEMA");
    log.recovery = { resumeFromRunId: originId, replayOnly: true };
    const summary = JSON.parse(failed.inputSummary!); summary.recovery = log.recovery;
    await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log), inputSummary: JSON.stringify(summary) } });
    let calls = 0; const token = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id, replayOnly: true });
    await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), (error: Error) => {
      assert.doesNotMatch(error.message, /最新|更新/, "本负例必须命中原调用证据校验，不能被恢复时序护栏提前掩盖");
      assert.match(error.message, /原调用|来源|证据|复用/); return true;
    });
    assert.equal(calls, 0); assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: origin.id } }), origin);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), 0);
  });

  await check("incomplete legacy replay and legacy resume refuse without filling missing chunks", async () => {
    for (const replayOnly of [true, false]) {
      const { p, failed } = await failedF2(); const original = await makeLegacy(failed.id); let calls = 0;
      const token = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id, replayOnly });
      await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), /完整|缺|协议|复验|续跑|复用/);
      assert.equal(calls, 0); assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), original);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), 0);
    }
  });

  await check("legacy complete known-ref gap replays as pending data and READY Q1 still cannot publish", async () => {
    const { p, failed } = await failedF2(true); await makeLegacy(failed.id);
    const legacy = await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } });
    const log = JSON.parse(legacy.log!); log.calls[2].response.data.assets = [];
    log.calls[2].response.rawOutput = JSON.stringify(log.calls[2].response.data);
    await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log) } });
    const original = await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } });
    let calls = 0;
    await execute(p.id, await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id, replayOnly: true }), async () => {
      calls++; throw new Error("offline replay called provider");
    }, "F2");
    assert.equal(calls, 0); assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), original);
    const candidate = await stateApi.getFoundationState(p.id, db);
    assert.equal(candidate.assetsReady, true); assert.equal(candidate.dataReady, false);
    assert.equal(candidate.candidates.f2!.output.assets[0].appearances.some((appearance) => appearance.episode === 3), false, "旧缺口不能回填前集状态");
    assert.ok(candidate.dataIssues.length);
    await execute(p.id, await queue(p.id, ["Q1"]), async (stage, prompt, call) => {
      const input = parse(prompt);
      if (call.scope.includes(3)) assert.ok(input.dataIssues.some((issue: { severity: string }) => issue.severity === "BLOCKER"));
      else assert.equal(input.dataIssues.length, 0, "Q1资料缺口须按当前批范围投影");
      return runner(stage, prompt, call);
    }, "Q1");
    const reviewed = await stateApi.getFoundationState(p.id, db);
    assert.equal(reviewed.review?.output.verdict, "READY"); assert.equal(reviewed.ready, false); assert.equal(reviewed.reviewReady, false);
    assert.ok(reviewed.review?.publicationBlockers?.length);
    assert.equal(await db.asset.count({ where: { projectId: p.id } }), 0);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_APPROVED" } }), 0);
    const row = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: reviewed.candidates.f2!.id } });
    const forged = JSON.parse(row.content); forged.output.dataIssues = [];
    await db.sceneSnapshot.update({ where: { id: row.id }, data: { content: JSON.stringify(forged) } });
    assert.equal((await stateApi.getFoundationState(p.id, db)).dataReady, false, "不能信任传入空问题清单");
  });

  await check("explicit sourced background use stays background in the exact Q1 and approved packet", async () => {
    const p = await project(splitSource.slice(0, 2)); let reviewedBackground: unknown;
    await execute(p.id, await queue(p.id), async (stage, prompt, call) => {
      const result = await runner(stage, prompt, call);
      if (stage === "F2" && call.chunkIndex === 2) {
        result.data.assets = [];
        (result.data.episodes as Array<Record<string, unknown>>)[0].uses = [{ key: "person-jia", presence: "BACKGROUND", purpose: "回顾前集身份背景，不声明本集在场", sourceRefs: [{ episode: 1, startLine: 2, endLine: 2 }], sourceName: "甲" }];
      }
      if (stage === "Q1" && call.chunkIndex === 2) {
        const packet = parse(prompt).episodePackets[0]; reviewedBackground = packet.backgroundRefs;
        assert.deepEqual(packet.identities[0].appearances, []);
      }
      return result;
    });
    const state = await stateApi.getFoundationState(p.id, db); assert.equal(state.dataReady, true); assert.equal(state.ready, true);
    const packet = await stateApi.readApprovedEpisodeFoundation(p.id, 2, db);
    assert.deepEqual(packet.backgroundRefs, reviewedBackground); assert.deepEqual(packet.identities[0].appearances, []);
    assert.equal(packet.identities[0].name, "甲");
  });

  await check("checkpoint status cannot bypass response revalidation; malformed complete replay never calls", async () => {
    for (const replayOnly of [false, true]) {
      const { p, failed } = await failedF2(replayOnly);
      if (replayOnly) await makeLegacy(failed.id);
      const row = await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }); const log = JSON.parse(row.log!);
      log.calls[0].response.data.coverage = [999]; log.calls[0].status = "SUCCEEDED";
      await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log) } });
      let calls = 0; const token = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id, replayOnly });
      await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), /coverage|覆盖|范围|复用/);
      assert.equal(calls, 0);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), 0);
    }
  });

  await check("recovery refuses changed source, conditions, F1, model, original system or original task input", async () => {
    for (const drift of ["source", "conditions", "F1", "model", "system", "task", "purpose", "protocol"]) {
      const { p, failed } = await failedF2();
      const oldModel = process.env.DEEPSEEK_API_MODEL;
      try {
        if (drift === "source") {
          await db.episode.update({ where: { id: p.episodes[0].id }, data: { content: `${p.episodes[0].content}改源` } });
          await preprocessProject(p.id, db);
        }
        if (drift === "conditions") await db.project.update({ where: { id: p.id }, data: { style: "2D" } });
        if (["source", "conditions", "F1"].includes(drift)) await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
        if (drift === "model") process.env.DEEPSEEK_API_MODEL = "fixture-different-model";
        if (["system", "task", "purpose", "protocol"].includes(drift)) {
          const log = JSON.parse(failed.log!); const call = log.calls[0];
          if (drift === "system") call.systemPrompt += "\nchanged professional system";
          if (drift === "task") call.taskPrompt += "\nchanged task";
          if (drift === "protocol") call.protocolVersion = "legacy-call-transport";
          if (drift === "purpose") {
            call.input.consumer = "different consumer";
            call.taskPrompt = call.taskPrompt.slice(0, call.taskPrompt.lastIndexOf("INPUT_JSON:\n")) + `INPUT_JSON:\n${JSON.stringify(call.input)}`;
          }
          await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log) } });
        }
        let calls = 0; const token = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id });
        await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), /源|版本|输入|F1|model|模型|system|规则|task|任务|复用/);
        assert.equal(calls, 0, `${drift}不兼容必须拒绝，不能静默全新调用`);
      } finally {
        if (oldModel === undefined) delete process.env.DEEPSEEK_API_MODEL; else process.env.DEEPSEEK_API_MODEL = oldModel;
      }
    }
  });

  await check("public recovery queue rejects foreign runs, wrong-stage sources and missing replay source before launching", async () => {
    const { p, failed } = await failedF2(); const target = await project();
    await execute(target.id, await queue(target.id, ["F1"]), runner, "F1");
    const noProvider = { db, stageRunner: async () => { throw new Error("invalid recovery must never invoke a provider"); } };
    await assert.rejects(() => core.queueSingleFoundationStage("nonexistent-guard-target", "F1", { resumeFromRunId: failed.id }, noProvider), /没有找到项目/);
    await assert.rejects(() => core.queueSingleFoundationStage(target.id, "F2", { resumeFromRunId: failed.id, replayOnly: true }, noProvider), /同项目|本项目|未找到|复用|恢复/);
    await assert.rejects(() => core.queueSingleFoundationStage(p.id, "F1", { resumeFromRunId: failed.id }, noProvider), /同项目|来源|恢复|复用/);
    await assert.rejects(() => core.queueSingleFoundationStage(p.id, "F2", { replayOnly: true }, noProvider), /来源|resumeFromRunId|记录/);
    assert.equal(await db.pipelineRun.count({ where: { projectId: target.id, status: "QUEUED" } }), 0);
  });

  await check("ordinary F2 rerun uses new model calls and old recovery cannot replace its results", async () => {
    const { p, failed } = await failedF2(); let calls = 0;
    await execute(p.id, await queue(p.id, ["F2"]), async (...args) => { calls++; return runner(...args); }, "F2");
    assert.equal(calls, 3);
    calls = 0;
    await execute(p.id, await queue(p.id, ["F2"]), async (...args) => { calls++; return runner(...args); }, "F2");
    assert.equal(calls, 3);
    const before = await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } });
    calls = 0;
    const token = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id });
    await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), /最新|更新/);
    assert.equal(calls, 0);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), before);
  });

  await check("cancellation of the latest failed F2 resume stays canceled without publishing", async () => {
    const { p, failed } = await failedF2();
    const before = await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } });
    const token = await queue(p.id, ["F2"], "API", { resumeFromRunId: failed.id });
    await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
      await db.pipelineRun.update({ where: { id: call.runId }, data: { status: "CANCELED", error: "用户停止续跑" } });
      return runner(stage, prompt, call);
    }, "F2"), /停止|RUNNING/);
    const stopped = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, inputSummary: { contains: token } } });
    assert.equal(stopped.status, "CANCELED"); assert.equal(stopped.error, "用户停止续跑");
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), before);
  });
  console.log(`project foundation verification passed (${checks} scenarios; isolated SQLite; no live provider)`);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await db.$disconnect();
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
  rmSync(scratch, { recursive: true, force: true });
});
