import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sources = [
  "lib/auth.ts",
  "app/auth-actions.ts",
  "app/auth/clear-session/route.ts",
  "app/login/page.tsx",
  "app/login/login-form.tsx",
  "app/ui/account-menu.tsx",
  "app/ui/app-chrome.tsx",
  "app/vision-studio.css"
].map((path) => readFileSync(path, "utf8"));
const combined = sources.join("\n");
const authSource = sources[0];

for (const token of [
  "账号",
  "密码",
  "useActionState",
  "loginAction",
  "role=\"alert\"",
  "director_session",
  "httpOnly: true",
  "sameSite: \"lax\"",
  "SESSION_DURATION_MS",
  "logoutAction",
  "AccountMenu",
  "mobileAccountMenu",
  "退出登录",
  ".loginShell",
  "/auth/clear-session"
]) {
  assert.ok(combined.includes(token), `missing auth UI token: ${token}`);
}

for (const insecureToken of ["x-user-role", "CURRENT_USER_EMAIL", "operator@lan.local"]) {
  assert.equal(authSource.includes(insecureToken), false, `trusted-header auth remains: ${insecureToken}`);
}

console.log("auth UI verification passed");
