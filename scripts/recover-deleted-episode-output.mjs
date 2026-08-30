import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * 从 SQLite 主库/WAL 的旧页中只读扫描被误删的剧集生成记录。
 *
 * 这个脚本默认只预览，不写数据库。它不是普通导出脚本：目标是从删除后
 * 仍可能残留的 B-tree/WAL 页中尽量找回记录。只有预览结果确认后，才允许
 * 后续另行编写恢复落库步骤。
 */

const TARGET_TABLES = [
  "StoryboardShot",
  "SeedanceUnit",
  "SeedanceUnitShot",
  "CompiledPromptVersion",
  "WorkflowIssue",
  "PipelineRun",
  "CliRoleSession",
  "ApiRoleSession",
  "SceneSnapshot",
  "GenerationRun",
  "TaskPackage"
];

const args = parseArgs(process.argv.slice(2));
const mainBytes = fs.readFileSync(args.db);
const walBytes = fs.existsSync(args.wal) ? fs.readFileSync(args.wal) : null;
const db = new DatabaseSync(args.db, { readOnly: true });

const pageSize = readUInt16BE(mainBytes, 16) || 4096;
const reserved = mainBytes[20] ?? 0;
const usableSize = pageSize - reserved;
const project = db.prepare("select id,title from Project where id=?").get(args.project);
if (!project) throw new Error("找不到项目：" + args.project);
const episodes = db.prepare("select id,number,title from Episode where projectId=? and number between ? and ? order by number")
  .all(args.project, args.from, args.to);
const expected = args.to - args.from + 1;
if (episodes.length !== expected) {
  throw new Error("目标剧集范围不完整，预览中止：期望 " + expected + " 集，实际 " + episodes.length + " 集。");
}

const episodeIds = new Set(episodes.map((row) => String(row.id)));
const episodeById = new Map(episodes.map((row) => [String(row.id), Number(row.number)]));
const schemas = loadSchemas(db);
const sceneIds = new Set(db.prepare("select id from ScriptScene where episodeId in (" + [...episodeIds].map(() => "?").join(",") + ")").all(...episodeIds).map((row) => String(row.id)));
const taskPackageIds = new Set(db.prepare("select id from TaskPackage where projectId=? and episodeId in (" + [...episodeIds].map(() => "?").join(",") + ")").all(args.project, ...episodeIds).map((row) => String(row.id)));
const pageSources = buildPageSources(mainBytes, walBytes, pageSize);
const freePages = collectFreelistPages(mainBytes, pageSources, pageSize);
const rows = [];

for (const candidate of pageSources) {
  const parsed = parseTableLeafPage(candidate, pageSources, pageSize, usableSize);
  for (const row of parsed) rows.push({ ...row, freePage: freePages.has(candidate.pageNo) });
}

const generic = dedupeRows(rows);
const existingIds = loadExistingIds(db, TARGET_TABLES);
const direct = new Map();
for (const table of TARGET_TABLES) direct.set(table, new Map());

// 第一遍先找拥有 episodeId/projectId 的记录，建立可用于关联提示词/镜关联的 ID 集合。
const targetIds = {
  projectId: args.project,
  episodeIds,
  shotIds: new Set(),
  unitIds: new Set(),
  taskPackageIds: new Set(),
  sceneSnapshotIds: new Set()
};

for (const row of generic) {
  const tableNames = tableCandidates(row, schemas);
  const best = bestTableForRow(row, tableNames, schemas, { projectId: args.project, episodeIds, sceneIds, taskPackageIds, unitIds: targetIds.unitIds, shotIds: targetIds.shotIds });
  if (!best) continue;
  const mapped = best.mapped;
  const table = best.table;
  if (table === "StoryboardShot" && episodeIds.has(String(mapped.episodeId))) targetIds.shotIds.add(String(mapped.id));
  if (table === "SeedanceUnit" && episodeIds.has(String(mapped.episodeId))) targetIds.unitIds.add(String(mapped.id));
  if (table === "TaskPackage" && String(mapped.projectId) === args.project && episodeIds.has(String(mapped.episodeId))) targetIds.taskPackageIds.add(String(mapped.id));
  if (table === "SceneSnapshot" && episodeIds.has(String(mapped.episodeId))) targetIds.sceneSnapshotIds.add(String(mapped.id));
}

