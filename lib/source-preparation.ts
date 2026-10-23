import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {readSourceReadingState,projectSourceReadingIssues} from './source-reading-confirmation';
import type { SourceStructure } from "@/lib/import-script";
import { parseSourceText, type SourceBoundaryPlan } from "@/lib/source-parser";

type Db = Pick<PrismaClient, "project" | "sceneSnapshot">;
type Tx = Prisma.TransactionClient;
type ImportBody = { sourceText: string; sourceStructure: SourceStructure; readIssues: Array<{ code: string; message: string }> };
const BOUNDARY_CODES = new Set(["DUPLICATE_EPISODE_NUMBER", "NO_RECOGNIZED_EPISODE", "UNNUMBERED_SCENE_EPISODE_CANDIDATE"]);

export type SourceAssistRequest = {
  sourceVersion: string;
  issues: SourceStructure["issues"];
  sections: Array<{ key: string; start: number; end: number; text: string; before?: string; after?: string }>;
  sourceLength: number;
};
export type SourcePreparation = {
  project: Awaited<ReturnType<PrismaClient["project"]["findUniqueOrThrow"]>> & { episodes: Array<{ id: string; number: number; title: string | null; content: string }> };
  sourceInputVersion: string;
  sourceImportId: string | null;
  sourceText: string | null;
  readIssues: ImportBody['readIssues'];
};

