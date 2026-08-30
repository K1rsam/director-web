export type RunnerIdentity = { tokenId: string; ownerUserId: string };

export function runnerIdentityFromRow(row: {
  tokenId: string;
  ownerUserId: string;
  userId: string | null;
} | null | undefined): RunnerIdentity | null {
  if (!row?.tokenId || !row.userId || row.ownerUserId !== row.userId) return null;
  return { tokenId: row.tokenId, ownerUserId: row.userId };
}

export function canClaimRunnerJob(
  identity: RunnerIdentity,
  job: { ownerUserId: string; projectRoleUserId: string | null },
): boolean {
  return job.ownerUserId === identity.ownerUserId && job.projectRoleUserId === identity.ownerUserId;
}