for (const row of generic) {
  const best = bestTableForRow(row, tableCandidates(row, schemas), schemas, { projectId: args.project, episodeIds, sceneIds, taskPackageIds, unitIds: targetIds.unitIds, shotIds: targetIds.shotIds });
  if (!best || !isTargetRow(best.table, best.mapped, targetIds)) continue;
  const id = String(best.mapped.id ?? "");
  if (!id || existingIds.get(best.table)?.has(id)) continue;
  const bucket = direct.get(best.table);
  const candidate = { table: best.table, mapped: best.mapped, raw: row, score: best.score };
  if (!bucket.has(id) || candidate.score + scoreRow(row) > bucket.get(id).score + scoreRow(bucket.get(id).raw)) {
    bucket.set(id, candidate);
  }
}

const result = {};
for (const table of TARGET_TABLES) {
  const values = [...direct.get(table).values()];
  result[table] = {
    count: values.length,
    byEpisode: groupByEpisode(values, episodeById),
    samples: values.slice(0, 3).map((item) => ({
      id: item.mapped.id,
      episodeId: item.mapped.episodeId ?? null,
      episode: item.mapped.episodeId ? episodeById.get(String(item.mapped.episodeId)) ?? null : null,
      unitId: item.mapped.unitId ?? null,
      shotId: item.mapped.shotId ?? null,
      stageCode: item.mapped.stageCode ?? null,
      sceneKey: item.mapped.sceneKey ?? null,
      source: item.raw.source,
      pageNo: item.raw.pageNo,
      freePage: item.raw.freePage
    }))
  };
}

const unitEpisodeById = new Map([...direct.get("SeedanceUnit").values()].map((item) => [String(item.mapped.id), episodeById.get(String(item.mapped.episodeId)) ?? null]));
const shotEpisodeById = new Map([...direct.get("StoryboardShot").values()].map((item) => [String(item.mapped.id), episodeById.get(String(item.mapped.episodeId)) ?? null]));
const diagnostic = {
  unitsByEpisodeAndKey: groupKeys(direct.get("SeedanceUnit"), "unitKey", episodeById),
  shotsByEpisodeAndKey: groupKeys(direct.get("StoryboardShot"), "shotKey", episodeById),
  promptsByEpisode: countByReference(direct.get("CompiledPromptVersion"), "unitId", unitEpisodeById),
  linksByEpisode: countByReference(direct.get("SeedanceUnitShot"), "unitId", unitEpisodeById),
  linksWithMissingShot: [...direct.get("SeedanceUnitShot").values()].filter((item) => !shotEpisodeById.has(String(item.mapped.shotId))).length,
  runStagesByEpisode: groupStages(direct.get("PipelineRun"), episodeById),
  issueCodesByEpisode: groupCodes(direct.get("WorkflowIssue"), episodeById)
};

if (args.detailTable) {
  const detailTables = args.detailTable === "all" ? TARGET_TABLES : args.detailTable.split(",").map((value) => value.trim()).filter(Boolean);
  const details = Object.fromEntries(detailTables.map((table) => {
    const values = [...(direct.get(table)?.values() ?? [])]
      .filter((item) => !args.detailField || String(item.mapped[args.detailField] ?? "") === args.detailValue)
      .map((item) => ({
        table: item.table,
        score: item.score,
        mapped: args.detailFull ? item.mapped : summarizeMapped(item.mapped),
        source: item.raw.source,
        pageNo: item.raw.pageNo,
        freePage: item.raw.freePage,
        serialTypes: item.raw.serialTypes,
        storedColumnCount: item.raw.values.length
      }));
    return [table, { count: values.length, values }];
  }));
  console.log(JSON.stringify({ mode: "detail", tables: detailTables, field: args.detailField ?? null, value: args.detailValue ?? null, details }, bigintReplacer, 2));
} else console.log(JSON.stringify({
  mode: "preview-only",
  db: args.db,
  wal: args.wal,
  project,
  range: [args.from, args.to],
  pageSize,
  pageCount: Math.floor(mainBytes.length / pageSize),
  walFrames: walBytes ? Math.max(0, Math.floor((walBytes.length - 32) / (pageSize + 24))) : 0,
  scannedPageCandidates: pageSources.length,
  freelistPages: freePages.size,
  genericRows: generic.length,
  recoverable: result,
  diagnostic,
  targetIds: {
    shots: targetIds.shotIds.size,
    units: targetIds.unitIds.size,
    taskPackages: targetIds.taskPackageIds.size
  }
}, null, 2));

