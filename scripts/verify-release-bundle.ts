import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PIPELINE_STAGE_CONFIGS } from "@/lib/episode-pipeline-contracts";
import { PROJECT_FOUNDATION_STAGES } from "@/lib/project-foundation-contracts";
import { DIRECTOR_KNOWLEDGE_BASE_DIR, DIRECTOR_RULE_FILES } from "@/lib/director-rules";
import { loadStageSkillText } from "@/lib/pipeline-skills";

const skillNames = [
  ...PROJECT_FOUNDATION_STAGES.map((stage) => stage.skill),
  ...PIPELINE_STAGE_CONFIGS.map((stage) => stage.skill)
];

void (async () => {
  for (const skillName of skillNames) {
    const skillFile = path.join(process.cwd(), ".agents", "skills", skillName, "SKILL.md");
    assert.ok(existsSync(skillFile), `发布包缺少岗位 Skill：${skillName}`);
  }

  const expectedKnowledgeDir = path.join(process.cwd(), "knowledge", "director");
  assert.equal(DIRECTOR_KNOWLEDGE_BASE_DIR, expectedKnowledgeDir, "导演规则默认目录必须随仓库发布");
  for (const [, title, relativePath] of DIRECTOR_RULE_FILES) {
    assert.ok(
      existsSync(path.join(expectedKnowledgeDir, relativePath)),
      `发布包缺少导演规则：${title}`
    );
  }

  const originalHome = process.env.HOME;
  const originalSkillsDir = process.env.CODEX_SKILLS_DIR;
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "director-release-home-"));
  try {
    process.env.HOME = isolatedHome;
    delete process.env.CODEX_SKILLS_DIR;
    const bundledSkill = await loadStageSkillText("e0-narrative-rhythm-director");
    assert.match(bundledSkill, /name:\s*e0-narrative-rhythm-director/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSkillsDir === undefined) delete process.env.CODEX_SKILLS_DIR;
    else process.env.CODEX_SKILLS_DIR = originalSkillsDir;
    await rm(isolatedHome, { recursive: true, force: true });
  }

  console.log("release bundle verification passed");
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
