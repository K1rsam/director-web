export async function allRows<T>(db: D1Database, sql: string, values: unknown[] = []): Promise<T[]> {
  const statement = values.length ? db.prepare(sql).bind(...values) : db.prepare(sql);
  return (await statement.all<T>()).results;
}

export async function firstRow<T>(db: D1Database, sql: string, values: unknown[] = []): Promise<T | null> {
  const statement = values.length ? db.prepare(sql).bind(...values) : db.prepare(sql);
  return statement.first<T>();
}