function parseArgs(values) {
  const get = (name) => {
    const index = values.indexOf(name);
    return index >= 0 ? values[index + 1] : undefined;
  };
  const db = get("--db");
  const project = get("--project");
  const from = Number(get("--from") ?? 1);
  const to = Number(get("--to") ?? 16);
  if (!db || !project) throw new Error("用法：node scripts/recover-deleted-episode-output.mjs --db <只读副本> --project <项目ID> --from 1 --to 16");
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new Error("剧集范围无效。");
  const absoluteDb = resolvePath(db);
  return {
    db: absoluteDb,
    wal: get("--wal") ? resolvePath(get("--wal")) : absoluteDb + "-wal",
    project,
    from,
    to,
    detailTable: get("--detail-table"),
    detailField: get("--detail-field"),
    detailValue: get("--detail-value"),
    detailFull: values.includes("--detail-full")
  };
}

function resolvePath(value) {
  return value.replaceAll("\\", "/");
}

function loadSchemas(database) {
  const schemas = new Map();
  const tables = database.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all();
  for (const table of tables) {
    const name = String(table.name);
    const columns = database.prepare("pragma table_info(\"" + name.replaceAll("\"", "\"\"") + "\")").all().map((column) => String(column.name));
    schemas.set(name, { name, columns });
  }
  return schemas;
}

function loadExistingIds(database, tableNames) {
  const output = new Map();
  for (const table of tableNames) {
    const ids = new Set(database.prepare("select id from \"" + table + "\"").all().map((row) => String(row.id)));
    output.set(table, ids);
  }
  return output;
}

function buildPageSources(main, wal, pageSize) {
  const sources = [];
  const mainPages = Math.floor(main.length / pageSize);
  for (let pageNo = 1; pageNo <= mainPages; pageNo++) {
    sources.push({ pageNo, source: "main", frame: -1, data: main.subarray((pageNo - 1) * pageSize, pageNo * pageSize) });
  }
  if (wal && wal.length >= 32) {
    const frameSize = pageSize + 24;
    let offset = 32;
    let frame = 0;
    while (offset + frameSize <= wal.length) {
      const pageNo = wal.readUInt32BE(offset);
      if (pageNo > 0) {
        sources.push({ pageNo, source: "wal", frame, data: wal.subarray(offset + 24, offset + frameSize) });
      }
      frame++;
      offset += frameSize;
    }
  }
  return sources;
}

function collectFreelistPages(main, pageSources, pageSize) {
  const pages = new Set();
  const firstTrunk = main.readUInt32BE(32);
  const total = main.readUInt32BE(36);
  let trunk = firstTrunk;
  let guard = 0;
  while (trunk && guard++ < total + 10) {
    pages.add(trunk);
    const page = pageSources.find((item) => item.pageNo === trunk && item.source === "main")?.data;
    if (!page || page.length < 8) break;
    const next = page.readUInt32BE(0);
    const leafCount = Math.min(page.readUInt32BE(4), Math.floor((pageSize - 8) / 4));
    for (let i = 0; i < leafCount; i++) {
      const leaf = page.readUInt32BE(8 + i * 4);
      if (leaf) pages.add(leaf);
    }
    trunk = next;
  }
  return pages;
}

