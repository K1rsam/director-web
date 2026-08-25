import { env } from "cloudflare:workers";

import { BUSINESS_TABLES } from "@/db/business-schema";
import { getD1 } from "@/db";
import { parseImportBatch, quoteSqlIdentifier, verifyImportBearer } from "@/lib/import-contract";

type TableInfoRow = { name: string };
type CountRow = { count: number };

export async function POST(request: Request): Promise<Response> {
  const secret = env.DIRECTOR_IMPORT_TOKEN;
  if (!secret) return Response.json({ error: "not_found" }, { status: 404 });
  if (!(await verifyImportBearer(request.headers.get("authorization"), secret))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let batch;
  try {
    batch = parseImportBatch(await request.json());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "导入参数无效。" },
      { status: 400 },
    );
  }
  if (batch.rows.length === 0) return Response.json({ table: batch.table, inserted: 0 });

  const d1 = getD1();
  const schema = await d1
    .prepare(`PRAGMA table_info(${quoteSqlIdentifier(batch.table)})`)
    .all<TableInfoRow>();
  const allowedColumns = new Set(schema.results.map((column) => column.name));

  try {
    const statements = batch.rows.map((row) => {
      const columns = Object.keys(row);
      if (columns.length === 0 || columns.some((column) => !allowedColumns.has(column))) {
        throw new Error("导入记录包含未知字段。");
      }
      const identifiers = columns.map(quoteSqlIdentifier).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      const values = columns.map((column) => (typeof row[column] === "boolean" ? Number(row[column]) : row[column]));
      return d1
        .prepare(
          `INSERT OR REPLACE INTO ${quoteSqlIdentifier(batch.table)} (${identifiers}) VALUES (${placeholders})`,
        )
        .bind(...values);
    });
    await d1.batch(statements);
  } catch {
    return Response.json({ error: "导入记录与目标表不匹配。" }, { status: 400 });
  }

  return Response.json({ table: batch.table, inserted: batch.rows.length });
}

export async function GET(request: Request): Promise<Response> {
  const secret = env.DIRECTOR_IMPORT_TOKEN;
  if (!secret) return Response.json({ error: "not_found" }, { status: 404 });
  if (!(await verifyImportBearer(request.headers.get("authorization"), secret))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const d1 = getD1();
  const results = await d1.batch(
    BUSINESS_TABLES.map((table) =>
      d1.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`),
    ),
  );
  const counts = Object.fromEntries(
    BUSINESS_TABLES.map((table, index) => [
      table,
      Number((results[index]?.results[0] as CountRow | undefined)?.count ?? 0),
    ]),
  );
  return Response.json({ counts });
}
