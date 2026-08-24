import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type StageRule = { name: string; body: string };

const RULES_DIR = path.join(process.cwd(), "knowledge", "rules");
const cache = new Map<string, StageRule[] | null>();

/** 按岗位读取适用规则（knowledge/rules/*.md 的 frontmatter stages 命中即注入）。 */
export function loadStageRules(stageCode: string, flags: { crowd?: boolean } = {}): StageRule[] {
  const key = `${stageCode}|${flags.crowd ? "crowd" : ""}`;
  if (cache.has(key)) return cache.get(key) ?? [];
  let rules: StageRule[] = [];
  try {
    for (const file of readdirSync(RULES_DIR)) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(path.join(RULES_DIR, file), "utf8");
      const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
      if (!frontmatter) continue;
      const meta: Record<string, unknown> = {};
      for (const line of frontmatter[1].split("\n")) {
        const match = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
        if (match) meta[match[1]] = match[2].trim();
      }
      const stages = String(meta.stages ?? "");
      if (!stages.split(",").map((s) => s.trim()).includes(stageCode)) continue;
      const appliesWhen = String(meta.applies_when ?? "");
      if (appliesWhen === "crowd" && !flags.crowd) continue;
      const body = text.slice(frontmatter[0].length).trim();
      rules.push({ name: String(meta.name ?? file), body: body.slice(0, 2400) });
    }
  } catch {
    rules = [];
  }
  cache.set(key, rules);
  return rules;
}