function parseTableLeafPage(candidate, pageSources, pageSize, usableSize) {
  const page = candidate.data;
  const headerOffset = candidate.pageNo === 1 ? 100 : 0;
  if (page.length < headerOffset + 8) return [];
  const isLeaf = page[headerOffset] === 0x0d;
  if (!isLeaf) return scanLoosePayloads(page, candidate, pageSize, headerOffset);
  const cellCount = page.readUInt16BE(headerOffset + 3);
  if (cellCount > Math.floor((pageSize - headerOffset - 8) / 2)) return [];
  const rows = [];
  for (let i = 0; i < cellCount; i++) {
    const pointerOffset = headerOffset + 8 + i * 2;
    const pointer = page.readUInt16BE(pointerOffset);
    if (pointer < headerOffset + 8 || pointer >= pageSize - 4) continue;
    const cell = parseCell(page, pointer, candidate, pageSources, pageSize, usableSize);
    if (!cell) continue;
    const record = parseRecord(cell.payload);
    if (!record || !record.values.length) continue;
    rows.push({ ...record, pageNo: candidate.pageNo, source: candidate.source + (candidate.frame >= 0 ? ":" + candidate.frame : ""), raw: candidate, freePage: false });
  }
  // 删除单元格后，SQLite 可能只把原 cell 标记成 freeblock，旧 payload 仍残留在页内。
  // freeblock 头会覆盖原 cell 的前几个字节，所以从头后的每个偏移尝试解析 record
  // payload；后面的语义评分会过滤随机字节，避免把碎片直接当成有效数据。
  for (const block of freeBlocks(page, headerOffset, pageSize)) {
    const end = Math.min(pageSize, block.offset + block.size);
    for (let offset = block.offset + 4; offset + 4 < end; offset++) {
      const record = parseRecord(page.subarray(offset, end));
      if (!record || !record.values.length || record.bytesUsed < 8) continue;
      rows.push({ ...record, pageNo: candidate.pageNo, source: candidate.source + (candidate.frame >= 0 ? ":" + candidate.frame : "") + ":freeblock", raw: candidate, freePage: true });
    }
  }
  // 有些删除操作把旧 cell 留在未链接的碎片区，未必挂在 freeblock 链上。再做一次
  // 轻量的页内 payload 探测，只保留含目标项目/剧集 ID 或分镜/单元键的候选，
  // 用来找回前面被覆盖了 cell 头但 payload 本体仍完整的记录。
  rows.push(...scanLoosePayloads(page, candidate, pageSize, headerOffset));
  return rows;
}

function scanLoosePayloads(page, candidate, pageSize, headerOffset) {
  const rows = [];
  for (let offset = headerOffset + 8; offset + 12 < pageSize; offset++) {
    const header = readVarint(page, offset);
    if (!header || header.value < 2n || header.value > 256n) continue;
    const record = parseRecord(page.subarray(offset));
    if (!record || !record.values.length || record.bytesUsed > pageSize - offset) continue;
    if (!record.values.some((value) => typeof value === "string" && (/^cmt/u.test(value) || /^\d{1,2}-1-[US]\d+/u.test(value)))) continue;
    rows.push({ ...record, pageNo: candidate.pageNo, source: candidate.source + (candidate.frame >= 0 ? ":" + candidate.frame : "") + ":loose", raw: candidate, freePage: freePagesForLoose(candidate) });
  }
  return rows;
}

function freePagesForLoose(candidate) {
  // loose 探测的页是否属于 freelist 在调用处不可直接访问；默认按页内残留候选处理，
  // 具体优先级仍由来源和记录语义决定。
  return false;
}

function freeBlocks(page, headerOffset, pageSize) {
  const blocks = [];
  let next = page.readUInt16BE(headerOffset + 1);
  let guard = 0;
  while (next >= headerOffset + 8 && next + 4 <= pageSize && guard++ < 1000) {
    const size = page.readUInt16BE(next + 2);
    if (size < 4 || next + size > pageSize) break;
    blocks.push({ offset: next, size });
    next = page.readUInt16BE(next);
  }
  return blocks;
}

