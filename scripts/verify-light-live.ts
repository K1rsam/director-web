/** Explicit bounded live check, isolated from the user's project/database. Never part of npm verify. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { queueFoundationDelivery, executeFoundationDelivery, getFoundationDeliveryState } from '@/lib/foundation-delivery';
import { runRoleByProvider } from '@/lib/role-runner';
import { buildLightEpisodePackets } from '@/lib/light-foundation-supply';

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Real provider calls require explicit --live.');
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const sourceDb = arg('--source-db'), projectId = arg('--project-id'), numbers = arg('--episodes').split(',').map(Number), maxCalls = Number(arg('--max-calls'));
  if (!sourceDb || !/^[a-z0-9-]+$/i.test(projectId) || !numbers.length || numbers.some(n => !Number.isSafeInteger(n) || n < 0) || !Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 3) throw new Error('Invalid bounded live parameters.');
  const rows = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', sourceDb, `SELECT number,title,content FROM Episode WHERE projectId='${projectId}' AND number IN (${numbers.join(',')}) ORDER BY number;`], { encoding: 'utf8' })) as { number: number; title: string | null; content: string }[];
  const [sourceProject] = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', sourceDb, `SELECT title,style,aspectRatio,executionMode FROM Project WHERE id='${projectId}';`], { encoding: 'utf8' })) as { title: string; style: string | null; aspectRatio: string; executionMode: string }[];
  if (rows.length !== numbers.length || !sourceProject) throw new Error('Exact sample scope not found.');
  const resumeDb = process.argv.includes('--resume-db') ? arg('--resume-db') : null;
  const directory = resumeDb ? path.dirname(resumeDb) : mkdtempSync(path.join(tmpdir(), 'light-stage1-live-'));
  const dbUrl = `file:${resumeDb ?? `${directory}/test.db`}`;
  if (!resumeDb) {
    copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, DATABASE_URL: dbUrl, RUST_LOG: 'info' }, stdio: 'pipe' });
  }
  const db = new PrismaClient({ datasourceUrl: dbUrl }); let calls = 0;
  try {
    const project = resumeDb ? await db.project.findUniqueOrThrow({ where: { id: arg('--resume-project') } }) : await db.project.create({ data: { ...sourceProject, title: `轻量真实小样 ${numbers.join('/')}`, episodes: { create: rows } } });
    const task = await queueFoundationDelivery(project.id, {}, db);
    console.log(JSON.stringify({ directory, episodes: numbers, provider: task.provider, maxCalls }));
    await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt, context) => {
      if (calls >= maxCalls) throw Object.assign(new Error('已达到真实小样调用上限，保留结果，不继续付费。'), { requestOutcome: 'NOT_SENT' });
      if (stage === 'F1') throw Object.assign(new Error('清晰两集小样不应调用F1。'), { requestOutcome: 'NOT_SENT' });
      calls++; console.log(JSON.stringify({ call: calls, stage, scope: context.scope, startedAt: new Date().toISOString() }));
      return runRoleByProvider({ projectId: project.id, provider: context.provider, role: context.role, prompt, sessionMode: 'ephemeral' });
    } });
    const state = await getFoundationDeliveryState(project.id, db), runs = await db.pipelineRun.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } });
    const result = { scope: numbers, calls, state, packets: await buildLightEpisodePackets(project.id, state.document, db), runs };
    const resultFile = `${directory}/${resumeDb ? `result-${Date.now()}` : 'result'}.json`;
    writeFileSync(resultFile, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ directory, resultFile, status: state.task?.status, complete: state.complete, calls, f1: state.document.f1, assets: state.document.f2?.assets.length,
      variants: state.document.f2?.assets.reduce((sum, asset) => sum + asset.variants.length, 0), issues: state.issues.map(issue => issue.problem), error: state.task?.error }));
    if (!state.complete) process.exitCode = 1;
  } finally { await db.$disconnect(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
