/** Request-time library facts. Cheap reads can prove incompleteness, never completion. */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from './prisma';
import { productionScopeFromSource, type ProductionScope } from './production-episodes';
import { getFoundationDeliveryState } from './foundation-delivery';

export type ProjectLibrarySummary = {
  productionScope: ProductionScope;
  complete: boolean;
  completionCheck: 'EXCLUDED' | 'FULL' | 'NOT_REQUESTED';
};
type ProjectionRow = { projectId: string; projection: string | null };
type SourceProjectionRow = ProjectionRow & { id: string; needsFallback: number };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.every(n => Number.isSafeInteger(n) && n >= 0);

/** A malformed/unknown projection needs the authoritative reader. All document
 * revisions are considered: that reader can skip a malformed latest revision.
 * Migration can only remove coverage, and legacy reconstruction has no LIGHT
 * workflow. Thus a complete state needs at least one stored LIGHT document with
 * both coverages containing every current Episode, including a real episode 0. */
function couldBeComplete(rows: ProjectionRow[], episodeNumbers: number[]): boolean {
  if (!episodeNumbers.length) return false;
  return rows.some(row => {
    if (row.projection === null) return true;
    let body: unknown;
    try { body = JSON.parse(row.projection); } catch { return true; }
    if (!record(body) || body.schema !== 'FOUNDATION_DOCUMENT_V1') return true;
    if (body.workflow !== 'LIGHT_STAGE1_V1') return false;
    if (body.f2Type === 'null') return false;
    if (body.f2Type !== 'object' || !numbers(body.coverage) || !numbers(body.editorialCoverage)) return true;
    if (body.f2Format !== 'ASSET_CATALOG_V2') return false;
    // Only the authoritative reader can validate a source-adoption proof and its current dependencies.
    if(typeof body.sourceInterpretationAdoptionCount==='number'&&body.sourceInterpretationAdoptionCount>0)return true;
    const coverage = body.coverage, edited = body.editorialCoverage;
    return episodeNumbers.every(number => coverage.includes(number) && edited.includes(number));
  });
}

export async function readProjectLibrarySummaries(userId: string, projectIds: readonly string[], db: PrismaClient = prisma,
  options: { foundationProjectIds?: readonly string[] } = {}): Promise<Map<string, ProjectLibrarySummary>> {
  const ids = [...new Set(projectIds)];
  if (!ids.length) return new Map();
  // Keep authorization inside this reader as well as the page's project listing.
  const projects = await db.project.findMany({ where: { id: { in: ids }, roles: { some: { userId } } },
    select: { id: true, episodes: { select: { number: true } } } });
  if (projects.length !== ids.length) throw new Error('无权读取项目库中的项目。');
  const foundationIds = new Set(options.foundationProjectIds ?? ids);
  const selected = Prisma.join(ids);
  const [sources, documents] = await Promise.all([
    db.$queryRaw<SourceProjectionRow[]>(Prisma.sql`
      SELECT current.id, current.projectId,
        CASE WHEN json_valid(current.content) THEN CASE WHEN json_type(current.content, '$.sourceStructure') = 'object'
          THEN json_extract(current.content, '$.sourceStructure') ELSE NULL END ELSE NULL END AS projection,
        CASE WHEN json_valid(current.content) THEN
          (SELECT COUNT(*) > 1 FROM json_each(current.content) WHERE key = 'sourceStructure') ELSE 0 END AS needsFallback
      FROM SceneSnapshot current
      WHERE current.projectId IN (${selected}) AND current.sceneKey = 'SOURCE_IMPORT'
        AND NOT EXISTS (SELECT 1 FROM SceneSnapshot newer
          WHERE newer.projectId = current.projectId AND newer.sceneKey = 'SOURCE_IMPORT'
            AND (newer.createdAt > current.createdAt OR newer.createdAt = current.createdAt AND newer.id > current.id))`),
    db.$queryRaw<ProjectionRow[]>(Prisma.sql`
      SELECT projectId,
        CASE WHEN json_valid(content) THEN CASE WHEN json_type(content) = 'object'
          AND NOT EXISTS (SELECT 1 FROM json_each(content) GROUP BY key HAVING COUNT(*) > 1)
          AND NOT EXISTS (SELECT 1 FROM json_each(content, '$.f2') GROUP BY key HAVING COUNT(*) > 1)
        THEN json_object(
          'schema', json_extract(content, '$.schema'), 'workflow', json_extract(content, '$.workflow'),
          'f2Type', json_type(content, '$.f2'), 'f2Format', json_extract(content, '$.f2.format'),
          'coverage', json_extract(content, '$.f2.coverage'), 'editorialCoverage', json_extract(content, '$.editorialCoverage'),
          'sourceInterpretationAdoptionCount',json_array_length(content,'$.sourceInterpretationAdoptions')) ELSE NULL END ELSE NULL END AS projection
      FROM SceneSnapshot WHERE projectId IN (${selected}) AND sceneKey = 'FOUNDATION_DOCUMENT'`)
  ]);
  const sourceByProject = new Map(sources.map(row => [row.projectId, row]));
  const documentsByProject = new Map<string, ProjectionRow[]>();
  for (const row of documents) { const list = documentsByProject.get(row.projectId) ?? []; list.push(row); documentsByProject.set(row.projectId, list); }
  const summaries = await Promise.all(projects.map(async project => {
    const source = sourceByProject.get(project.id);
    let productionScope = productionScopeFromSource(null);
    if (source) {
      let structure: unknown;
      try { structure = source.projection === null ? null : JSON.parse(source.projection); } catch { structure = null; }
      // SQLite extracts the first duplicate object key; JSON.parse uses the last.
      // Such legacy JSON must use the original reader semantics, not a projection.
      if (source.needsFallback) {
        const original = await db.sceneSnapshot.findUnique({ where: { id: source.id }, select: { content: true } });
        try { structure = original ? JSON.parse(original.content)?.sourceStructure : null; } catch { structure = null; }
      }
      // A present unreadable newest snapshot is a known empty scope. Never use
      // an earlier source or the absent-source positive-episode legacy fallback.
      productionScope = { ...productionScopeFromSource({ sourceStructure: structure }), sourceKnown: true };
    }
    const requested = foundationIds.has(project.id);
    const full = requested && couldBeComplete(documentsByProject.get(project.id) ?? [], project.episodes.map(episode => episode.number));
    const complete = full ? (await getFoundationDeliveryState(project.id, db)).complete : false;
    return [project.id, { productionScope, complete, completionCheck: requested ? full ? 'FULL' : 'EXCLUDED' : 'NOT_REQUESTED' } satisfies ProjectLibrarySummary] as const;
  }));
  return new Map(summaries);
}