function parseCell(page, pointer, candidate, pageSources, pageSize, usableSize) {
  const payloadLength = readVarint(page, pointer);
  if (!payloadLength) return null;
  const rowid = readVarint(page, pointer + payloadLength.bytes);
  if (!rowid) return null;
  const payloadStart = pointer + payloadLength.bytes + rowid.bytes;
  if (payloadStart >= pageSize) return null;
  const total = Number(payloadLength.value);
  if (!Number.isSafeInteger(total) || total < 1 || total > 20_000_000) return null;
  const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
  const maxLocal = usableSize - 35;
  let local = total <= maxLocal ? total : minLocal + ((total - minLocal) % (usableSize - 4));
  if (total > maxLocal && local > maxLocal) local = minLocal;
  if (payloadStart + local > pageSize) return null;
  const chunks = [page.subarray(payloadStart, payloadStart + local)];
  let remaining = total - local;
  let overflowPointer = remaining > 0 ? page.readUInt32BE(payloadStart + local) : 0;
  let guard = 0;
  while (remaining > 0 && overflowPointer && guard++ < 100_000) {
    const overflowPage = pageForVersion(pageSources, overflowPointer, candidate);
    if (!overflowPage || overflowPage.length < 4) return null;
    const next = overflowPage.readUInt32BE(0);
    const take = Math.min(remaining, pageSize - 4);
    chunks.push(overflowPage.subarray(4, 4 + take));
    remaining -= take;
    overflowPointer = next;
  }
  if (remaining !== 0) return null;
  return { payload: Buffer.concat(chunks, total) };
}

function pageForVersion(pageSources, pageNo, candidate) {
  const candidates = pageSources.filter((item) => item.pageNo === pageNo);
  if (!candidates.length) return null;
  if (candidate.source === "main") return candidates.find((item) => item.source === "main")?.data ?? null;
  const frame = candidate.frame;
  const prior = candidates.filter((item) => item.source === "main" || (item.source === "wal" && item.frame <= frame));
  if (!prior.length) return null;
  return prior.at(-1).data;
}

function parseRecord(payload) {
  const header = readVarint(payload, 0);
  if (!header) return null;
  const headerSize = Number(header.value);
  if (!Number.isSafeInteger(headerSize) || headerSize < header.bytes || headerSize > payload.length) return null;
  const serialTypes = [];
  let offset = header.bytes;
  while (offset < headerSize) {
    const value = readVarint(payload, offset);
    if (!value) return null;
    serialTypes.push(Number(value.value));
    offset += value.bytes;
    if (serialTypes.length > 64) return null;
  }
  let dataOffset = headerSize;
  const values = [];
  for (const serialType of serialTypes) {
    const size = serialTypeSize(serialType);
    if (size === null || dataOffset + size > payload.length) return null;
    values.push(decodeSerial(payload.subarray(dataOffset, dataOffset + size), serialType));
    dataOffset += size;
  }
  return { values, serialTypes, bytesUsed: dataOffset };
}

function serialTypeSize(type) {
  if (type === 0 || type === 8 || type === 9) return 0;
  if (type >= 1 && type <= 7) return [0, 1, 2, 3, 4, 6, 8, 8][type];
  // 12/13 表示长度为 0 的 BLOB/TEXT，14/15 表示长度为 1，依此类推。
  if (type >= 12) return Math.floor((type - 12) / 2);
  return null;
}

function decodeSerial(bytes, type) {
  if (type === 0) return null;
  if (type === 8) return 0;
  if (type === 9) return 1;
  if (type === 1) return bytes.readInt8(0);
  if (type === 2) return bytes.readInt16BE(0);
  if (type === 3) return signedBigEndian(bytes);
  if (type === 4) return bytes.readInt32BE(0);
  if (type === 5 || type === 6) return Number(signedBigEndian(bytes));
  if (type === 7) return bytes.readDoubleBE(0);
  if (type >= 12) return type % 2 === 0 ? Buffer.from(bytes) : bytes.toString("utf8");
  return null;
}

