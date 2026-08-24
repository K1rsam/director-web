const encoder = new TextEncoder();

export const PASSWORD_ITERATIONS = 600_000;
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_DIGEST_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(Buffer.from(value, "base64url"));
  } catch {
    return null;
  }
}

async function derivePasswordDigest(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations = PASSWORD_ITERATIONS
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const digest = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    },
    key,
    PASSWORD_DIGEST_BYTES * 8
  );

  return new Uint8Array(digest);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const digest = await derivePasswordDigest(password, salt);
  return [
    PASSWORD_ALGORITHM,
    PASSWORD_ITERATIONS,
    encodeBase64Url(salt),
    encodeBase64Url(digest)
  ].join("$");
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, iterationText, saltText, digestText, extra] = storedHash.split("$");
  if (extra !== undefined || algorithm !== PASSWORD_ALGORITHM) {
    return false;
  }

  const iterations = Number(iterationText);
  const salt = decodeBase64Url(saltText ?? "");
  const expectedDigest = decodeBase64Url(digestText ?? "");
  if (
    iterations !== PASSWORD_ITERATIONS ||
    salt?.length !== PASSWORD_SALT_BYTES ||
    expectedDigest?.length !== PASSWORD_DIGEST_BYTES
  ) {
    return false;
  }

  const actualDigest = await derivePasswordDigest(password, salt, iterations);
  return constantTimeEqual(actualDigest, expectedDigest);
}

export function createSessionToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return encodeBase64Url(new Uint8Array(digest));
}

export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /\\|%5c/i.test(value)) {
    return "/";
  }

  try {
    const base = new URL("https://director.local");
    const destination = new URL(value, base);
    if (destination.origin !== base.origin) {
      return "/";
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}
