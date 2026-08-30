const encoder = new TextEncoder();

export function parseBearerToken(value: string | null): string | null {
  const match = value?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

export async function hashRunnerToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createRunnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `dr_${encoded}`;
}
