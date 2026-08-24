/**
 * 岗位 Skill 加载器（API 执行模式用）
 *
 * CLI 模式由 Codex 的技能系统按 `$skill` 自动加载；API 模式没有技能系统，
 * 需要把同一份 Skill 制度稿作为 system 提示发送给 DeepSeek，保证两种执行
 * 方式使用完全相同的岗位规则。
 *
 * 读取位置：`CODEX_SKILLS_DIR` 显式目录；未设置时优先读取仓库内
 * `.agents/skills`，再兼容用户级 `~/.agents/skills` 与旧目录
 * `~/.codex/skills`。按需拼接 `references/*.md` 参考层（条件规则卡）。
 *
 * 环境变量：
 *   CODEX_SKILLS_DIR              指定 Skill 安装目录（默认 ~/.codex/skills）
 *   DEEPSEEK_API_SKILL_REFERENCES 设 "0" 时不携带 references 参考层
 */
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function loadStageSkillText(skillName: string): Promise<string> {
  const skillsDirs = process.env.CODEX_SKILLS_DIR
    ? [process.env.CODEX_SKILLS_DIR]
    : [
        path.join(process.cwd(), ".agents", "skills"),
        path.join(os.homedir(), ".agents", "skills"),
        path.join(os.homedir(), ".codex", "skills")
      ];

  let skillDir = "";
  let mainText = "";
  for (const skillsDir of skillsDirs) {
    const candidateDir = path.join(skillsDir, skillName);
    try {
      mainText = await readFile(path.join(candidateDir, "SKILL.md"), "utf8");
      skillDir = candidateDir;
      break;
    } catch {
      // 继续尝试下一层技能目录。
    }
  }
  if (!skillDir) {
    throw new Error(
      `未找到岗位 Skill「${skillName}」。已检查：${skillsDirs.join("、")}。` +
        "请保留仓库内 .agents/skills，或用 CODEX_SKILLS_DIR 指定安装目录。"
    );
  }

  const parts = [mainText.trim()];
  if (process.env.DEEPSEEK_API_SKILL_REFERENCES !== "0") {
    const referencesDir = path.join(skillDir, "references");
    try {
      const files = (await readdir(referencesDir)).filter((file) => file.endsWith(".md")).sort();
      for (const file of files) {
        const content = await readFile(path.join(referencesDir, file), "utf8");
        parts.push(`\n\n<!-- 参考层：${file}（按需命中规则，未命中可不启用） -->\n\n${content.trim()}`);
      }
    } catch {
      // 该岗位没有参考层，忽略
    }
  }
  return parts.join("\n");
}
