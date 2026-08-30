"use client";

import { useState } from "react";

export type AssetIndexRow = {
  id: string;
  code: string;
  type: string;
  name: string;
  status: string;
  parentId?: string | null;
  role?: string | null;
  episodeNumber?: number | null;
  sourceText?: string | null;
  notes?: string | null;
};

const ASSET_INDEX_TABS: Array<{ key: string; label: string; types: string[] }> = [
  { key: "people", label: "人物", types: ["CH", "LOOK"] },
  { key: "groups", label: "群像", types: ["GROUP"] },
  { key: "beasts", label: "非人", types: ["BEAST"] },
  { key: "scenes", label: "场景", types: ["LOC"] },
  { key: "props", label: "道具", types: ["PROP"] },
  { key: "other", label: "其他", types: ["STYLE", "NEG"] }
];

const TYPE_TAG: Record<string, string> = {
  CH: "人物",
  LOOK: "人物状态",
  GROUP: "群像",
  BEAST: "非人",
  LOC: "场景",
  PROP: "道具",
  STYLE: "风格",
  NEG: "负面约束"
};

const TYPE_TAG_CLASS: Record<string, string> = {
  CH: "typePeople",
  LOOK: "typePeople",
  GROUP: "typeGroup",
  BEAST: "typeBeast",
  LOC: "typeScene",
  PROP: "typeProp",
  STYLE: "typeOther",
  NEG: "typeOther"
};

const ROLE_TAG_CLASS: Record<string, string> = {
  主角: "roleLead",
  配角: "roleSupport",
  反派: "roleVillain",
  路人: "roleExtra"
};

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XML_HEADER = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";

type AssetExportSheet = {
  name: string;
  rows: readonly (readonly string[])[];
  columnWidths: readonly number[];
  freezeRows?: number;
  headerRow?: number;
  titleRows?: number;
  autoFilter?: boolean;
};

const ASSET_EXPORT_HEADERS = [
  "资产ID",
  "标准名称",
  "状态 / 着装 / 形态",
  "确认状态",
  "资产类型",
  "角色",
  "所属集",
  "父资产ID",
  "父资产名称",
  "来源文本",
  "备注"
];

const ASSET_EXPORT_SHEETS = [
  { name: "人物", types: ["CH", "LOOK"], summary: "人物（含人物状态）", note: "人物名称、状态/着装/形态分列" },
  { name: "场景", types: ["LOC"], summary: "场景", note: "拍摄地点、空间和场景状态" },
  { name: "道具", types: ["PROP"], summary: "道具", note: "关键道具及其使用状态" },
  { name: "群像", types: ["GROUP"], summary: "群像", note: "群体角色或群体资产" },
  { name: "非人", types: ["BEAST"], summary: "非人", note: "非人角色、异象或形态资产" },
  { name: "其他", types: ["STYLE", "NEG"], summary: "其他", note: "风格和负面约束等辅助资产" }
] as const;

const ASSET_EXPORT_WIDTHS = [16, 22, 28, 14, 14, 14, 12, 16, 28, 58, 40];

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function splitAssetName(value: string): { standardName: string; descriptor: string } {
  const name = String(value || "").trim();
  const separatorIndex = name.indexOf("｜");
  if (separatorIndex < 0) return { standardName: name || "—", descriptor: "—" };
  return {
    standardName: name.slice(0, separatorIndex).trim() || name,
    descriptor: name.slice(separatorIndex + 1).trim() || "—"
  };
}

function assetEpisodeLabel(episodeNumber?: number | null): string {
  if (episodeNumber == null) return "全剧";
  return episodeNumber < 1 ? "前置资料" : "第" + episodeNumber + "集";
}

function displayAssetName(asset?: AssetIndexRow | null): string {
  if (!asset) return "—";
  const parts = splitAssetName(asset.name);
  return parts.descriptor === "—" ? parts.standardName : parts.standardName + "｜" + parts.descriptor;
}

function compareAssetCode(left: AssetIndexRow, right: AssetIndexRow): number {
  return left.code.localeCompare(right.code, "zh-Hans-CN", { numeric: true }) || left.id.localeCompare(right.id);
}

/**
 * 资产表按“主资产 → 分资产”展开，保留稳定 ID，不因展示排序重编号。
 * 因此 CH-002-4-2/3 会紧跟 CH-002-4，而不是跑到表格末尾。
 */
