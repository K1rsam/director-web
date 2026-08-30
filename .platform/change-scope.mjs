import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const platformDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(platformDir, "platform-boundaries.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function normalize(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

const sitePatterns = manifest.sites_only_patterns.map(globToRegExp);
const localPatterns = manifest.local_only_patterns.map(globToRegExp);
const commonOnce = new Set(manifest.common_once.map(normalize));
const dualUntilSplit = new Set(manifest.dual_until_split.map(normalize));

export function classify(input) {
  const file = normalize(input);
  if (file === ".platform" || file.startsWith(".platform/")) {
    return { category: "platform_tooling", label: "main-only", reason: "同步工具与边界清单" };
  }
  if (commonOnce.has(file)) {
    return { category: "common_once", label: "main-only", reason: "公共文件，Sites 由 main 生成" };
  }
  if (dualUntilSplit.has(file)) {
    return { category: "dual_until_split", label: "both", reason: "当前同路径存在平台差异" };
  }
  if (sitePatterns.some((pattern) => pattern.test(file))) {
    return { category: "sites_only", label: "sites-only", reason: "Sites/D1/线上 Runner 专属" };
  }
  if (localPatterns.some((pattern) => pattern.test(file))) {
    return { category: "local_only", label: "main-only", reason: "线下运行时或本地工具专属" };
  }
  return { category: "unknown", label: "unknown", reason: "尚未归类，禁止直接同步" };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function trackedFiles(repo) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: path.resolve(repo), encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

const auditRepos = [
  ["main", option("--audit-main")],
  ["sites", option("--audit-sites")],
].filter(([, repo]) => repo);

if (auditRepos.length > 0) {
  let hasUnknown = false;
  for (const [label, repo] of auditRepos) {
    const counts = new Map();
    const unknown = [];
    for (const file of trackedFiles(repo)) {
      const result = classify(file);
      counts.set(result.category, (counts.get(result.category) ?? 0) + 1);
      if (result.category === "unknown") unknown.push(file);
    }
    console.log(`${label}: ${JSON.stringify(Object.fromEntries(counts))}`);
    if (unknown.length > 0) {
      hasUnknown = true;
      console.log(`${label} 未归类文件：`);
      for (const file of unknown) console.log(`  ${file}`);
    }
  }
  if (hasUnknown) {
    console.log("结论：存在未归类文件，请先补充 platform-boundaries.json。");
    process.exitCode = 2;
  } else {
    console.log("结论：当前两套源码的已跟踪文件均已归类。");
  }
} else {
  const files = args.filter((arg) => !arg.startsWith("--"));
if (files.length === 0) {
  const stdin = await readStdin();
  files.push(...stdin.split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
}

if (files.length === 0) {
  console.error("用法：node .platform/change-scope.mjs <文件路径> [更多文件路径]");
  process.exitCode = 1;
} else {
  const results = files.map((file) => ({ file: normalize(file), ...classify(file) }));
  for (const result of results) {
    console.log(`${result.label.padEnd(10)} ${result.file}  # ${result.reason}`);
  }

  const labels = new Set(results.map((result) => result.label));
  const unknown = results.filter((result) => result.category === "unknown");
  if (unknown.length > 0) {
    console.log("结论：发现未归类文件，请先补充 platform-boundaries.json。");
    process.exitCode = 2;
  } else if (labels.has("both") || (labels.has("main-only") && labels.has("sites-only"))) {
    console.log("结论：本次需要检查 main 和 sites-online 两边。");
  } else if (labels.has("sites-only")) {
    console.log("结论：只需要修改 sites-online overlay。");
  } else {
    console.log("结论：只需要修改 main；生成 Sites 时会自动继承公共代码。");
  }
}
}
}
