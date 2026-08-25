import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  PUBLIC_SESSION_COOKIE_NAME,
  resolvePublicSession,
  sanitizeReturnTo,
} from "@/lib/public-session";

export type SiteUser = {
  userId: string;
  displayName: string;
};

export async function requireSiteUser(returnTo: string): Promise<SiteUser> {
  const cookieStore = await cookies();
  const session = resolvePublicSession(cookieStore.get(PUBLIC_SESSION_COOKIE_NAME)?.value);
  if (session.created) {
    redirect(`/session/start?returnTo=${encodeURIComponent(sanitizeReturnTo(returnTo))}`);
  }

  return {
    userId: session.sessionId,
    displayName: `访客设备 ${session.sessionId.slice(0, 6)}`,
  };
}
