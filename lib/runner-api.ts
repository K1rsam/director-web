import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";

import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { getDb } from "@/db";
import { projectRoles, runnerJobs, runnerTokens, users } from "@/db/schema";
import { createRunnerToken, hashRunnerToken, parseBearerToken } from "@/lib/runner-auth";
import {
  canClaimRunnerJob,
  runnerIdentityFromRow,
  type RunnerIdentity,
} from "@/lib/runner-ownership";
import { applyRunnerResult, markPipelineRunsFailed } from "@/lib/runner-pipeline";
import type { RunnerStatusSnapshot } from "@/lib/runner-status";

const LEASE_MS = 5 * 60_000;

export type { RunnerIdentity } from "@/lib/runner-ownership";

export async function authenticateRunner(request: Request): Promise<RunnerIdentity | null> {
  const token = parseBearerToken(request.headers.get("authorization"));
  if (!token) return null;

  await ensureControlPlaneSchema();
  const db = getDb();
  const tokenHash = await hashRunnerToken(token);
  const [record] = await db
    .select({ tokenId: runnerTokens.id, ownerUserId: runnerTokens.ownerUserId, userId: users.id })
    .from(runnerTokens)
    .innerJoin(users, eq(users.id, runnerTokens.ownerUserId))
    .where(and(eq(runnerTokens.tokenHash, tokenHash), isNull(runnerTokens.revokedAt)))
    .limit(1);

  const identity = runnerIdentityFromRow(record);
  if (!identity) return null;
  await db.update(runnerTokens).set({ lastSeenAt: new Date() }).where(eq(runnerTokens.id, identity.tokenId));
  return identity;
}

export async function reportRunnerStatus(identity: RunnerIdentity, status: RunnerStatusSnapshot): Promise<void> {
  await getDb()
    .update(runnerTokens)
    .set({
      statusJson: JSON.stringify(status),
      statusCheckedAt: new Date(status.checkedAt),
      lastSeenAt: new Date(),
    })
    .where(eq(runnerTokens.id, identity.tokenId));
}

export async function claimNextJob(identity: RunnerIdentity, deviceId: string) {
  const db = getDb();
  const now = new Date();

  await db
    .update(runnerJobs)
    .set({
      status: "queued",
      leasedBy: null,
      leaseTokenHash: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(runnerJobs.ownerUserId, identity.ownerUserId),
        eq(runnerJobs.status, "running"),
        lt(runnerJobs.leaseExpiresAt, now),
      ),
    );

  const [candidate] = await db
    .select({
      id: runnerJobs.id,
      ownerUserId: runnerJobs.ownerUserId,
      projectRoleUserId: projectRoles.userId,
    })
    .from(runnerJobs)
    .innerJoin(
      projectRoles,
      and(
        eq(projectRoles.projectId, runnerJobs.projectId),
        eq(projectRoles.userId, identity.ownerUserId),
      ),
    )
    .where(and(eq(runnerJobs.ownerUserId, identity.ownerUserId), eq(runnerJobs.status, "queued")))
    .orderBy(asc(runnerJobs.createdAt))
    .limit(1);
  if (!candidate || !canClaimRunnerJob(identity, candidate)) return null;

  const leaseToken = createRunnerToken();
  const leaseTokenHash = await hashRunnerToken(leaseToken);
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  const [job] = await db
    .update(runnerJobs)
    .set({
      status: "running",
      attempt: sql`${runnerJobs.attempt} + 1`,
      leasedBy: deviceId,
      leaseTokenHash,
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(runnerJobs.id, candidate.id),
        eq(runnerJobs.ownerUserId, identity.ownerUserId),
        eq(runnerJobs.status, "queued"),
      ),
    )
    .returning({
      id: runnerJobs.id,
      projectId: runnerJobs.projectId,
      kind: runnerJobs.kind,
      payload: runnerJobs.payload,
      attempt: runnerJobs.attempt,
    });
  if (!job) return null;

  return {
    ...job,
    payload: safeJson(job.payload),
    leaseToken,
    leaseExpiresAt: leaseExpiresAt.getTime(),
  };
}