/** Read-only queue pin: original import plus the current ordered episode reading view. */
export async function readSourcePreparation(projectId: string, db: Db = prisma): Promise<SourcePreparation> {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { episodes: { orderBy: { number: "asc" } } } });
  if (!project) throw new Error("Project not found.");
  const imported = await db.sceneSnapshot.findFirst({ where: { projectId, sceneKey: "SOURCE_IMPORT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const body = imported && importBody(imported.content, imported.metadata) ? importBody(imported.content, imported.metadata)! : null;
  const readingState=await readSourceReadingState(projectId,db,imported??undefined);
  return {
    project,
    sourceImportId: body ? imported!.id : null,
    sourceText: body?.sourceText ?? null,
    readIssues: projectSourceReadingIssues(body?.readIssues??[],readingState),
    sourceInputVersion: hash({ project: { title: project.title, style: project.style, aspectRatio: project.aspectRatio, executionMode: project.executionMode, ruleVersion: project.ruleVersion, archivedAt: project.archivedAt?.toISOString() ?? null }, sourceImport: imported ? { id: imported.id, content: imported.content, metadata: imported.metadata } : null, episodes: project.episodes.map((episode) => ({ number: episode.number, title: episode.title, content: episode.content })) })
  };
}

export async function prepareFoundationSource(
  projectId: string,
  db: PrismaClient = prisma,
  options: { checkCurrent?: (tx: Tx) => Promise<void>; assist?: (request: SourceAssistRequest, validate: (value: unknown) => SourceBoundaryPlan) => Promise<{ plan: SourceBoundaryPlan; runId: string }> } = {}
): Promise<{ sourceInputVersion: string; assisted: boolean; episodeCount: number; unresolved: string[] }> {
  const input = await readSourcePreparation(projectId, db);
  if (!input.sourceText || !input.sourceImportId) return { sourceInputVersion: input.sourceInputVersion, assisted: false, episodeCount: input.project.episodes.length, unresolved: [] };
  const original = await currentImportBody(projectId, db);
  if (!original || original.sourceText !== input.sourceText) throw new Error("导入来源已变化，未开始来源整理。");
  let parsed = parseSourceText(input.sourceText, original.readIssues);
  const sourceTextHash = hash(input.sourceText);
  const previous = await currentResolution(projectId, db, input.sourceImportId, sourceTextHash, input.sourceText.length);
  let reused = false;
  if (previous) {
    if (previous.plan) parsed = parseSourceText(input.sourceText, original.readIssues, previous.plan);
    reused = true;
  }
  const boundaryIssues = parsed.sourceStructure.issues.filter((issue) => BOUNDARY_CODES.has(issue.code));
  let plan: SourceBoundaryPlan | undefined; let runId: string | undefined; let assisted = false;
  const candidates = assistSections(input.sourceText, parsed.sourceStructure);
  const sections = withinAssistBudget(candidates);
  if (!reused && boundaryIssues.length && options.assist && sections.length) {
    const result = await options.assist({ sourceVersion: input.sourceInputVersion, issues: boundaryIssues, sections, sourceLength: input.sourceText.length }, value => validateSourceBoundaryPlan(value, input.sourceText!, original.readIssues));
    // Fixed Python is the executor and validator; the callback has no write capability.
    parsed = parseSourceText(input.sourceText, original.readIssues, result.plan);
    plan = result.plan; runId = result.runId; assisted = true;
  }
  const unresolved = [...new Set([...parsed.sourceStructure.sections.filter((section) => section.kind === "UNRESOLVED").map((section) => section.key), ...parsed.sourceStructure.issues.filter(issue => BOUNDARY_CODES.has(issue.code)).flatMap((issue) => issue.sectionKeys.length ? issue.sectionKeys : [issue.code])])];
  if (boundaryIssues.length && !sections.length) unresolved.push("SOURCE_TOO_LARGE_REQUIRES_RANGE_DECISION");
  const resolution = { sourceImportId: input.sourceImportId, sourceTextHash, structure: parsed.sourceStructure, ...(plan ? { plan } : {}), ...(runId ? { runId } : {}) };
  const savedVersion = await db.$transaction(async (tx) => {
    if (options.checkCurrent) await options.checkCurrent(tx);
    const current = await readSourcePreparation(projectId, tx);
    if (current.sourceInputVersion !== input.sourceInputVersion) throw new Error("来源或分集已变化，未保存过期的来源整理结果。");
    const sourceBody = await currentImportBody(projectId, tx);
    if (!sourceBody || current.sourceImportId !== input.sourceImportId || sourceBody.sourceText !== input.sourceText) throw new Error("导入来源已变化，未保存过期的来源整理结果。");
    if (!reused) await tx.sceneSnapshot.create({ data: { projectId, sceneKey: "SOURCE_STRUCTURE_RESOLUTION", title: "来源边界整理结果", content: JSON.stringify(resolution), metadata: JSON.stringify({ schema: "SOURCE_STRUCTURE_RESOLUTION_V1", sourceImportId: input.sourceImportId, sourceTextHash: resolution.sourceTextHash, sourceInputVersion: input.sourceInputVersion, runId: runId ?? null }) } });
    await materializeEpisodes(projectId, tx, sourceBody, parsed.episodes);
    return (await readSourcePreparation(projectId, tx)).sourceInputVersion;
  });
  return { sourceInputVersion: savedVersion, assisted, episodeCount: parsed.episodes.length, unresolved };
}

/** The same pure receiver is used before paid acceptance and during read-only response recovery. */
export function validateSourceBoundaryPlan(value: unknown, sourceText: string, readIssues: ImportBody['readIssues'] = []): SourceBoundaryPlan {
  if (!isPlan(value)) throw new Error("F1 仅可返回边界计划对象。");
  parseSourceText(sourceText, readIssues, value);
  return value;
}

async function materializeEpisodes(projectId: string, tx: Tx, source: ImportBody, episodes: Array<{ number: number; title: string; content: string }>) {
  const existing = await tx.episode.findMany({ where: { projectId }, orderBy: { number: "asc" } });
  const oldByNumber = source.sourceStructure.sections.filter((section) => section.kind === "EPISODE" && typeof section.episodeNumber === "number")
    .reduce<Map<number, string>>((map, section) => map.set(section.episodeNumber!, source.sourceText.slice(section.start, section.end)), new Map());
  const next = new Map(episodes.map((episode) => [episode.number, episode]));
  for (const episode of episodes) {
    const current = existing.find((item) => item.number === episode.number);
    if (!current) await tx.episode.create({ data: { projectId, number: episode.number, title: episode.title, content: episode.content } });
    else if (current.content === oldByNumber.get(episode.number) && (current.content !== episode.content || current.title !== episode.title)) await tx.episode.update({ where: { id: current.id }, data: { title: episode.title, content: episode.content } });
  }
  for (const current of existing.filter((item) => !next.has(item.number) && item.content === oldByNumber.get(item.number))) {
    const blocked = await hasDownstreamMaterial(current.id, tx);
    if (blocked) continue; // Keep source-derived text visible rather than deleting a bound episode.
    await tx.sceneSnapshot.create({ data: { projectId, episodeId: current.id, sceneKey: `RETIRED_SOURCE_EP-${current.number}`, title: `第${current.number}集原始阅读快照`, content: current.content, metadata: JSON.stringify({ schema: "RETIRED_SOURCE_EPISODE_V1", source: "SOURCE_IMPORT" }) } });
    await tx.episode.delete({ where: { id: current.id } });
  }
}

async function hasDownstreamMaterial(episodeId: string, tx: Tx) {
  const counts = await Promise.all([tx.storyboardShot.count({ where: { episodeId } }), tx.seedanceUnit.count({ where: { episodeId } }), tx.pipelineRun.count({ where: { episodeId } }), tx.taskPackage.count({ where: { episodeId } }), tx.reviewRound.count({ where: { episodeId } }), tx.finalScript.count({ where: { episodeId } }), tx.workflowIssue.count({ where: { episodeId } }), tx.sceneSnapshot.count({ where: { episodeId } }), tx.presentationContract.count({ where: { episodeId } })]);
  return counts.some(Boolean);
}

async function currentImportBody(projectId: string, db: Pick<PrismaClient, "sceneSnapshot">) {
  const snapshot = await db.sceneSnapshot.findFirst({ where: { projectId, sceneKey: "SOURCE_IMPORT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const body=snapshot?importBody(snapshot.content,snapshot.metadata):null;
  return body&&snapshot?{...body,readIssues:projectSourceReadingIssues(body.readIssues,await readSourceReadingState(projectId,db,snapshot))}:null;
}

async function currentResolution(projectId: string, db: Pick<PrismaClient, "sceneSnapshot">, sourceImportId: string, sourceTextHash: string, sourceLength: number): Promise<{ structure: SourceStructure; plan?: SourceBoundaryPlan } | null> {
  const snapshots = await db.sceneSnapshot.findMany({ where: { projectId, sceneKey: "SOURCE_STRUCTURE_RESOLUTION" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  for (const snapshot of snapshots) {
    const body = record(snapshot.content);
    if (body.sourceImportId === sourceImportId && body.sourceTextHash === sourceTextHash && isStructure(body.structure) && structureCovers(body.structure, sourceLength)) return { structure: body.structure, ...(isPlan(body.plan) ? { plan: body.plan } : {}) };
  }
  return null;
}

function assistSections(text: string, structure: SourceStructure) {
  return structure.sections.filter((section) => section.kind === "UNRESOLVED" || (structure.issues.some((issue) => issue.code === "NO_RECOGNIZED_EPISODE") && section.kind === "BACKGROUND"))
    .map((section) => ({ key: section.key, start: section.start, end: section.end, text: text.slice(section.start, section.end), before: text.slice(Math.max(0, section.start - 160), section.start), after: text.slice(section.end, Math.min(text.length, section.end + 160)) }));
}
function withinAssistBudget(candidates: SourceAssistRequest["sections"]) {
  const result: SourceAssistRequest["sections"] = []; let size = 0;
  for (const section of candidates) { const next = section.text.length + (section.before?.length ?? 0) + (section.after?.length ?? 0); if (next > 12_000 || size + next > 12_000) continue; result.push(section); size += next; }
  return result;
}

function importBody(content: string, metadata: string | null): ImportBody | null {
  const meta = record(metadata); const body = record(content);
  if (meta.schema !== "IMPORTED_SOURCE_TEXT_V2" || typeof body.sourceText !== "string" || !isStructure(body.sourceStructure)) return null;
  return { sourceText: body.sourceText, sourceStructure: body.sourceStructure, readIssues: body.sourceStructure.issues.filter((issue) => !BOUNDARY_CODES.has(issue.code)).map((issue) => ({ code: issue.code, message: issue.message })) };
}
function isStructure(value: unknown): value is SourceStructure { const body = record(value); return body.version === "SOURCE_STRUCTURE_V1" && Array.isArray(body.sections) && Array.isArray(body.issues); }
function structureCovers(structure: SourceStructure, sourceLength: number) { return structure.sections.length > 0 && structure.sections.every((section, index) => section.start === (index ? structure.sections[index - 1]!.end : 0) && section.end >= section.start) && structure.sections.at(-1)!.end === sourceLength; }
function isPlan(value: unknown): value is SourceBoundaryPlan { const item = record(value); return Boolean(item) && (!item.assignments || Array.isArray(item.assignments)) && (!item.boundaries || Array.isArray(item.boundaries)); }
function record(value: unknown): Record<string, unknown> { try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function hash(value: unknown) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex"); }
