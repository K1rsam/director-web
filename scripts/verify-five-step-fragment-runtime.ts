import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
process.env.PYTHONUTF8 = '1';
async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'five-step-fragments-'));
  const url = `file:${directory}/test.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const { queueFoundationDelivery, executeFoundationDelivery, getFoundationDeliveryState } = await import('../lib/foundation-delivery');
  const { buildLightEpisodePackets } = await import('../lib/light-foundation-supply');
  const { loadLatestStoredFoundationDocument } = await import('../lib/foundation-document');
  try {
    const source = '第1集\n1-1 客厅 日 内\n人物：张三\n' + '张三：他转身离开。😀\r\n'.repeat(4000);
    const project = await db.project.create({ data: { title: '长单集分片测试', episodes: { create: [{ number: 1, title: '第一集', content: source }] } } });
    const seen: { stage: string; start: number; end: number; text: string }[] = [];
    const task = await queueFoundationDelivery(project.id, {}, db);
    await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
      const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
      assert(stage !== 'F1');
      const saved = await loadLatestStoredFoundationDocument(db, project.id);
      if (stage === 'F2') assert(!saved?.f2?.coverage.includes(1), 'a partial source must never claim whole-episode F2 completion');
      if (stage === 'Q1') assert(!saved?.editorialCoverage.includes(1), 'Q1 complete only after its final slice');
      const text = input.source.episodes[0].lines.map(([,text]: [number,string]) => text).join('');
      assert.equal(text, source.slice(input.fragment.start, input.fragment.end));
      seen.push({ stage, start: input.fragment.start, end: input.fragment.end, text });
      const data = stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: [1], assets: [{ ...(input.registry?.find((a: {name: string}) => a.name === '张三')?.key ? { key: input.registry.find((a: {name: string}) => a.name === '张三').key } : {}), name: '张三', type: 'CH', episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-1' }], preparation: { mode: 'REFERENCE' } }] }
        : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} };
      return { data, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null };
    } });
    const state = await getFoundationDeliveryState(project.id, db);
    assert.equal(state.task?.status, 'COMPLETE', state.task?.error ?? 'runtime');
    for (const stage of ['F2','Q1']) {
      const parts = seen.filter(p => p.stage === stage); assert(parts.length > 1);
      assert.equal(parts.map(p => p.text).join(''), source);
    }
    const [packet] = await buildLightEpisodePackets(project.id, state.document, db, [1]);
    assert.equal(packet.sourceText, source); assert.equal(packet.materialStatus, 'TEXT_ONLY');
    assert.equal(packet.assets.length, 1); assert.deepEqual(state.document.editorialCoverage, [1]);
    console.log('PASS long-episode real controller with mock provider: persisted slice progress, no early coverage, complete original source, one stable asset, shared handoff');
  } finally {
    await db.$disconnect();
    const resolved = path.resolve(directory); if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('temporary cleanup boundary');
    rmSync(resolved, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
