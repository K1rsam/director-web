import test from 'node:test';
import assert from 'node:assert/strict';
import { assetGenerationJob, generationBlocksNewJob, generationProgress } from './generationState.ts';
import type { Job } from './types.ts';

const job = (status: string, extra: Partial<Job> = {}): Job => ({ id: status, provider: 'dreamina', kind: 'image', assetId: 'a', status, ...extra });
test('preparation, paused recovery and unknown submission retain asset generation ownership', () => {
  for (const status of ['queued', 'preparing', 'ready', 'submitting', 'submitted', 'processing', 'downloading', 'auth_required', 'submission_unknown', 'query_failed', 'download_failed', 'waiting_dependency', 'succeeded']) assert.equal(generationBlocksNewJob(job(status)), true, status);
  for (const status of ['downloaded', 'failed', 'blocked', 'stale', 'closed_by_user']) assert.equal(generationBlocksNewJob(job(status)), false, status);
  assert.equal(generationBlocksNewJob(job('running', { kind: 'workflow' })), false);
});
test('asset status prioritizes unresolved ownership and isolates other assets', () => {
  const unknown = job('submission_unknown', { createdAt: '2026-10-03' });
  assert.equal(assetGenerationJob([job('downloaded', { createdAt: '2026-10-04' }), unknown, job('preparing', { assetId: 'b' })], 'a'), unknown);
  assert.equal(assetGenerationJob([job('failed', { createdAt: '2026-10-03' }), job('closed_by_user', { createdAt: '2026-10-04' })], 'a')?.status, 'closed_by_user');
  assert.match(generationProgress(unknown), /未取得云端回执/);
  assert.match(generationProgress(job('preparing')), /尚未进入生成提交/);
  assert.equal(generationProgress(job('waiting_dependency')), '等待来源图片，完成后自动继续。');
  assert.equal(generationProgress(job('downloaded')), '原图已保存，可查看当前图片与历史。');
});
