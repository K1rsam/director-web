import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PIPELINE_STAGE_CONFIGS } from "@/lib/episode-pipeline-contracts";
import { PROJECT_FOUNDATION_STAGES, loadFoundationSystemPrompt } from "@/lib/project-foundation-contracts";
import { DIRECTOR_KNOWLEDGE_BASE_DIR, DIRECTOR_RULE_FILES } from "@/lib/director-rules";
import { loadStageSkillText } from "@/lib/pipeline-skills";

const skillNames = PIPELINE_STAGE_CONFIGS.map((stage) => stage.skill);

void (async () => {
  for (const stage of PROJECT_FOUNDATION_STAGES) {
    const promptFile = path.join(process.cwd(), "prompts", "foundation", `${stage.code}.md`);
    assert.ok(existsSync(promptFile), `发布包缺少第一阶段system正文：${stage.code}`);
    assert.equal(stage.skill, "", "第一阶段不得使用伪造Skill入口");
    assert.equal(loadFoundationSystemPrompt(stage.code), readFileSync(promptFile, "utf8"));
  }
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

  const originalSkillsDir = process.env.CODEX_SKILLS_DIR;
  try {
    process.env.CODEX_SKILLS_DIR = path.join(process.cwd(), ".agents", "skills");
    const bundledSkill = await loadStageSkillText("e0-narrative-rhythm-director");
    assert.match(bundledSkill, /name:\s*e0-narrative-rhythm-director/);
  } finally {
    if (originalSkillsDir === undefined) delete process.env.CODEX_SKILLS_DIR;
    else process.env.CODEX_SKILLS_DIR = originalSkillsDir;
  }

  console.log("release bundle verification passed");
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
