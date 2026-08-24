import { readFile } from "node:fs/promises";
import path from "node:path";

export const DIRECTOR_KNOWLEDGE_BASE_DIR =
  process.env.DIRECTOR_KNOWLEDGE_BASE_DIR ?? path.join(process.cwd(), "knowledge", "director");

export type DirectorRuleSource = {
  key: string;
  title: string;
  filePath: string;
  content: string;
};

export type DirectorRuleContextSummary = {
  knowledgeBaseDir: string;
  sources: Array<{
    key: string;
    title: string;
    filePath: string;
    summary: string[];
  }>;
};

export const TASK_SCHEMA_V4_REQUIRED_FIELDS = [
  "任务范围",
  "成熟度/复杂度",
  "项目口径",
  "本集摘要",
  "本场原文",
  "场次快照",
  "导演表现层",
  "Seedance预算",
  "稳定性锁",
  "镜头语言",
  "六项证据卡",
  "单元六项锁",
  "剧情覆盖",
  "降尺度",
  "资产索引",
  "全剧记忆快照",
  "本集上下文快照",
  "时长和台词容量",
  "输出要求"
] as const;

export const DIRECTOR_RULE_FILES = [
  ["asset-id", "资产ID规则", "04 资产登记/资产ID规则.md"],
  ["scene-snapshot-template", "场次快照模板", "07 模板/场次快照模板.md"],
  ["task-schema-v4-template", "TEMPLATE-subagent任务包", "07 模板/TEMPLATE-subagent任务包.md"],
  ["task-package-rules", "subagent任务包模板", "05 任务包与并发/subagent任务包模板.md"],
  ["seedance-core", "Seedance2.0核心规则", "02 Seedance提示词/Seedance2.0核心规则.md"],
  ["seedance-stability", "Seedance稳定性限制", "02 Seedance提示词/Seedance稳定性限制.md"],
  ["duration-dialogue", "时长与台词计算规则", "02 Seedance提示词/时长与台词计算规则.md"],
  ["director-layer", "导演表现层规范", "03 导演表现层/导演表现层规范.md"]
] as const;

export async function loadDirectorRuleSources(
  knowledgeBaseDir = DIRECTOR_KNOWLEDGE_BASE_DIR
): Promise<DirectorRuleSource[]> {
  return Promise.all(
    DIRECTOR_RULE_FILES.map(async ([key, title, relativePath]) => {
      const filePath = path.join(/*turbopackIgnore: true*/ knowledgeBaseDir, relativePath);
      return {
        key,
        title,
        filePath,
        content: await readFile(/*turbopackIgnore: true*/ filePath, "utf8")
      };
    })
  );
}

export async function buildDirectorRuleContextSummary(
  knowledgeBaseDir = DIRECTOR_KNOWLEDGE_BASE_DIR
): Promise<DirectorRuleContextSummary> {
  const sources = await loadDirectorRuleSources(knowledgeBaseDir);

  return {
    knowledgeBaseDir,
    sources: sources.map((source) => ({
      key: source.key,
      title: source.title,
      filePath: source.filePath,
      summary: summarizeRuleContent(source.content)
    }))
  };
}

export function summarizeRuleContent(content: string, maxItems = 12): string[] {
  const lines = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("---") &&
        !line.startsWith("type:") &&
        !line.startsWith("status:") &&
        !line.startsWith("version:") &&
        !line.startsWith("tags:")
    );

  const selected = lines.filter((line) => {
    if (line.startsWith("#")) return true;
    if (line.startsWith("- ")) return true;
    return /TASK_SCHEMA_V4|必须|禁止|规则|字段|模板|闸门|资产|场次|快照|Seedance|时长|台词/.test(line);
  });

  return selected.slice(0, maxItems).map((line) => line.replace(/^#+\s*/, ""));
}
