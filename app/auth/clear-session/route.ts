import { type NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { sanitizeReturnTo } from "@/lib/auth-crypto";

export function GET(request: NextRequest) {
  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("returnTo", returnTo);
  const response = NextResponse.redirect(loginUrl);
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}
