import { createHash } from 'node:crypto';
import type { PipelineRun, Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;
const FIELD = '_deliveryEvidenceVersion';
const digest = (log: string | null) => createHash('sha256').update(log ?? '\0').digest('hex');
const json = (value: string | null): Record<string, unknown> => { try { const parsed = JSON.parse(value ?? '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } };
// Database identity is part of cache ownership: tests and independent checkouts can reuse ids.
const caches = new WeakMap<object, Map<string, { version: string; log: string | null }>>();
function cacheFor(db: Db) { let cache = caches.get(db); if (!cache) { cache = new Map(); caches.set(db, cache); } return cache; }
function remember(db: Db, id: string, version: string, log: string | null) {
  const cache = cacheFor(db); cache.delete(id);
  while (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(id, {version,log});
}

/** Every delivery log writer must use this: evidence and its content version commit atomically. */
export async function persistIndexedFoundationRunLog(db: Db, runId: string, data: { log: string; model?: string | null }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await db.pipelineRun.findUniqueOrThrow({where:{id:runId},select:{inputSummary:true}});
    const version = digest(data.log), inputSummary = JSON.stringify({...json(row.inputSummary),[FIELD]:version});
    const result = await db.pipelineRun.updateMany({where:{id:runId,inputSummary:row.inputSummary},data:{...data,inputSummary}});
    if (result.count === 1) { remember(db,runId,version,data.log); return; }
  }
  throw new Error('调用证据版本并发变化，未覆盖新证据。');
}

/** Listing reads short fields. Historical rows without a tracked version remain conservative reads. */
export async function loadIndexedFoundationRuns(db: Db, projectId: string, options: { fresh?: boolean } = {}): Promise<PipelineRun[]> {
  const rows = await db.pipelineRun.findMany({where:{projectId,episodeId:null,stageCode:{in:['F1','F2','Q1']}},orderBy:[{createdAt:'asc'},{id:'asc'}],
    select:{id:true,projectId:true,episodeId:true,stageCode:true,roleName:true,provider:true,model:true,status:true,inputSummary:true,outputSummary:true,error:true,startedAt:true,finishedAt:true,durationMs:true,createdAt:true}});
  const result: PipelineRun[] = [];
  for (const row of rows) {
    const version = json(row.inputSummary)[FIELD], cached = cacheFor(db).get(row.id);
    // Failed/active/UNKNOWN runs are always fresh, including display reads. Only completed successes
    // use the short-field cache; paid continuation never uses this branch regardless of status.
    if (options.fresh === false && row.status === 'SUCCEEDED' && typeof version === 'string' && cached?.version === version
      && !/"(?:UNKNOWN|RUNNING)"/.test(cached.log ?? '')) { result.push({...row,log:cached.log}); continue; }
    // Read current short metadata together with log; never combine a new attempt with an old listing.
    const current = await db.pipelineRun.findFirst({where:{id:row.id,projectId}});
    if (!current) continue;
    const currentVersion = json(current.inputSummary)[FIELD];
    if (typeof currentVersion === 'string' && currentVersion === digest(current.log)) remember(db,row.id,currentVersion,current.log);
    result.push(current);
  }
  return result;
}