function signedBigEndian(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const bits = BigInt(bytes.length * 8);
  if (value & (1n << (bits - 1n))) value -= 1n << bits;
  return value;
}

function readVarint(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) return null;
  let value = 0n;
  for (let i = 0; i < 9 && offset + i < buffer.length; i++) {
    const byte = buffer[offset + i];
    if (i === 8) {
      value = (value << 8n) | BigInt(byte);
      return { value, bytes: 9 };
    }
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, bytes: i + 1 };
  }
  return null;
}

function readUInt16BE(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readUInt16BE(offset) : 0;
}

function tableCandidates(row, schemas) {
  const count = row.values.length;
  return [...schemas.values()]
    // SQLite 在新增列后，旧记录的 record header 可能仍少于当前列数；允许尾部缺列，
    // 由字段语义评分决定是旧 PipelineRun 还是同列数的 WorkflowIssue/StoryboardShot。
    .filter((schema) => TARGET_TABLES.includes(schema.name) && schema.columns.length >= count && count >= 3)
    .map((schema) => schema.name);
}

function mapRow(table, values, columns) {
  if (values.length > columns.length || typeof values[0] !== "string") return null;
  const mapped = { id: values[0] };
  for (let i = 0; i < columns.length; i++) mapped[columns[i]] = values[i] ?? null;
  return mapped;
}

