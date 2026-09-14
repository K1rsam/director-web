import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runFoundationDeliveryCall, DeliveryCallError, type DeliveryAttempt } from '../lib/foundation-delivery-call';
import { FoundationContractError, type FoundationIssue } from '../lib/project-foundation-contracts';
import { assertFoundationRequestBudget, type FoundationCallContext } from '../lib/project-foundation';
import type { RoleRunResult } from '../lib/role-runner';

const issue: FoundationIssue = { owner: 'PROGRAM', severity: 'BLOCKER', coordinate: 'changes.value', problem: '须为文本', sourceRefs: [] };
const original = { changes: { value: 17 }, preserved: '保存资料'.repeat(8000) };
const prompt = `INPUT_JSON:\n${JSON.stringify({ scope: [1], source: '源'.repeat(174000) })}`;
const context: FoundationCallContext = { provider: 'CLI', role: { code: 'Q1', skill: '', systemPrompt: '规则', model: 'offline-model', reasoningEffort: 'low' }, sessionMode: 'ephemeral', runId: 'offline', batchToken: 'offline', sourceVersion: 'v1', inputVersion: 'v1', chunkIndex: 1, scope: [1] };
const response = (data: unknown): RoleRunResult => ({ data: data as Record<string, unknown>, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null });
const validate = (value: unknown) => {
  const data = value as typeof original;
  if (typeof data.changes.value !== 'string') throw new FoundationContractError('格式错误', [issue]);
  assert.equal(data.preserved, original.preserved);
  return data;
};
const patch = { format: 'FIELD_REPAIR_V1', patches: [{ path: 'changes.value', value: '17' }] };
const saved: DeliveryAttempt = { sequence: 1, kind: 'INITIAL', scope: [1], systemPrompt: '规则', taskPrompt: prompt, provider: 'CLI', model: 'offline-model', reasoningEffort: 'low', startedAt: new Date(0).toISOString(), status: 'FAILED', requestOutcome: 'RESPONDED', providerCallCount: 1, response: response(original), issues: [issue] };

async function main() {
  const adapter = readFileSync(new URL('../lib/foundation-delivery-call.ts', import.meta.url), 'utf8');
  assert.match(adapter, /runRoleByProvider\(\{ provider, projectId: input\.context\.projectId!, role: requestRole,/);
  assertFoundationRequestBudget('规则', prompt);
  for (const resume of [false, true]) {
    let calls = 0;
    const result = await runFoundationDeliveryCall({ stage: 'Q1', prompt, context, validate, ...(resume ? { resumeFrom: saved } : {}), takeRepairBudget: async () => true,
      runner: async (_stage, text, requestContext) => {
        calls++;
        if (!resume && calls === 1) { assert.equal(requestContext.role.systemPrompt, '规则'); return response(original); }
        assert.match(requestContext.role.systemPrompt!, /机械JSON字段格式修复/);
        assert.match(requestContext.role.systemPrompt!, /不输出全量岗位结果或coverage/);
        assert.equal(requestContext.role.model, context.role.model);
        assert.equal(requestContext.role.reasoningEffort, 'low');
        assert(text.length < 3000);
        assert(!text.includes('保存资料')); assert(!text.includes('源'));
        assertFoundationRequestBudget('规则', text);
        const envelope = JSON.parse(text.split('INPUT_JSON:\n').at(-1)!);
        assert.deepEqual(envelope.repairRequest.fields, [{ path: 'changes.value', present: true, value: 17, problem: '须为文本' }]);
        return response(patch);
      } });
    assert.equal(calls, resume ? 1 : 2); assert.equal(result.output.changes.value, '17');
    assert.match(result.attempts.at(-1)!.systemPrompt, /机械JSON字段格式修复/);
    assert.equal(saved.response?.data?.preserved, original.preserved);
  }
  for (const patches of [
    [{ path: 'preserved', value: '越界' }],
    [{ path: '__proto__.polluted', value: true }],
    [{ path: 'changes.value', value: '17' }, { path: 'changes.value', value: '18' }],
    [{ path: 'changes.value' }],
  ]) {
    await assert.rejects(runFoundationDeliveryCall({ stage: 'Q1', prompt, context, validate, resumeFrom: saved, takeRepairBudget: async () => true, runner: async () => response({ format: 'FIELD_REPAIR_V1', patches }) }), DeliveryCallError);
  }
  let syntaxCalls = 0;
  await assert.rejects(runFoundationDeliveryCall({ stage: 'Q1', prompt, context, validate, resumeFrom: { ...saved, response: { rawOutput: '{"invalid":' + ' '.repeat(30000) } }, takeRepairBudget: async () => assert.fail('unsafe syntax repair must not reserve budget'), runner: async () => { syntaxCalls++; return response(patch); } }), /JSON损坏且无法安全机械解析/);
  assert.equal(syntaxCalls, 0);
  console.log('PASS large initial request, bounded field repair, paid-response resume, unauthorized paths and damaged JSON stops before repair budget');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
