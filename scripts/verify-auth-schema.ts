import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = readFileSync("prisma/schema.prisma", "utf8");

for (const token of [
  "username         String        @unique",
  "passwordHash     String",
  "failedLoginCount Int            @default(0)",
  "lockedUntil      DateTime?",
  "sessions         Session[]",
  "model Session",
  "tokenHash String   @unique",
  "expiresAt DateTime"
]) {
  assert.ok(schema.includes(token), `missing auth schema token: ${token}`);
}

console.log("auth schema verification passed");