function bestTableForRow(row, names, schemas, context) {
  const scored = [];
  for (const table of names) {
    const columns = schemas.get(table)?.columns ?? [];
    const mapped = mapRow(table, row.values, columns);
    if (!mapped) continue;
    const score = scoreMappedRow(table, mapped, row.values.length, context);
    if (score > 0) scored.push({ table, mapped, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
}

function scoreMappedRow(table, row, storedColumnCount, context) {
  const id = String(row.id ?? "");
  if (!id || id.length < 12) return -100;
  let score = 1 + (storedColumnCount === Object.keys(row).length ? 4 : 0);
  const isStage = (value) => ["P0", "P1", "P2", "P3", "P4", "E0", "E1", "E2", "E3", "E4", "E5"].includes(String(value));
  const isStatus = (value) => ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "OPEN", "RESOLVED", "EXCEPTED", "DRAFT", "READY", "DONE"].includes(String(value));
  const targetEpisode = context.episodeIds.has(String(row.episodeId));
  const targetProject = String(row.projectId) === context.projectId;
  if (table === "StoryboardShot") {
    if (!targetEpisode) return -100;
    if (!/^\d+-\d+-S\d{3}(?:-[a-z0-9]+)?$/u.test(String(row.shotKey ?? ""))) return -100;
    if (!Number.isInteger(row.sortOrder) || !Number.isFinite(row.duration) || row.duration <= 0 || row.duration > 60) return -100;
    if (!context.sceneIds.has(String(row.sceneId))) return -100;
    if (!isJsonArray(row.sourceNodeRefs) || !isJsonArray(row.dialogue)) return -100;
    if (!["e1Data", "e2Data", "e3Data", "e4Data"].every((field) => isJsonObject(row[field]))) return -100;
    if (typeof row.revision !== "string" || !isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt)) return -100;
    score += 35;
    score += 35;
    score += 15;
    score += 5;
  } else if (table === "SeedanceUnit") {
    if (!targetEpisode) return -100;
    if (!/^\d+-\d+-U\d{2,3}$/u.test(String(row.unitKey ?? ""))) return -100;
    if (!Number.isInteger(row.sortOrder) || !Number.isFinite(row.duration) || row.duration <= 0 || row.duration > 60) return -100;
    if (!context.sceneIds.has(String(row.sceneId))) return -100;
    if (typeof row.startPremise !== "string" || typeof row.endState !== "string" || !isJsonObject(row.data)) return -100;
    if (typeof row.revision !== "string" || !isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt)) return -100;
    score += 35;
    score += 35;
    score += 15;
    score += 5;
  } else if (table === "SeedanceUnitShot") {
    if (!context.unitIds.has(String(row.unitId)) && !context.shotIds.has(String(row.shotId))) return -100;
    if (!Number.isInteger(row.sortOrder)) return -100;
    score += 50;
    score += 10;
  } else if (table === "CompiledPromptVersion") {
    if (!context.unitIds.has(String(row.unitId))) return -100;
    if (!Number.isInteger(row.version) || typeof row.content !== "string" || row.content.length < 20) return -100;
    if (!["DRAFT_COMPILED", "RELEASE_COMPILED", "MANUAL_UNSYNCED", "STALE"].includes(String(row.syncStatus))) return -100;
    if (!isTimestamp(row.selectedAt) || !isTimestamp(row.createdAt)) return -100;
    score += 50;
    score += 10;
    score += 20;
  } else if (table === "WorkflowIssue") {
    if (!targetEpisode) return -100;
    if (!targetProject || typeof row.coordinate !== "string" || typeof row.code !== "string" || !/^[A-Z][A-Z0-9_]+$/u.test(row.code)) return -100;
    if (!isIssueSeverity(row.severity) || !isIssueStatus(row.status) || typeof row.ownerRole !== "string") return -100;
    if (!["expected", "evidence", "requestedEffect", "revision"].every((field) => typeof row[field] === "string")) return -100;
    if (!isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt)) return -100;
    score += 25;
    const coordinate = String(row.coordinate ?? "");
    score += /\.|source_node|E[0-5]\./u.test(coordinate) ? 35 : -25;
    score += 12;
    score += 8;
    if (isStage(row.shotId) || isStage(row.unitId)) score -= 35;
  } else if (table === "PipelineRun") {
    if (!targetProject || !context.episodeIds.has(String(row.episodeId))) return -100;
    if (!isStage(row.stageCode) || !isStatus(row.status) || typeof row.roleName !== "string" || !isTimestamp(row.createdAt)) return -100;
    score += 35;
    score += 35;
    score += 6;
    score += 12;
  } else if (table === "CliRoleSession" || table === "ApiRoleSession") {
    if (!targetProject || !context.episodeIds.has(String(row.episodeId))) return -100;
    if (!isStage(row.stageCode) || typeof row.model !== "string" || !isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt)) return -100;
    score += 30;
    score += 30;
    score += table === "ApiRoleSession"
      ? (typeof row.messages === "string" && row.messages.trim().startsWith("[") ? 25 : -100)
      : (typeof row.sessionId === "string" && row.sessionId.length > 8 ? 15 : -100);
  } else if (table === "SceneSnapshot") {
    if (!targetProject || !context.episodeIds.has(String(row.episodeId))) return -100;
    if (!/^EP-\d+-BEATS$/u.test(String(row.sceneKey ?? "")) || typeof row.content !== "string" || row.content.length <= 20 || !isJsonValue(row.content) || !isTimestamp(row.createdAt)) return -100;
    score += 35;
    score += /^EP-\d+-BEATS$/u.test(String(row.sceneKey ?? "")) ? 35 : 0;
    score += 10;
  } else if (table === "TaskPackage") {
    if (!targetProject || !context.episodeIds.has(String(row.episodeId))) return -100;
    score += 35;
    score += isStatus(row.status) ? 12 : -12;
    score += typeof row.title === "string" && row.title.length > 0 ? 8 : -8;
  } else if (table === "GenerationRun") {
    if (!targetProject || !context.taskPackageIds.has(String(row.taskPackageId))) return -100;
    score += 40;
    score += typeof row.prompt === "string" || typeof row.output === "string" ? 15 : 0;
    score += isStatus(row.status) ? 8 : -8;
  }
  return score;
}

