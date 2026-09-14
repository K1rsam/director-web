import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  const backup = process.argv[2];
  if (!backup) throw new Error('Provide a consistent SQLite backup; the live database is never changed.');
  const directory = path.resolve('outputs/p3-boundary-tests'); mkdirSync(directory, { recursive: true });
  const database = path.join(directory, `test-${Date.now()}.db`); copyFileSync(backup, database);
  process.env.DATABASE_URL = `file:${database.replaceAll('\\', '/')}`;
  const { prisma } = await import('../lib/prisma');
  const { queueFoundationDelivery, stopFoundationDelivery, getFoundationDeliveryState } = await import('../lib/foundation-delivery');
  const { preprocessProject } = await import('../lib/project-preprocess');
  const { loadFoundationSystemPrompt, hashFoundationPrompt } = await import('../lib/project-foundation-contracts');
  try {
    const boundary = readFileSync('prompts/foundation/asset-subject-boundaries-v1.md', 'utf8').trim();
    for (const stage of ['F2', 'Q1'] as const) {
      const original = readFileSync(`prompts/foundation/${stage}.md`, 'utf8');
      assert.ok(loadFoundationSystemPrompt(stage).includes(boundary));
      assert.notEqual(hashFoundationPrompt(loadFoundationSystemPrompt(stage)), hashFoundationPrompt(original));
    }
    assert.equal(loadFoundationSystemPrompt('F1'), readFileSync('prompts/foundation/F1.md', 'utf8'));
    const project = await prisma.project.create({ data: { title: 'isolated P3 preference test', episodes: { create: { number: 1, content: '第1集\n1-1 客厅 日 内\n人物：甲\n甲：你好。' } } } });
    await preprocessProject(project.id, prisma);
    let task = await queueFoundationDelivery(project.id, {}, prisma);
    assert.equal(task.autoAssetPrompts, true, 'New runs default to text prompt preparation.');
    await stopFoundationDelivery(project.id, task.id, prisma);
    task = await queueFoundationDelivery(project.id, { autoAssetPrompts: false }, prisma);
    assert.equal(task.autoAssetPrompts, false);
    assert.equal((await getFoundationDeliveryState(project.id, prisma)).task?.autoAssetPrompts, false, 'Unchecked choice persists.');
    await stopFoundationDelivery(project.id, task.id, prisma);
    task = await queueFoundationDelivery(project.id, {}, prisma);
    assert.equal(task.autoAssetPrompts, false, 'Continuation preserves explicit opt-out.');
    await stopFoundationDelivery(project.id, task.id, prisma);
    task = await queueFoundationDelivery(project.id, { autoAssetPrompts: true }, prisma);
    assert.equal(task.autoAssetPrompts, true);
    await stopFoundationDelivery(project.id, task.id, prisma);
    console.log('PASS: F2/Q1 ownership rules versioned; F1 unchanged; default, opt-out, continuation and re-enable persisted. No model calls.');
  } finally { await prisma.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
