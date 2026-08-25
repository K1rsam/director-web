export const PUBLIC_SESSION_COOKIE_NAME = "director_visitor";
export const PUBLIC_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolvePublicSession(value: string | null | undefined): {
  sessionId: string;
  created: boolean;
} {
  if (value && UUID_PATTERN.test(value)) {
    return { sessionId: value, created: false };
  }
  return { sessionId: crypto.randomUUID(), created: true };
}

export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }

  try {
    const base = new URL("https://director.local");
    const destination = new URL(value, base);
    if (destination.origin !== base.origin || destination.pathname === "/session/start") {
      return "/";
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}
