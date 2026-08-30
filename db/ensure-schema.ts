import { getD1 } from "./index";

let schemaReady: Promise<void> | null = null;

export function ensureControlPlaneSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const d1 = getD1();
    await d1.batch([
      d1.prepare(`CREATE TABLE IF NOT EXISTS runner_tokens (
        id TEXT PRIMARY KEY NOT NULL,
        owner_user_id TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER,
        status_json TEXT,
        status_checked_at INTEGER
      )`),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_tokens_hash ON runner_tokens(token_hash)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_runner_tokens_owner ON runner_tokens(owner_user_id)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS runner_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        attempt INTEGER NOT NULL DEFAULT 0,
        leased_by TEXT,
        lease_token_hash TEXT,
        lease_expires_at INTEGER,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_runner_jobs_owner_status_created ON runner_jobs(owner_user_id, status, created_at)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_runner_jobs_project_created ON runner_jobs(project_id, created_at)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS runner_diagnostic_logs (
        id TEXT PRIMARY KEY NOT NULL,
        owner_user_id TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        runner_token_id TEXT NOT NULL REFERENCES runner_tokens(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        code TEXT NOT NULL,
        operation TEXT NOT NULL,
        severity TEXT NOT NULL,
        job_id TEXT,
        task_kind TEXT,
        occurred_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        event_json TEXT NOT NULL
      )`),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_diagnostic_token_event ON runner_diagnostic_logs(runner_token_id, event_id)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_runner_diagnostic_owner_received ON runner_diagnostic_logs(owner_user_id, received_at)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_runner_diagnostic_token_received ON runner_diagnostic_logs(runner_token_id, received_at)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_runner_diagnostic_job ON runner_diagnostic_logs(job_id)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS runner_diagnostic_upload_requests (
        id TEXT PRIMARY KEY NOT NULL,
        owner_user_id TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        runner_token_id TEXT NOT NULL REFERENCES runner_tokens(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'requested',
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )`),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_runner_diagnostic_request_token_status ON runner_diagnostic_upload_requests(runner_token_id, status, created_at)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_runner_diagnostic_request_owner_created ON runner_diagnostic_upload_requests(owner_user_id, created_at)"),
    ]);
    // Existing Sites databases were created before Runner status snapshots were added.
    // ALTER is intentionally idempotent so an already published project upgrades on first request.
    await d1.prepare("ALTER TABLE runner_tokens ADD COLUMN status_json TEXT").run().catch(() => undefined);
    await d1.prepare("ALTER TABLE runner_tokens ADD COLUMN status_checked_at INTEGER").run().catch(() => undefined);
  })();

  return schemaReady;
}