function isTimestamp(value) {
  return (typeof value === "number" && Number.isFinite(value) && value >= 1_500_000_000_000 && value <= 2_000_000_000_000)
    || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isJsonValue(value) {
  if (typeof value !== "string") return false;
  try { JSON.parse(value); return true; } catch { return false; }
}

function isJsonObject(value) {
  if (!isJsonValue(value)) return false;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed); } catch { return false; }
}

function isJsonArray(value) {
  if (!isJsonValue(value)) return false;
  try { return Array.isArray(JSON.parse(value)); } catch { return false; }
}

function isIssueSeverity(value) { return ["BLOCKER", "MAJOR", "MINOR"].includes(String(value)); }
function isIssueStatus(value) { return ["OPEN", "RESOLVED", "EXCEPTED"].includes(String(value)); }

function isTargetRow(table, row, target) {
  if (table === "StoryboardShot" || table === "SeedanceUnit" || table === "WorkflowIssue" || table === "PipelineRun" || table === "CliRoleSession" || table === "ApiRoleSession" || table === "SceneSnapshot") {
    return target.episodeIds.has(String(row.episodeId));
  }
  if (table === "TaskPackage") return String(row.projectId) === target.projectId && target.episodeIds.has(String(row.episodeId));
  if (table === "SeedanceUnitShot") return target.unitIds.has(String(row.unitId)) || target.shotIds.has(String(row.shotId));
  if (table === "CompiledPromptVersion") return target.unitIds.has(String(row.unitId));
  if (table === "GenerationRun") return target.taskPackageIds.has(String(row.taskPackageId));
  return false;
}

function dedupeRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = row.source + ":" + row.pageNo + ":" + row.values.map(valueKey).join("|");
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

function valueKey(value) {
  if (Buffer.isBuffer(value)) return "blob:" + value.toString("hex");
  return typeof value + ":" + String(value);
}

function summarizeMapped(row) {
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" && value.length > 220) output[key] = `[string:${value.length}] ${value.slice(0, 180)}…`;
    else if (Buffer.isBuffer(value)) output[key] = `[blob:${value.length}]`;
    else output[key] = value;
  }
  return output;
}

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? Number(value) : value;
}

function scoreRow(row) {
  return (row.freePage ? 20 : 0) + (row.source.startsWith("wal") ? 10 : 0) + row.values.reduce((sum, value) => sum + (typeof value === "string" && value.length > 100 ? 1 : 0), 0);
}

function groupByEpisode(values, episodeById) {
  const output = {};
  for (const item of values) {
    const number = item.mapped.episodeId ? episodeById.get(String(item.mapped.episodeId)) : null;
    const key = number ? String(number) : "unknown";
    output[key] = (output[key] ?? 0) + 1;
  }
  return output;
}

function groupKeys(values, field, episodeById) {
  const output = {};
  for (const item of values.values()) {
    const episode = episodeById.get(String(item.mapped.episodeId));
    if (!episode) continue;
    const key = String(item.mapped[field] ?? "");
    output[episode] ??= {};
    output[episode][key] = (output[episode][key] ?? 0) + 1;
  }
  return output;
}

function countByReference(values, field, referenceMap) {
  const output = {};
  for (const item of values.values()) {
    const episode = referenceMap.get(String(item.mapped[field]));
    const key = episode ? String(episode) : "unknown";
    output[key] = (output[key] ?? 0) + 1;
  }
  return output;
}

function groupStages(values, episodeById) {
  const output = {};
  for (const item of values.values()) {
    const episode = episodeById.get(String(item.mapped.episodeId));
    if (!episode) continue;
    const stage = String(item.mapped.stageCode ?? "?");
    output[episode] ??= {};
    output[episode][stage] = (output[episode][stage] ?? 0) + 1;
  }
  return output;
}

function groupCodes(values, episodeById) {
  const output = {};
  for (const item of values.values()) {
    const episode = episodeById.get(String(item.mapped.episodeId));
    if (!episode) continue;
    const code = String(item.mapped.code ?? "?");
    output[episode] ??= {};
    output[episode][code] = (output[episode][code] ?? 0) + 1;
  }
  return output;
}