export async function heartbeatJob(
  identity: RunnerIdentity,
  jobId: string,
  leaseToken: string,
): Promise<number | null> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  const leaseTokenHash = await hashRunnerToken(leaseToken);
  const [job] = await getDb()
    .update(runnerJobs)
    .set({ leaseExpiresAt, updatedAt: now })
    .where(
      and(
        eq(runnerJobs.id, jobId),
        eq(runnerJobs.ownerUserId, identity.ownerUserId),
        eq(runnerJobs.status, "running"),
        eq(runnerJobs.leaseTokenHash, leaseTokenHash),
      ),
    )
    .returning({ id: runnerJobs.id });
  return job ? leaseExpiresAt.getTime() : null;
}

export async function reportJob(
  identity: RunnerIdentity,
  input: {
    jobId: string;
    leaseToken: string;
    status: "succeeded" | "failed";
    result: string | null;
    error: string | null;
  },
): Promise<boolean> {
  const db = getDb();
  const leaseTokenHash = await hashRunnerToken(input.leaseToken);
  const [claimed] = await db
    .select({
      id: runnerJobs.id,
      projectId: runnerJobs.projectId,
      kind: runnerJobs.kind,
      payload: runnerJobs.payload,
      attempt: runnerJobs.attempt,
    })
    .from(runnerJobs)
    .where(
      and(
        eq(runnerJobs.id, input.jobId),
        eq(runnerJobs.ownerUserId, identity.ownerUserId),
        eq(runnerJobs.status, "running"),
        eq(runnerJobs.leaseTokenHash, leaseTokenHash),
      ),
    )
    .limit(1);
  if (!claimed) {
    const [existing] = await db
      .select({ status: runnerJobs.status })
      .from(runnerJobs)
      .where(and(eq(runnerJobs.id, input.jobId), eq(runnerJobs.ownerUserId, identity.ownerUserId)))
      .limit(1);
    return existing?.status === input.status;
  }

  const payload = safeJsonRecord(claimed.payload);
  const job = {
    id: claimed.id,
    projectId: claimed.projectId,
    kind: claimed.kind as "project_foundation" | "episode_pipeline" | "smoke" | "codex_prompt",
    payload,
    attempt: Number(claimed.attempt),
  };
  try {
    if ((job.kind === "project_foundation" || job.kind === "episode_pipeline") && input.status === "succeeded" && !input.result) {
      throw new Error("流水线任务没有返回结果，不能标记为完成。");
    }
    const result = input.result === null ? null : parseResultJson(input.result);
    await applyRunnerResult(job, result, input.status, input.error);
  } catch (error) {
    const message = `线上结果回写失败：${error instanceof Error ? error.message : String(error)}`;
    await markPipelineRunsFailed(job, message).catch(() => undefined);
    await db
      .update(runnerJobs)
      .set({
        status: "failed",
        result: input.result,
        error: message,
        leasedBy: null,
        leaseTokenHash: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(runnerJobs.id, claimed.id));
    throw new Error(message);
  }
  const [updated] = await db
    .update(runnerJobs)
    .set({
      status: input.status,
      result: input.result,
      error: input.error,
      leasedBy: null,
      leaseTokenHash: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runnerJobs.id, input.jobId),
        eq(runnerJobs.ownerUserId, identity.ownerUserId),
        eq(runnerJobs.status, "running"),
        eq(runnerJobs.leaseTokenHash, leaseTokenHash),
      ),
    )
    .returning({ id: runnerJobs.id });
  if (updated) return true;
  return false;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function safeJsonRecord(value: string): Record<string, unknown> {
  const parsed = safeJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseResultJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Runner 返回的结果不是合法 JSON。");
  }
}
