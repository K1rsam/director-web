import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getD1 } from "@/db";
import { sanitizeReturnTo } from "@/lib/auth-crypto";
import {
  resolveSessionUser,
  type SessionUser,
  userHasEpisodeAccess,
  userHasProjectAccess,
} from "@/lib/repositories/auth";

export const SESSION_COOKIE_NAME = "director_session";

function loginDestination(returnTo?: string): string {
  return `/login?returnTo=${encodeURIComponent(sanitizeReturnTo(returnTo))}`;
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  return token ? resolveSessionUser(getD1(), token) : null;
}

export async function requireSessionUser(returnTo = "/"): Promise<SessionUser> {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) redirect(loginDestination(safeReturnTo));

  const user = await resolveSessionUser(getD1(), token);
  if (!user) redirect(`/auth/clear-session?returnTo=${encodeURIComponent(safeReturnTo)}`);
  return user;
}

export async function requireProjectAccess(
  projectId: string,
  returnTo = `/projects/${projectId}`,
): Promise<SessionUser> {
  const user = await requireSessionUser(returnTo);
  if (!(await userHasProjectAccess(getD1(), user.id, projectId))) notFound();
  return user;
}

export async function requireEpisodeAccess(
  projectId: string,
  episodeId: string,
  returnTo = `/projects/${projectId}/episodes/${episodeId}`,
): Promise<SessionUser> {
  const user = await requireSessionUser(returnTo);
  if (!(await userHasEpisodeAccess(getD1(), user.id, projectId, episodeId))) notFound();
  return user;
}
