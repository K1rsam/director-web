import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("User", {
  id: text("id").primaryKey(),
});

export const businessProjects = sqliteTable(
  "Project",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
  },
);

export const projectRoles = sqliteTable(
  "ProjectRole",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("projectId").notNull().references(() => businessProjects.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
  },
  (table) => [index("ProjectRole_projectId_idx").on(table.projectId)],
);

export const runnerTokens = sqliteTable(
  "runner_tokens",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    statusJson: text("status_json"),
    statusCheckedAt: integer("status_checked_at", { mode: "timestamp_ms" }),
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
      .references(() => businessProjects.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    kind: text("kind", { enum: ["smoke", "codex_prompt", "project_foundation", "episode_pipeline"] }).notNull(),
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
