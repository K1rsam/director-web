import assert from "node:assert/strict";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
  sanitizeReturnTo,
  verifyPassword
} from "@/lib/auth-crypto";

async function main() {
  assert.equal(normalizeUsername(" Tester01 "), "tester01");

  const testPassword = "private-test-password";
  const first = await hashPassword(testPassword);
  const second = await hashPassword(testPassword);
  assert.notEqual(first, second);
  assert.equal(first.includes(testPassword), false);
  assert.equal(await verifyPassword(testPassword, first), true);
  assert.equal(await verifyPassword("wrong", first), false);
  assert.equal(await verifyPassword(testPassword, "malformed"), false);

  const token = createSessionToken();
  assert.notEqual(token, createSessionToken());
  assert.equal(await hashSessionToken(token), await hashSessionToken(token));

  assert.equal(sanitizeReturnTo("/projects/a?view=units"), "/projects/a?view=units");
  for (const unsafe of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)"
  ]) {
    assert.equal(sanitizeReturnTo(unsafe), "/");
  }

  console.log("auth crypto verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
