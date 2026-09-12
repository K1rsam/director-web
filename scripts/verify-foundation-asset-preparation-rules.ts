/** Offline prompt-contract checks only: no provider, database, or model-quality verdict. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const failures: string[] = [];
for (const role of ['F2', 'Q1']) {
  const prompt = readFileSync(new URL(`../prompts/foundation/${role}.md`, import.meta.url), 'utf8');
  const checks: [string, RegExp][] = [
    ['independent images require an identity/look/continuity purpose', /稳定身份.*新外观.*持续连续性/],
    ['size, pose and instantaneous destruction are not automatic derivatives', /尺度.*姿态.*瞬时破坏.*不自动.*DERIVE/],
    ['ordinary objects stay in source, not an INLINE inventory', /普通物件.*原文.*不.*INLINE/],
    ['continuity considers relevant preceding facts', /本批原文.*相关前批事实/],
    ['continuity is neither reset each episode nor inherited forever', /每集重置.*永久.*继承/],
    ['necessary looks and props cannot be sacrificed to reduce counts', /必要服装.*真实造型.*关键物.*减数.*删/],
    ['local audio use cannot erase a previously visible identity', /本批.*VO.*AUDIO.*不代表全剧无实体.*不能.*基线.*纯声音/],
    ['ordinary appearance still needs stable references for sustained interaction', /连续可辨外观.*多镜.*脱离.*交互.*普通物.*稳定引用/],
    ['bundling requires a verified replacement, not an assumed asset library', /只有已验证.*角色\/场景基线.*现有素材.*一致承载.*并.*配套.*不能假设素材库/],
  ];
  for (const [name, pattern] of checks) {
    try { assert.match(prompt, pattern); console.log(`PASS ${role}: ${name}`); }
    catch { failures.push(`${role}: ${name}`); console.error(`FAIL ${role}: ${name}`); }
  }
}
assert.deepEqual(failures, [], 'asset preparation prompt declarations');
console.log('PASS offline declarations only; actual generation and asset completeness remain untested');
