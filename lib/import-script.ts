import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { parseSourceText } from "@/lib/source-parser";

export type ImportedEpisode = { number: number; title: string; content: string };
export type SourceSection = { key: string; kind: "BACKGROUND" | "EPISODE" | "UNRESOLVED"; start: number; end: number; episodeNumber?: number; boundaryBasis?: "EXPLICIT_HEADING" | "SUPPLEMENT_HEADING" | "SCENE_NUMBER" };
export type SourceStructure = { version: "SOURCE_STRUCTURE_V1"; sections: SourceSection[]; issues: { code: string; message: string; sectionKeys: string[] }[] };
export type SourceReadingView = { kind: "TEXT" | "DOCX"; encoding?: "utf-8" | "gb18030"; view: string; warnings: string[] };
export type OriginalFileSnapshot = { encoding: "base64"; mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/plain" | "text/markdown"; base64: string };
export type ImportedScript = {
  sourceName: string;
  /** Text read from the supplied source. The original upload is kept separately for recovery only. */
  sourceText: string;
  episodes: ImportedEpisode[];
  sourceStructure: SourceStructure;
  readingView: SourceReadingView;
  originalFile?: OriginalFileSnapshot;
};

type SourceReadIssue = { code: string; message: string };

export async function parseScriptFile(filePath: string): Promise<ImportedScript> {
  return parseScriptBuffer(path.basename(filePath), await readFile(filePath));
}

export async function parseScriptBuffer(sourceName: string, buffer: Buffer, options: { docxParagraphSeparator?: "\n" | "\n\n" } = {}): Promise<ImportedScript> {
  const ext = path.extname(sourceName).toLowerCase();
  if (ext === ".docx") {
    const read = await readDocxText(buffer, options.docxParagraphSeparator ?? "\n\n");
    return parseScriptContent(sourceName, read.text, {
      readingView: read.readingView,
      originalFile: { encoding: "base64", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base64: buffer.toString("base64") },
      readIssues: read.issues
    });
  }
  if (ext === ".txt" || ext === ".md") {
    const decoded = decodeTextBuffer(buffer);
    return parseScriptContent(sourceName, decoded.text, {
      readingView: decoded.readingView,
      originalFile: { encoding: "base64", mediaType: ext === ".md" ? "text/markdown" : "text/plain", base64: buffer.toString("base64") }
    });
  }
  throw new Error(`Unsupported script file type: ${ext || "unknown"}`);
}

export function parseScriptContent(sourceName: string, text: string, options: { readingView?: SourceReadingView; originalFile?: OriginalFileSnapshot; readIssues?: SourceReadIssue[] } = {}): ImportedScript {
  const { episodes, sourceStructure, boundaryNotes } = parseSourceText(text, options.readIssues ?? []);
  const readingView = options.readingView ?? { kind: "TEXT" as const, view: "IN_MEMORY_TEXT", warnings: [] };
  return { sourceName, sourceText: text, episodes, sourceStructure, readingView: { ...readingView, warnings: [...readingView.warnings, ...boundaryNotes] }, originalFile: options.originalFile };
}

export async function readScriptText(filePath: string, ext = path.extname(filePath).toLowerCase()) {
  if (ext !== ".txt" && ext !== ".md" && ext !== ".docx") throw new Error(`Unsupported script file type: ${ext || "unknown"}`);
  return (await parseScriptFile(filePath)).sourceText;
}

/** Compatibility export for callers that only require materialized numbered episodes. */
export function splitEpisodes(text: string): ImportedEpisode[] {
  return parseSourceText(text).episodes;
}

function decodeTextBuffer(buffer: Buffer) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer), readingView: { kind: "TEXT" as const, encoding: "utf-8" as const, view: "BYTE_DECODED_UTF8", warnings: [] } };
  } catch (utf8Error) {
    try {
      return { text: new TextDecoder("gb18030", { fatal: true }).decode(buffer), readingView: { kind: "TEXT" as const, encoding: "gb18030" as const, view: "BYTE_DECODED_GB18030_AFTER_UTF8_FAILURE", warnings: ["UTF-8 严格解码失败后按 GB18030 读取。"] } };
    } catch {
      throw new Error(`无法以 UTF-8 或 GB18030 读取文本：${utf8Error instanceof Error ? utf8Error.message : "未知解码错误"}`);
    }
  }
}

