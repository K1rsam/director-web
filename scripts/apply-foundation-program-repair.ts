/** Reviewed, source-bound maintenance only. Dry run by default; no provider entry point. */
import { readFileSync } from 'node:fs';
import { prisma } from '@/lib/prisma';
import { previewFoundationProgramRepair, applyFoundationProgramRepair } from '@/lib/foundation-delivery';

async function main() {
  const args = process.argv.slice(2), planAt = args.indexOf('--plan');
  if (planAt < 0 || !args[planAt + 1] || args.some((arg, index) => index !== planAt + 1 && !['--plan', '--apply'].includes(arg))) throw new Error('用法：--plan 已核对的修正.json [--apply]；默认只预览。');
  const correction = JSON.parse(readFileSync(args[planAt + 1], 'utf8')) as Parameters<typeof applyFoundationProgramRepair>[1] & { projectId: string };
  if (!correction.projectId || !correction.expectedRevision || !Array.isArray(correction.scope)) throw new Error('修正须明确项目、当前revision与集范围。');
  if (!args.includes('--apply')) {
    const { edit, sceneCountAfter } = await previewFoundationProgramRepair(correction.projectId, correction);
    console.log(JSON.stringify({ mode: 'PREVIEW', projectId: correction.projectId, sceneCountAfter, splitKeys: edit.changes.sceneSplits?.map(plan => `${plan.episode}:${plan.sceneKey}`),
      closeTodoIds: edit.resolvedUnresolved ?? [], deferTodoIds: correction.defer?.map(item => item.id) ?? [], providerCalls: 0 }));
    return;
  }
  const result = await applyFoundationProgramRepair(correction.projectId, correction);
  console.log(JSON.stringify({ mode: 'APPLIED', projectId: correction.projectId, revision: result.document.revision, complete: result.complete, action: result.action,
    episodes: result.totalEpisodes, assetCoverage: result.availableEpisodes, editedCoverage: result.editedEpisodes, remainingIssues: result.issues.length,
    laterStageNotes: result.document.editorialTodos.filter(todo => todo.owner === 'STAGE2').length, providerCalls: 0, historicalProviderCalls: result.task?.addedCalls }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
