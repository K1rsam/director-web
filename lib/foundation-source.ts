import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SourceStructure } from "@/lib/import-script";
import { duplicateSourceHeadingKeys } from './source-structural-headings';

type Db = Pick<PrismaClient, "sceneSnapshot">;
type SourceTextSection = { key: string; text: string };
type SourceNotice = { code: string; message: string };

export type FoundationSourceContext = {
  version: string;
  background: SourceTextSection[];
  unresolved: SourceTextSection[];
  issues: SourceStructure["issues"];
  complete: boolean;
  /** Non-blocking provenance or reader information; never substitute for source gaps. */
  notices: SourceNotice[];
  /** Whether the newest import record supplied a verifiable V2 source structure. */
  coverage: "COMPLETE" | "UNKNOWN";
};

/**
 * Supplements current numbered Episodes with source-only background and ambiguity.
 * It intentionally reads only V2 SOURCE_IMPORT snapshots and never reinterprets
 * legacy uploads into episodes.
 */
export async function loadFoundationSourceContext(projectId: string, db: Db = prisma): Promise<FoundationSourceContext> {
  const current = await db.sceneSnapshot.findFirst({
    where: { projectId, sceneKey: "SOURCE_IMPORT" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  if (!current) {
    const notices = [{ code: "NO_SOURCE_IMPORT_METADATA", message: "没有 SOURCE_IMPORT；不从既有 Episode 反推补充来源。" }];
    return { version: fingerprint({ projectId, marker: notices[0]!.code }), background: [], unresolved: [], issues: [], complete: false, notices, coverage: "UNKNOWN" };
  }

  const metadata = jsonRecord(current.metadata);
  if (metadata.schema !== "IMPORTED_SOURCE_TEXT_V2") {
    const code = metadata.schema === "IMPORTED_SOURCE_TEXT_V1" ? "LEGACY_SOURCE_IMPORT_BOUNDARY" : "CURRENT_SOURCE_IMPORT_METADATA_UNREADABLE";
    const notices = [{ code, message: code === "LEGACY_SOURCE_IMPORT_BOUNDARY" ? "最新导入是旧版记录；仅保留历史边界，不能重释背景、未决区或既有分集。" : "最新 SOURCE_IMPORT 元数据不支持或损坏；未回退采用更早版本。" }];
    return { version: fingerprint({ snapshotId: current.id, content: current.content, metadata: current.metadata }), background: [], unresolved: [], issues: [], complete: false, notices, coverage: "UNKNOWN" };
  }

  const body = jsonRecord(current.content);
  const sourceText = typeof body.sourceText === "string" ? body.sourceText : null;
  let structure = isSourceStructure(body.sourceStructure) ? body.sourceStructure : null;
  const readingView = isRecord(body.readingView) ? body.readingView : {};
  if (sourceText === null || structure === null || !structureCovers(sourceText, structure)) {
    const issues: SourceStructure["issues"] = [{ code: "INVALID_SOURCE_IMPORT_STRUCTURE", message: "新版 SOURCE_IMPORT 的文本或分区范围不完整；未自动推断或修复。", sectionKeys: [] }];
    return { version: fingerprint({ snapshotId: current.id, content: current.content, metadata: current.metadata }), background: [], unresolved: [], issues, complete: false, notices: [], coverage: "UNKNOWN" };
  }

  // A resolution is an additional immutable snapshot.  It can only reinterpret the
  // newest V2 import it names; it never replaces the imported source text itself.
  const resolution = await db.sceneSnapshot.findFirst({ where: { projectId, sceneKey: "SOURCE_STRUCTURE_RESOLUTION" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const resolved = resolution ? jsonRecord(resolution.content) : {};
  if (resolved.sourceImportId === current.id && resolved.sourceTextHash === sourceTextHash(sourceText) && isSourceStructure(resolved.structure) && structureCovers(sourceText, resolved.structure)) {
    const readIssues = structure.issues.filter(issue => !['DUPLICATE_EPISODE_NUMBER', 'NO_RECOGNIZED_EPISODE', 'UNNUMBERED_SCENE_EPISODE_CANDIDATE'].includes(issue.code));
    structure = { ...resolved.structure, issues: [...new Map([...readIssues, ...resolved.structure.issues].map(issue => [JSON.stringify(issue), issue])).values()] };
  }

  const background = structure.sections.filter((section) => section.kind === "BACKGROUND").map((section) => ({ key: section.key, text: sourceText.slice(section.start, section.end) }));
  const structuralHeadings=duplicateSourceHeadingKeys(sourceText,structure);
  const unresolved = structure.sections.filter((section) => section.kind === "UNRESOLVED"&&!structuralHeadings.has(section.key)).map((section) => ({ key: section.key, text: sourceText.slice(section.start, section.end) }));
  const issues = structure.issues;
  const noticeCode = readingView.kind === "DOCX" ? "DOCX_READER_WARNING" : "SOURCE_READING_WARNING";
  const notices = readingView.warnings && Array.isArray(readingView.warnings)
    ? readingView.warnings.filter((warning): warning is string => typeof warning === "string").map((message) => ({ code: noticeCode, message }))
    : [];
  if(structuralHeadings.size)notices.push({code:'REPEATED_EPISODE_HEADING',message:`${structuralHeadings.size}处重复集标题已核对与紧邻正文集号一致，作为格式标记保留在原文中，无需人工确认。`});
  return {
    version: fingerprint({ snapshotId: current.id, sourceText, sections: structure.sections, issues, readingView }),
    background,
    unresolved,
    issues,
    complete: unresolved.length === 0 && issues.length === 0,
    notices,
    coverage: "COMPLETE"
  };
}

function jsonRecord(value: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSourceStructure(value: unknown): value is SourceStructure {
  if (!isRecord(value) || value.version !== "SOURCE_STRUCTURE_V1" || !Array.isArray(value.sections) || !Array.isArray(value.issues)) return false;
  return value.sections.every((section) => isRecord(section) && typeof section.key === "string" && ["BACKGROUND", "EPISODE", "UNRESOLVED"].includes(String(section.kind)) && Number.isInteger(section.start) && Number.isInteger(section.end))
    && value.issues.every((issue) => isRecord(issue) && typeof issue.code === "string" && typeof issue.message === "string" && Array.isArray(issue.sectionKeys) && issue.sectionKeys.every((key) => typeof key === "string"));
}

function structureCovers(sourceText: string, structure: SourceStructure) {
  let end = 0;
  for (const section of structure.sections) {
    if (section.start !== end || section.end < section.start || section.end > sourceText.length) return false;
    end = section.end;
  }
  return end === sourceText.length;
}

function fingerprint(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sourceTextHash(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