export function sortAssetsHierarchically(assets: readonly AssetIndexRow[]): AssetIndexRow[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const childrenByParent = new Map<string, AssetIndexRow[]>();
  for (const asset of assets) {
    if (!asset.parentId || !byId.has(asset.parentId)) continue;
    const children = childrenByParent.get(asset.parentId) || [];
    children.push(asset);
    childrenByParent.set(asset.parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort(compareAssetCode);

  const ordered: AssetIndexRow[] = [];
  const visited = new Set<string>();
  const visit = (asset: AssetIndexRow) => {
    if (visited.has(asset.id)) return;
    visited.add(asset.id);
    ordered.push(asset);
    for (const child of childrenByParent.get(asset.id) || []) visit(child);
  };

  const roots = assets
    .filter((asset) => !asset.parentId || !byId.has(asset.parentId))
    .slice()
    .sort(compareAssetCode);
  for (const root of roots) visit(root);
  for (const asset of assets.slice().sort(compareAssetCode)) visit(asset);
  return ordered;
}

function safeExportSheetName(value: string, index: number, used: Set<string>): string {
  const base = value.replace(/[\\/*?:[\]]/g, "_").trim().slice(0, 31) || "Sheet" + (index + 1);
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    const suffixText = "_" + suffix;
    name = base.slice(0, Math.max(1, 31 - suffixText.length)) + suffixText;
    suffix += 1;
  }
  used.add(name);
  return name;
}

function estimateRowHeight(row: readonly string[], widths: readonly number[], rowIndex: number, titleRows: number, headerRow: number): number {
  if (rowIndex < titleRows) return 32;
  if (rowIndex === headerRow) return 30;
  const lineCount = row.reduce((maxLines, value, index) => {
    const width = Math.max(8, widths[index] || 18);
    const segments = String(value || "").split(/\r?\n/);
    const estimated = segments.reduce((total, segment) => total + Math.max(1, Math.ceil(segment.length / Math.max(8, width * 0.9))), 0);
    return Math.max(maxLines, estimated);
  }, 1);
  return Math.min(112, Math.max(26, lineCount * 16 + 8));
}

function buildWorksheet(sheet: AssetExportSheet): string {
  const rows = sheet.rows;
  const maxColumn = Math.max(rows.reduce((max, row) => Math.max(max, row.length), 0), 1);
  const lastColumn = columnName(maxColumn - 1);
  const lastRow = Math.max(rows.length, 1);
  const widths = Array.from({ length: maxColumn }, (_, index) => sheet.columnWidths[index] || 18);
  const headerRow = Math.max(0, sheet.headerRow || 0);
  const titleRows = Math.max(0, sheet.titleRows || 0);
  const freezeRows = Math.max(0, sheet.freezeRows == null ? 1 : sheet.freezeRows);
  const rowsXml = rows.map((row, rowIndex) => {
    const style = rowIndex < titleRows ? 2 : rowIndex === headerRow ? 1 : 0;
    const cells = row.map((value, columnIndex) => {
      const cellRef = columnName(columnIndex) + (rowIndex + 1);
      return "<c r=\"" + cellRef + "\" s=\"" + style + "\" t=\"inlineStr\"><is><t xml:space=\"preserve\">" +
        escapeXml(value) + "</t></is></c>";
    }).join("");
    return "<row r=\"" + (rowIndex + 1) + "\" ht=\"" +
      estimateRowHeight(row, widths, rowIndex, titleRows, headerRow) +
      "\" customHeight=\"1\">" + cells + "</row>";
  }).join("");
  const columnsXml = widths.map((width, index) =>
    "<col min=\"" + (index + 1) + "\" max=\"" + (index + 1) + "\" width=\"" +
    Math.max(8, Math.min(80, width)) + "\" customWidth=\"1\"/>"
  ).join("");
  const freezeXml = freezeRows > 0
    ? "<pane ySplit=\"" + freezeRows + "\" topLeftCell=\"A" + (freezeRows + 1) +
      "\" activePane=\"bottomLeft\" state=\"frozen\"/><selection pane=\"bottomLeft\" activeCell=\"A" +
      (freezeRows + 1) + "\" sqref=\"A" + (freezeRows + 1) + "\"/>"
    : "<selection activeCell=\"A1\" sqref=\"A1\"/>";
  const filterXml = sheet.autoFilter === false || rows.length <= headerRow + 1
    ? ""
    : "<autoFilter ref=\"A" + (headerRow + 1) + ":" + lastColumn + rows.length + "\"/>";
  return XML_HEADER +
    "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">" +
    "<dimension ref=\"A1:" + lastColumn + lastRow + "\"/><sheetViews><sheetView workbookViewId=\"0\">" +
    freezeXml + "</sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"18\"/><cols>" +
    columnsXml + "</cols><sheetData>" + rowsXml + "</sheetData>" + filterXml +
    "<pageMargins left=\"0.25\" right=\"0.25\" top=\"0.5\" bottom=\"0.5\" header=\"0.3\" footer=\"0.3\"/></worksheet>";
}

function buildZip(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(entry.data);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, 0);
    writeU16(localView, 12, 0);
    writeU32(localView, 14, checksum);
    writeU32(localView, 18, entry.data.length);
    writeU32(localView, 22, entry.data.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, entry.data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, 0);
    writeU16(centralView, 14, 0);
    writeU32(centralView, 16, checksum);
    writeU32(centralView, 20, entry.data.length);
    writeU32(centralView, 24, entry.data.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
    offset += localHeader.length + entry.data.length;
  }
  const centralDirectory = concatBytes(centralParts);
  const endOfCentralDirectory = new Uint8Array(22);
  const endView = new DataView(endOfCentralDirectory.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, entries.length);
  writeU16(endView, 10, entries.length);
  writeU32(endView, 12, centralDirectory.length);
  writeU32(endView, 16, offset);
  writeU16(endView, 20, 0);
  return concatBytes([...localParts, centralDirectory, endOfCentralDirectory]);
}

export function buildAssetWorkbookXlsx(sheets: readonly AssetExportSheet[]): Uint8Array {
  const encoder = new TextEncoder();
  const usedNames = new Set<string>();
  const normalizedSheets = (sheets.length ? sheets : [{ name: "资产总览", rows: [], columnWidths: [] }]).map((sheet, index) => ({
    ...sheet,
    name: safeExportSheetName(sheet.name, index, usedNames)
  }));
  const sheetNames = normalizedSheets.map((sheet) => sheet.name);
  const worksheetOverrides = normalizedSheets.map((_, index) =>
    "<Override PartName=\"/xl/worksheets/sheet" + (index + 1) +
    ".xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
  ).join("");
  const worksheetRelationships = normalizedSheets.map((_, index) =>
    "<Relationship Id=\"rId" + (index + 1) +
    "\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet" +
    (index + 1) + ".xml\"/>"
  ).join("");
  const workbookSheets = normalizedSheets.map((sheet, index) =>
    "<sheet name=\"" + escapeXml(sheet.name) + "\" sheetId=\"" + (index + 1) + "\" r:id=\"rId" + (index + 1) + "\"/>"
  ).join("");
  const titles = sheetNames.map((name) => "<vt:lpstr>" + escapeXml(name) + "</vt:lpstr>").join("");
  const now = new Date().toISOString();
  const styles = XML_HEADER +
    "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">" +
    "<fonts count=\"3\"><font><sz val=\"11\"/><name val=\"等线\"/></font>" +
    "<font><b/><sz val=\"11\"/><name val=\"等线\"/></font><font><b/><sz val=\"14\"/>" +
    "<color rgb=\"FF22264A\"/><name val=\"等线\"/></font></fonts><fills count=\"4\">" +
    "<fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill>" +
    "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFEDEBFF\"/><bgColor indexed=\"64\"/></patternFill></fill>" +
    "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFF4F2FF\"/><bgColor indexed=\"64\"/></patternFill></fill>" +
    "</fills><borders count=\"2\"><border><left/><right/><top/><bottom/><diagonal/></border>" +
    "<border><left style=\"thin\"><color rgb=\"FFD9D7EE\"/></left><right style=\"thin\"><color rgb=\"FFD9D7EE\"/></right>" +
    "<top style=\"thin\"><color rgb=\"FFD9D7EE\"/></top><bottom style=\"thin\"><color rgb=\"FFD9D7EE\"/></bottom><diagonal/></border></borders>" +
    "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>" +
    "<cellXfs count=\"3\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\" wrapText=\"1\"/></xf>" +
    "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"2\" borderId=\"1\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\" wrapText=\"1\"/></xf>" +
    "<xf numFmtId=\"0\" fontId=\"2\" fillId=\"3\" borderId=\"1\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\" wrapText=\"1\"/></xf>" +
    "</cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>";
  const contentTypes = XML_HEADER +
    "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
    "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
    "<Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>" +
    worksheetOverrides + "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>" +
    "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>" +
    "<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/></Types>";
  const rootRelationships = XML_HEADER +
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>" +
    "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>" +
    "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>";
  const coreProperties = XML_HEADER +
    "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">" +
    "<dc:creator>导演工作台</dc:creator><cp:lastModifiedBy>导演工作台</cp:lastModifiedBy>" +
    "<dcterms:created xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:type=\"dcterms:W3CDTF\">" + now + "</dcterms:created>" +
    "<dcterms:modified xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:type=\"dcterms:W3CDTF\">" + now + "</dcterms:modified></cp:coreProperties>";
  const appProperties = XML_HEADER +
    "<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>导演工作台</Application>" +
    "<DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\" size=\"2\" baseType=\"variant\">" +
    "<vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>" + sheetNames.length + "</vt:i4></vt:variant></vt:vector></HeadingPairs>" +
    "<TitlesOfParts><vt:vector xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\" size=\"" + sheetNames.length +
    "\" baseType=\"lpstr\">" + titles + "</vt:vector></TitlesOfParts></Properties>";
  const workbookXml = XML_HEADER +
    "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">" +
    "<fileVersion appName=\"xl\"/><workbookPr/><bookViews><workbookView xWindow=\"0\" yWindow=\"0\" windowWidth=\"18000\" windowHeight=\"12000\"/></bookViews>" +
    "<sheets>" + workbookSheets + "</sheets></workbook>";
  const styleRelationshipId = normalizedSheets.length + 1;
  const workbookRelationships = XML_HEADER +
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
    worksheetRelationships + "<Relationship Id=\"rId" + styleRelationshipId +
    "\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>";
  const entries = [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRelationships],
    ["docProps/core.xml", coreProperties],
    ["docProps/app.xml", appProperties],
    ["xl/workbook.xml", workbookXml],
    ["xl/_rels/workbook.xml.rels", workbookRelationships],
    ["xl/styles.xml", styles],
    ...normalizedSheets.map((sheet, index) => ["xl/worksheets/sheet" + (index + 1) + ".xml", buildWorksheet(sheet)])
  ].map(([name, content]) => ({ name, data: encoder.encode(content) }));
  return buildZip(entries);
}

function safeFileName(value: string): string {
  return String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 80) || "项目";
}

function assetStatusLabel(status: string): string {
  if (status === "confirmed") return "已确认";
  if (status === "needs_confirmation") return "待确认";
  return status || "未标记";
}

export function AssetExportButton({ projectTitle, assets }: { projectTitle: string; assets: AssetIndexRow[] }) {
  const [exporting, setExporting] = useState(false);

  const handleExport = () => {
    if (!assets.length || exporting) return;
    setExporting(true);
    try {
      const assetById = new Map(assets.map((asset) => [asset.id, asset]));
      const sortedAssets = sortAssetsHierarchically(assets);
      const dataSheets: AssetExportSheet[] = ASSET_EXPORT_SHEETS.map((definition) => {
        const sheetAssets = sortedAssets.filter((asset) => definition.types.includes(asset.type));
        return {
          name: definition.name,
          columnWidths: ASSET_EXPORT_WIDTHS,
          rows: [
            ASSET_EXPORT_HEADERS,
            ...sheetAssets.map((asset) => {
              const nameParts = splitAssetName(asset.name);
              const parent = asset.parentId ? assetById.get(asset.parentId) : null;
              return [
                asset.code,
                nameParts.standardName,
                nameParts.descriptor,
                assetStatusLabel(asset.status),
                TYPE_TAG[asset.type] || asset.type,
                asset.role || "—",
                assetEpisodeLabel(asset.episodeNumber),
                parent ? parent.code : asset.parentId || "—",
                displayAssetName(parent),
                asset.sourceText || "—",
                asset.notes || "—"
              ];
            })
          ]
        };
      });
      const summaryRows: readonly (readonly string[])[] = [
        [projectTitle + "｜资产清单", "", "", ""],
        ["导出说明", "人物、场景、道具等资产已按类别拆分到独立 Sheet；资产 ID、所属集、父资产、来源文本和备注均保留。", "", ""],
        ["字段说明", "标准名称取原名称中第一个“｜”前的部分；状态 / 着装 / 形态取其后的描述，不拆分描述中的“·”。", "", ""],
        ["工作表", "资产类别", "资产数量", "使用说明"],
        ...ASSET_EXPORT_SHEETS.map((definition) => [
          definition.name,
          definition.summary,
          String(sortedAssets.filter((asset) => definition.types.includes(asset.type)).length),
          definition.note
        ])
      ];
      const workbook = buildAssetWorkbookXlsx([
        { name: "资产总览", rows: summaryRows, columnWidths: [18, 68, 12, 34], freezeRows: 4, headerRow: 3, titleRows: 1, autoFilter: false },
        ...dataSheets
      ]);
      const blob = new Blob([new Uint8Array(workbook)], { type: XLSX_MIME });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = safeFileName(projectTitle) + "-资产表.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setExporting(false);
    }
  };

  return (
    <button
      type="button"
      className="quietButton assetExportButton"
      onClick={handleExport}
      disabled={!assets.length || exporting}
      title={assets.length ? "下载按人物、场景、道具等分类的 Excel 资产表" : "暂无可导出的资产"}
    >
      {exporting ? "正在导出…" : "导出 Excel"}
    </button>
  );
}

export function AssetIndexTabs({ assets }: { assets: AssetIndexRow[] }) {
  const visibleTabs = ASSET_INDEX_TABS.filter((tab) => assets.some((asset) => tab.types.includes(asset.type)));
  const [activeKey, setActiveKey] = useState(visibleTabs[0]?.key || "people");
  const activeTab = ASSET_INDEX_TABS.find((tab) => tab.key === activeKey) || ASSET_INDEX_TABS[0];
  const visible = sortAssetsHierarchically(assets.filter((asset) => activeTab.types.includes(asset.type)));

  if (!assets.length) {
    return <div className="studioTableScroll compactTable"><table><tbody><tr><td colSpan={4} className="emptyCell">尚未拆解资产名称</td></tr></tbody></table></div>;
  }

  const mainAssets = visible.filter((asset) => !asset.parentId);
  const childrenByParent = new Map<string, AssetIndexRow[]>();
  for (const asset of visible) {
    if (!asset.parentId) continue;
    const list = childrenByParent.get(asset.parentId) || [];
    list.push(asset);
    childrenByParent.set(asset.parentId, list);
  }
  const orphanChildren = visible.filter((asset) => asset.parentId && !mainAssets.some((main) => main.id === asset.parentId));
  const rows: Array<{ asset: AssetIndexRow; depth: number }> = [];
  for (const main of mainAssets) {
    rows.push({ asset: main, depth: 0 });
    for (const child of childrenByParent.get(main.id) || []) rows.push({ asset: child, depth: 1 });
  }
  for (const orphan of orphanChildren) rows.push({ asset: orphan, depth: 1 });

  return (
    <div className="assetIndexTabs">
      <div className="assetTabBar" role="tablist" aria-label="资产分类">
        {visibleTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeKey === tab.key}
            className={activeKey === tab.key ? "active" : ""}
            onClick={() => setActiveKey(tab.key)}
          >
            {tab.label}<b>{assets.filter((asset) => tab.types.includes(asset.type)).length}</b>
          </button>
        ))}
      </div>
      <div className="studioTableScroll compactTable">
        <table>
          <thead><tr><th>资产ID</th><th>类型</th><th>名称 / 状态</th><th>确认</th></tr></thead>
          <tbody>
            {rows.map(({ asset, depth }) => (
              <tr key={asset.id} className={depth > 0 ? "assetChildRow" : ""}>
                <td>{asset.code}</td>
                <td>
                  {depth === 0 ? (
                    <span className="assetTags">
                      <i className={"assetTypeTag " + (TYPE_TAG_CLASS[asset.type] || "typeOther")}>{TYPE_TAG[asset.type] || asset.type}</i>
                      {asset.role ? <i className={"assetRoleTag " + (ROLE_TAG_CLASS[asset.role] || "")}>{asset.role}</i> : null}
                    </span>
                  ) : null}
                </td>
                <td style={depth > 0 ? { paddingLeft: "34px" } : undefined}>
                  {depth > 0 ? <span className="assetChildMarker" aria-hidden="true">└ </span> : null}{asset.name}
                </td>
                <td><span className={"stateDot " + (asset.status === "confirmed" ? "ok" : "warn")}>{asset.status === "confirmed" ? "已确认" : "待确认"}</span></td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={4} className="emptyCell">该分类暂无资产</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
