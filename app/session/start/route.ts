import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  PUBLIC_SESSION_COOKIE_NAME,
  PUBLIC_SESSION_MAX_AGE_SECONDS,
  resolvePublicSession,
  sanitizeReturnTo,
} from "@/lib/public-session";

export async function GET(request: Request): Promise<never> {
  const requestUrl = new URL(request.url);
  const cookieStore = await cookies();
  const session = resolvePublicSession(cookieStore.get(PUBLIC_SESSION_COOKIE_NAME)?.value);

  if (session.created) {
    cookieStore.set(PUBLIC_SESSION_COOKIE_NAME, session.sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: requestUrl.protocol === "https:",
      path: "/",
      maxAge: PUBLIC_SESSION_MAX_AGE_SECONDS,
    });
  }

  redirect(sanitizeReturnTo(requestUrl.searchParams.get("returnTo")));
}
