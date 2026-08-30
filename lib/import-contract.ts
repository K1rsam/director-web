import { BUSINESS_TABLES, type BusinessTable } from "../db/business-schema.ts";

export type ImportScalar = string | number | boolean | null;
export type ImportRow = Record<string, ImportScalar>;
export type ImportBatch = { table: BusinessTable; rows: ImportRow[] };

const businessTableNames = new Set<string>(BUSINESS_TABLES);
const encoder = new TextEncoder();

export function parseImportBatch(input: unknown): ImportBatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("导入参数无效。");
  }

  const { table, rows } = input as { table?: unknown; rows?: unknown };
  if (typeof table !== "string" || !businessTableNames.has(table)) {
    throw new Error("该表不允许导入。");
  }
  if (!Array.isArray(rows)) {
    throw new Error("导入记录必须是数组。");
  }
  if (rows.length > 50) {
    throw new Error("每批最多 50 条记录。");
  }

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("每条导入记录必须是对象。");
    }
    for (const [column, value] of Object.entries(row)) {
      if (!column || !isScalar(value)) {
        throw new Error("导入字段只能包含 JSON 标量或 null。");
      }
    }
  }

  return { table: table as BusinessTable, rows: rows as ImportRow[] };
}

export async function verifyImportBearer(header: string | null, secret: string | null | undefined): Promise<boolean> {
  if (!secret) return false;
  const match = header?.match(/^Bearer ([^\s]+)$/);
  if (!match) return false;

  const [actual, expected] = await Promise.all([digest(match[1]), digest(secret)]);
  let difference = actual.length ^ expected.length;
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}

export function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isScalar(value: unknown): value is ImportScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
