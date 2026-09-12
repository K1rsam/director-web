import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { foundationChoiceCondition, loadFoundationChoices, appendFoundationChoiceRegistry } from "@/lib/foundation-choice-store";
import { loadFoundationInputs } from "@/lib/foundation-state";
import { presentationDecisionKey } from "@/lib/presentation-contracts";

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "director-scope-test-"));
  const path = join(directory, "test.db");
  const sqlite = new DatabaseSync(path);
  const migrations = join(import.meta.dirname, "../prisma/migrations");
  for (const name of readdirSync(migrations).sort()) if (/^\d/.test(name)) sqlite.exec(readFileSync(join(migrations, name, "migration.sql"), "utf8"));
  sqlite.close();
  const db = new PrismaClient({ datasourceUrl: `file:${path.replace(/\\/g, "/")}` });
  try {
    const project = await db.project.create({ data: { title: "范围兼容独立验证", episodes: { create: [1, 2, 3].map(number => ({ number, title: `第${number}集`, content: `第${number}集\n${number}-1 室内 日\n甲：保持原文。` })) } }, include: { episodes: true } });
    const base = { projectId: project.id, category: "声音", question: "如何表达声音？", options: '["原声","旁白"]', status: "CONFIRMED", userAnswer: "原声", ruleKey: "sound-identity" };
    const selected = await db.presentationContract.create({ data: { ...base, scopeMode: "SELECTED_EPISODES", targetEpisodeNumbers: "[2]" } });
    const all = await db.presentationContract.create({ data: { ...base, question: "全剧规则", ruleKey: "global", scopeMode: "ALL_EPISODES", episodeId: project.episodes[0].id } });
    const anchored = await db.presentationContract.create({ data: { ...base, ruleKey: "anchored", episodeId: project.episodes[2].id } });
    const unknown = await db.presentationContract.create({ data: { ...base, ruleKey: "unknown" } });
    const broken = await db.presentationContract.create({ data: { ...base, ruleKey: "broken", episodeId: "missing-episode" } });
    const modern = await db.presentationContract.create({ data: { ...base, ruleKey: null, note: JSON.stringify({ schema: "FOUNDATION_HUMAN_CHOICE_V1", sourceVersion: "v1", decisionKey: "new/key", episodes: [1, 3], sourceStages: ["F2"] }) } });
    assert.deepEqual(foundationChoiceCondition(selected, project.episodes).episodes, [2]);
    assert.deepEqual(foundationChoiceCondition(anchored, project.episodes).episodes, [3]);
    assert.equal(foundationChoiceCondition(all, project.episodes).scopeMode, "ALL_EPISODES");
    assert.equal(foundationChoiceCondition(unknown, project.episodes).scopeResolved, false);
    assert.equal(foundationChoiceCondition(broken, project.episodes).scopeResolved, false);
    assert.deepEqual(foundationChoiceCondition(modern, project.episodes).episodes, [1, 3]);
    assert.deepEqual(foundationChoiceCondition({ ...modern, note: JSON.stringify({ schema: "FOUNDATION_HUMAN_CHOICE_V1", sourceVersion: "v1", decisionKey: "context", episodes: [0], sourceStages: ["F1"] }) }, [{ id: "context", number: 0 }, ...project.episodes]).episodes, [0]);
    const choices = await loadFoundationChoices(db, project.id, "v1");
    const key = presentationDecisionKey({ category: selected.category, question: selected.question, rule_key: selected.ruleKey });
    assert.deepEqual(choices.registry.find(item => item.decisionKey === key)?.episodes, [2]);
    assert.equal(choices.registry.some(item => /unknown|broken/.test(item.decisionKey)), false);
    assert.match(choices.confirmed.find(item => item.id === unknown.id)!.reason!, /范围无法确认/);
    const remaining = appendFoundationChoiceRegistry(choices.registry, [{ decisionKey: key, kind: "PRODUCTION_CHOICE", question: "同一规则扩展", reason: "新范围", options: ["原声", "旁白"], recommended: "原声", recommendationReason: "已确认范围", evidence: "第3集", episodes: [2, 3] }], [1, 2, 3]);
    assert.deepEqual(remaining.find(item => item.decisionKey === key && item.status === "PENDING")?.episodes, [3]);
    const first = await loadFoundationInputs(project.id, db);
    assert.equal(first.presentationConditions.some(item => item.ruleKey === "unknown" || item.ruleKey === "broken"), false);
    assert.equal(first.presentationConditions.find(item => item.ruleKey === "global")?.episode, null);
    assert.deepEqual(first.presentationConditions.find(item => item.ruleKey === "sound-identity")?.episodes, [2]);
    await db.presentationContract.update({ where: { id: selected.id }, data: { targetEpisodeNumbers: "[3]" } });
    const second = await loadFoundationInputs(project.id, db);
    assert.notEqual(first.inputVersion, second.inputVersion);
    assert.deepEqual(second.presentationConditions.find(item => item.ruleKey === "sound-identity")?.episodes, [3]);
    await db.presentationContract.update({ where: { id: selected.id }, data: { ruleKey: "changed-rule" } });
    const third = await loadFoundationInputs(project.id, db);
    assert.notEqual(second.inputVersion, third.inputVersion);
    console.log("PresentationContract scope: selected/all/episodeId/unknown/new metadata/ruleKey/registry extension/version invalidation PASS (isolated temporary database)");
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