async function readDocxText(buffer: Buffer, paragraphSeparator: "\n" | "\n\n") {
  let tree: unknown;
  const result = await mammoth.convertToHtml({ buffer }, { transformDocument(document) { tree = document; return document; } });
  if (!tree) throw new Error("DOCX 未产生可读取的文档树。");
  // Mammoth style diagnostics are informational when the linear text is intact.
  // Only reader errors become source-structure issues; warnings stay on the read view.
  const issues: SourceReadIssue[] = result.messages.filter((message) => message.type === "error").map((message) => ({ code: "DOCX_READER_ERROR", message: message.message }));
  const warnings = result.messages.filter(message => !message.message.startsWith("Unrecognised paragraph style:")).map((message) => message.message);
  try {
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file("word/document.xml")?.async("string");
    if (!documentXml) issues.push({ code: "DOCX_UNSUPPORTED_OBJECT", message: "未找到 word/document.xml；读取视图不完整。" });
    else {
      if (/<w:tbl\b/.test(documentXml)) warnings.push("DOCX 含表格；当前读取视图按单元格段落线性排列，不保留表格行列关系，请核对说话者与内容归属。");
      if (/<w:(?:ins|del|moveFrom|moveTo)\b/.test(documentXml)) {
        const message = "DOCX 含修订标记；当前仅保存转换器读取视图和原文件，未自动接受或拒绝修订。";
        issues.push({ code: "DOCX_REVISION_VIEW_UNRESOLVED", message }); warnings.push(message);
      }
      if (/<w:(?:altChunk|object|txbxContent|drawing|pict)\b/.test(documentXml)) {
        const message = "DOCX 含可能无法完整映射到线性文本的对象；原文件已保留，需人工核对读取视图。";
        issues.push({ code: "DOCX_UNSUPPORTED_OBJECT", message }); warnings.push(message);
      }
    }
  } catch (error) {
    const message = `无法检查 DOCX 原始结构：${error instanceof Error ? error.message : String(error)}`;
    issues.push({ code: "DOCX_STRUCTURE_INSPECTION_FAILED", message }); warnings.push(message);
  }
  if (paragraphSeparator === "\n") warnings.push("已按每个Word段落一个换行读取并逐字比对外部包；未删除正文空格或段内换行。");
  return { text: renderMammothNode(tree, paragraphSeparator), issues, readingView: { kind: "DOCX" as const, view: issues.some((issue) => issue.code === "DOCX_REVISION_VIEW_UNRESOLVED") ? "MAMMOTH_VIEW_REVISIONS_UNRESOLVED" : paragraphSeparator === "\n" ? "MAMMOTH_PARAGRAPH_LF_V1" : "MAMMOTH_VIEW", warnings } };
}

function renderMammothNode(value: unknown, paragraphSeparator: string): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { type?: string; value?: unknown; breakType?: string; children?: unknown[] };
  if (node.type === "text") return typeof node.value === "string" ? node.value : "";
  if (node.type === "tab") return "\t";
  if (node.type === "break") return "\n";
  const children = Array.isArray(node.children) ? node.children.map(child => renderMammothNode(child, paragraphSeparator)).join("") : "";
  return node.type === "paragraph" ? `${children}${paragraphSeparator}` : children;
}

export function parseEpisodeNumber(value: string): number | null {
  const compact = value.trim();
  const repeated = compact.match(/^([零〇一二两三四五六七八九十百]+)(\d+)$/);
  if (repeated) { const chinese = parseChineseNumber(repeated[1]); return chinese === Number(repeated[2]) ? chinese : null; }
  return /^\d+$/.test(compact) ? Number(compact) : parseChineseNumber(compact);
}

function parseChineseNumber(value: string): number | null {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if ([...value].every((char) => char in digits)) return Number([...value].map((char) => digits[char]).join(""));
  const hundredIndex = value.indexOf("百");
  if (hundredIndex >= 0) {
    const hundreds = value.slice(0, hundredIndex) ? digits[value.slice(0, hundredIndex)] : 1;
    const rest = value.slice(hundredIndex + 1) ? parseChineseNumber(value.slice(hundredIndex + 1)) : 0;
    return hundreds === undefined || rest === null ? null : hundreds * 100 + rest;
  }
  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const tens = value.slice(0, tenIndex) ? digits[value.slice(0, tenIndex)] : 1;
    const ones = value.slice(tenIndex + 1) ? digits[value.slice(tenIndex + 1)] : 0;
    return tens === undefined || ones === undefined ? null : tens * 10 + ones;
  }
  return null;
}

const EPISODE_NORMALIZATION_NOTE = /（原集号(?:为第[^）]*?集，不是有效集号|与前文重复)，已自动整理为第\d+集）/g;
const GENERIC_EPISODE_TITLE = /^第\s*(?:\d+|[零〇一二两三四五六七八九十百]+)\s*集(?:\s*(?:页眉|标题|正文))?$/;

/** 仅清理界面标题中的系统规范化说明，保留数据库里的原始导入信息。 */
export function cleanEpisodeTitle(title: string | null | undefined, fallbackNumber?: number) {
  const cleaned = (title ?? "").replace(EPISODE_NORMALIZATION_NOTE, "").replace(/\s{2,}/g, " ").trim();
  // 标题只展示数据库中保留的正式集号；第0集可以作为前置资料正常显示。
  if (fallbackNumber !== undefined && GENERIC_EPISODE_TITLE.test(cleaned)) return `第${fallbackNumber}集`;
  return cleaned || (fallbackNumber !== undefined ? `第${fallbackNumber}集` : "未命名集");
}
