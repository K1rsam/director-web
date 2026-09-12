/** Method-envelope checks only. They do not grade a model response. */
import assert from 'node:assert/strict';
import { PRODUCTION_OUTPUT_SCHEMAS, buildProductionFoundationPrompt } from '@/lib/foundation-production-prompts';
import { loadFoundationSystemPrompt } from '@/lib/project-foundation-contracts';

const asset = PRODUCTION_OUTPUT_SCHEMAS.F2.assets[0] as Record<string, unknown>;
assert.equal(typeof asset.role, 'string', 'F2 must declare its supported story-role field');
assert.equal(typeof asset.relationNote, 'string', 'story relationship needs its own field, not an image-source key');
const f2 = loadFoundationSystemPrompt('F2');
const q1 = loadFoundationSystemPrompt('Q1');
assert.match(f2, /主角.*配角.*反派.*路人/);
assert.match(f2, /独立.*神兽|神兽.*独立/);
assert.match(f2, /relationNote/);
assert.match(f2, /子形象.*不等于.*独立|子形象.*不代表.*独立/);
assert.match(f2, /INLINE/);
assert.match(q1, /剧情关联/);
const condition = { category: 'asset_identity', question: '本项目的灵兽身份', answer: '用户确认：灵兽为独立个体，不按人物本体变身解释。' };
const input = { scope: [1], project: { title: '隔离方法检查' }, presentationConditions: [condition], source: { schema: 'NUMBERED_SOURCE_V1', episodes: [{ number: 1, lines: [[1, '守护兽出现在人物身侧。\n']] }] } };
const snapshot = JSON.stringify(input);
const prompt = buildProductionFoundationPrompt('F2', input);
assert.deepEqual(JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!), input);
assert.equal(JSON.stringify(input), snapshot);
assert.ok(!buildProductionFoundationPrompt('F2', { ...input, presentationConditions: [] }).includes(condition.answer), 'a project-specific interpretation is not a new-project default');
console.log('PASS role/relationship/state method envelope and project-scope separation (not model quality)');
