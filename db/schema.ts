import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    sourceProjectId: text("source_project_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_projects_owner_updated").on(table.ownerUserId, table.updatedAt),
    uniqueIndex("idx_projects_owner_source").on(table.ownerUserId, table.sourceProjectId),
  ],
);

export const runnerTokens = sqliteTable(
  "runner_tokens",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("idx_runner_tokens_hash").on(table.tokenHash),
    index("idx_runner_tokens_owner").on(table.ownerUserId),
  ],
);

export const runnerJobs = sqliteTable(
  "runner_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    kind: text("kind", { enum: ["smoke", "project_foundation", "episode_pipeline"] }).notNull(),
    payload: text("payload").notNull().default("{}"),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "canceled"] })
      .notNull()
      .default("queued"),
    attempt: integer("attempt").notNull().default(0),
    leasedBy: text("leased_by"),
    leaseTokenHash: text("lease_token_hash"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    result: text("result"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_runner_jobs_owner_status_created").on(table.ownerUserId, table.status, table.createdAt),
    index("idx_runner_jobs_project_created").on(table.projectId, table.createdAt),
  ],
);
