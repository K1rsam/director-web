import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("original project library and creation surfaces replace the control prototype", () => {
  for (const route of ["app/login/page.tsx", "app/page.tsx", "app/projects/new/page.tsx"]) {
    assert.equal(existsSync(route), true, route);
  }

  const home = readFileSync("app/page.tsx", "utf8");
  const creation = readFileSync("app/projects/new/project-create-form.tsx", "utf8");
  const chrome = readFileSync("app/ui/app-chrome.tsx", "utf8");
  assert.match(home, /projectLibrary/);
  assert.match(home, /projectCardGrid/);
  assert.match(home, /topbarPrimary/);
  assert.match(creation, /createProjectForm/);
  assert.match(chrome, /appChrome/);
  assert.doesNotMatch(home, /创建连通测试任务|Sites 控制面/);
});
