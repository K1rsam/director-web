import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

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
    const baseline='d293e18'; // Last 3008 commit before stage 1.5 integration.
    for (const stage of ['F1','F2', 'Q1'] as const) {
      const file=`prompts/foundation/${stage}.md`;
      const original = readFileSync(file);
      assert.deepEqual(Buffer.from(loadFoundationSystemPrompt(stage),'utf8'),original,'Runtime system prompt must preserve every checked-out byte');
      assert.equal(hashFoundationPrompt(loadFoundationSystemPrompt(stage)),hashFoundationPrompt(original.toString('utf8')));
      const baselineBlob=execFileSync('git',['rev-parse',`${baseline}:${file}`],{encoding:'utf8'}).trim();
      const currentBlob=execFileSync('git',['hash-object','--path',file,file],{encoding:'utf8'}).trim();
      assert.equal(currentBlob,baselineBlob,'Git canonical bytes must match pre-1.5 baseline (checkout CRLF handled by git)');
    }
    for(const file of ['lib/project-foundation-contracts.ts','lib/foundation-production-contracts.ts','lib/foundation-production-prompts.ts','app/projects/[projectId]/foundation/handoff/page.tsx','app/projects/[projectId]/foundation/handoff/download/route.ts']){
      assert.equal(execFileSync('git',['hash-object','--path',file,file],{encoding:'utf8'}).trim(),execFileSync('git',['rev-parse',`${baseline}:${file}`],{encoding:'utf8'}).trim(),`${file} must preserve baseline`);
    }
    const project = await prisma.project.create({ data: { title: 'isolated P3 preference test', episodes: { create: { number: 1, content: '第1集\n1-1 客厅 日 内\n人物：甲\n甲：你好。' } } } });
    await preprocessProject(project.id, prisma);
    let task = await queueFoundationDelivery(project.id, {}, prisma);
    assert.equal(task.autoAssetPrompts, true, 'New runs default to independent visual fact preparation.');
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
    console.log('PASS: F1/F2/Q1 system bytes, schemas and P4 match pre-1.5 baseline; default, opt-out, continuation and re-enable persisted. No model calls.');
  } finally { await prisma.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
