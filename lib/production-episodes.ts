import {requireSeasonProduction} from './season-scope-service';
import { prisma } from "./prisma";
import type { PrismaClient } from "@prisma/client";

export type ProductionScope = { sourceKnown: boolean; episodeNumbers: number[] };
export function productionScopeFromSource(source: unknown): ProductionScope {
  const sections = (source as { sourceStructure?: { sections?: unknown[] } } | null)?.sourceStructure?.sections;
  if (!Array.isArray(sections)) return { sourceKnown: false, episodeNumbers: [] };
  return { sourceKnown: true, episodeNumbers: [...new Set(sections.flatMap(value => {
    const section = value as { kind?: string; episodeNumber?: number } | null;
    return section?.kind === "EPISODE" && Number.isSafeInteger(section.episodeNumber) && section.episodeNumber! >= 0 ? [section.episodeNumber!] : [];
  }))] };
}
export function isProductionEpisodeNumber(number: number, scope: ProductionScope): boolean {
  return Number.isSafeInteger(number) && number >= 0 && (scope.sourceKnown ? scope.episodeNumbers.includes(number) : number >= 1);
}
export async function readProductionScope(projectId: string, db: Pick<PrismaClient, "sceneSnapshot"> = prisma): Promise<ProductionScope> {
  try{const s=await requireSeasonProduction(projectId,undefined,'production',db as any);if(s)return {sourceKnown:true,episodeNumbers:s.scope.episodeNumbers};}catch{return {sourceKnown:true,episodeNumbers:[]};}
  const source = await db.sceneSnapshot.findFirst({ where: { projectId, sceneKey: "SOURCE_IMPORT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { content: true } });
  if (!source) return productionScopeFromSource(null);
  // Legacy fallback is only for an absent snapshot, never for an unreadable current source.
  try { return { ...productionScopeFromSource(JSON.parse(source.content)), sourceKnown: true }; }
  catch { return { sourceKnown: true, episodeNumbers: [] }; }
}
