/**
 * 打斗分支（预留接口，现阶段不特化）。
 *
 * 定位：识别剧本中的打斗/战斗片段并专门优化 Seedance 打斗生成（动作链、力量感、受击反应等）。
 * 现阶段只留接口与规则仓库占位；规则命中类别 combat 时规则引擎会自动注入（见 knowledge/rules/combat/README.md）。
 *
 * 未来接入点：
 * 1. 规则仓库 knowledge/rules/combat/*.md（applies_when: combat）；
 * 2. E1 对打斗片段打标（shot_function 新增"打斗镜"枚举）；
 * 3. 打斗单元专属编译模板（动作节点、力量反馈、武器跟随）。
 */
export type CombatSegment = {
  sceneId: string;
  nodeIds: string[];
  severity: "轻冲突" | "战斗" | "激烈战斗";
};

export function detectCombatSegments(_nodes: Array<{ text: string }>): CombatSegment[] {
  // 预留：按关键词（打斗/交手/拳/剑/撕咬…）与动作密度识别，当前返回空
  return [];
}
