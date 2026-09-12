import { assertSourceVersion, FoundationContractError, hashFoundationPrompt, type SourceIndex } from './project-foundation-contracts';
import type { ProductionOptimization, SceneFieldPatch } from './foundation-production-contracts';

function fail(coordinate: string, problem: string): never {
  throw new FoundationContractError(`${coordinate}: ${problem}`, [{ severity: 'BLOCKER', owner: 'PROGRAM', coordinate, problem, sourceRefs: [] }]);
}

/** Move only a source-verified first-segment declaration onto the existing scene. */
export function normalizeLightSceneEdit(output: ProductionOptimization, index: SourceIndex, scenes: { episode: number; sceneKey: string; sourceRange: { start: number; end: number } }[]): ProductionOptimization {
  assertSourceVersion(index, index.version);
  const normalized = structuredClone(output), plans = normalized.changes.sceneSplits;
  if (!plans?.length) return normalized;
  const remaining: typeof plans = [];
  for (const [i, plan] of plans.entries()) {
    const at = `changes.sceneSplits.${i}`, source = index.episodes.find(episode => episode.number === plan.episode);
    if (!source) fail(`${at}.episode`, '原文索引中不存在该集');
    if (plan.sourceHash !== hashFoundationPrompt(source.content)) fail(`${at}.sourceHash`, '原文版本不匹配');
    const matches = scenes.filter(scene => scene.episode === plan.episode && scene.sceneKey === plan.sceneKey);
    if (matches.length !== 1) fail(`${at}.sceneKey`, '必须指向唯一的现有场次');
    const range = matches[0].sourceRange;
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > source.content.length) fail(`${at}.sourceRange`, '现有场次的原文边界无效');
    const first = plan.cuts[0];
    if (!first) fail(`${at}.cuts`, '缺少拆场位置');
    const starts = [0];
    for (const match of source.content.matchAll(/\r\n|\n|\r/g)) starts.push(match.index + match[0].length);
    const offset = starts[first.startLine - 1];
    if (!Number.isSafeInteger(first.startLine) || offset === undefined || offset < range.start || offset >= range.end) fail(`${at}.cuts.0.startLine`, '首个切点不在现有场次原文范围内');
    const body = source.content.slice(offset, starts[first.startLine] ?? source.content.length).replace(/(?:\r\n|\n|\r)$/, '');
    if (typeof first.anchor !== 'string' || !first.anchor.trim() || first.anchor !== body) fail(`${at}.cuts.0.anchor`, '首个切点须逐字匹配对应行原文');
    if (offset === range.start) {
      const fields = (['location', 'interiorExterior', 'timeOfDay', 'timeLayer'] as const).filter(field => first[field] !== undefined);
      if (fields.length) {
        const patches = normalized.changes.scenes ??= [];
        let patchIndex = patches.findIndex(patch => patch.episode === plan.episode && patch.sceneKey === plan.sceneKey);
        if (patchIndex < 0) {
          patchIndex = patches.length;
          patches.push({ episode: plan.episode, sceneKey: plan.sceneKey });
        }
        const patch: SceneFieldPatch = patches[patchIndex];
        for (const field of fields) {
          if (patch[field] !== undefined && patch[field] !== first[field]) fail(`changes.scenes.${patchIndex}.${field}`, '首段字段与显式场次修改冲突');
          patch[field] = first[field];
        }
      }
      plan.cuts = plan.cuts.slice(1);
    }
    if (plan.cuts.length) remaining.push(plan);
  }
  if (remaining.length) normalized.changes.sceneSplits = remaining;
  else delete normalized.changes.sceneSplits;
  return normalized;
}
