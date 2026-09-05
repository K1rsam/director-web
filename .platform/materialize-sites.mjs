import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classify } from "./change-scope.mjs";

const args = process.argv.slice(2);
function argument(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

const mainDir = path.resolve(argument("--main") ?? "");
const overlayDir = path.resolve(argument("--overlay") ?? "");
const targetDir = path.resolve(argument("--target") ?? "");
const mainRef = argument("--main-ref", "HEAD");
const overlayRef = argument("--overlay-ref", "HEAD");
const manifestPath = path.join(mainDir, ".platform", "platform-boundaries.json");

if (!mainDir || !overlayDir || !targetDir || !fsSync.existsSync(manifestPath)) {
  console.error("用法：node .platform/materialize-sites.mjs --main <main工作树> --overlay <overlay工作树> --target <新目录>");
  process.exit(1);
}

if (fsSync.existsSync(targetDir)) {
  console.error(`目标目录已存在，为避免覆盖用户文件而停止：${targetDir}`);
  process.exit(1);
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const baseRef = argument("--base", manifest.overlayBase);
if (!baseRef || baseRef === "TO_BE_SET_AFTER_MIGRATION") {
  console.error("platform-boundaries.json 尚未写入 overlayBase；迁移分支后再运行此工具。");
  process.exit(1);
}
if (!/^[0-9a-f]{7,40}$/i.test(baseRef)) {
  console.error(`overlayBase 必须是 Git commit SHA：${baseRef}`);
  process.exit(1);
}

function gitBuffer(cwd, gitArgs) {
  return execFileSync("git", gitArgs, { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "inherit"] });
}

function nulSeparated(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function trackedFiles(cwd) {
  return nulSeparated(gitBuffer(cwd, ["ls-tree", "-r", "--name-only", "-z", mainRef]));
}

function overlayChanges(cwd) {
  const tokens = nulSeparated(gitBuffer(cwd, ["diff", "--name-status", "-z", "--no-renames", baseRef, overlayRef]));
  const changes = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const file = tokens[index + 1];
    if (!status || !file) continue;
    changes.push({ status: status[0], file: file.replaceAll("\\", "/") });
  }
  return changes;
}

function blobAt(cwd, ref, file) {
  try {
    return execFileSync("git", ["rev-parse", `${ref}:${file}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function sameBlob(file) {
  const mainBlob = blobAt(mainDir, mainRef, file);
  const overlayBlob = blobAt(overlayDir, overlayRef, file);
  return Boolean(mainBlob && overlayBlob && mainBlob === overlayBlob);
}

async function copyBlob(sourceRoot, sourceRef, targetRoot, file) {
  const target = path.join(targetRoot, ...file.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const content = gitBuffer(sourceRoot, ["show", `${sourceRef}:${file}`]);
  await fs.writeFile(target, content);
}

async function removeTargetFile(file) {
  const target = path.join(targetDir, ...file.split("/"));
  await fs.rm(target, { force: true });
}

await fs.mkdir(targetDir, { recursive: true });

let mainCopied = 0;
for (const file of trackedFiles(mainDir)) {
  const classification = classify(file);
  if (classification.category === "unknown") {
    throw new Error(`main 中存在未归类文件：${file}`);
  }
  if (classification.category === "local_only" || classification.category === "sites_only" || classification.category === "platform_tooling") continue;
  await copyBlob(mainDir, mainRef, targetDir, file);
  mainCopied += 1;
}

let overlayCopied = 0;
let overlayRemoved = 0;
for (const change of overlayChanges(overlayDir)) {
  const classification = classify(change.file);
  if (classification.category === "unknown") {
    throw new Error(`sites-online overlay 中存在未归类文件：${change.file}`);
  }
  if (classification.category === "local_only" || classification.category === "common_once" || classification.category === "platform_tooling") {
    if (classification.category === "platform_tooling") continue;
    // overlay rebase 会把 main 新增/修改的公共文件带进自身历史；只要两边
    // 的 Git blob 完全相同，它仍然由 main 负责，不能被误当作 overlay 代码。
    if ((classification.category === "common_once" || classification.category === "local_only") && change.status !== "D" && sameBlob(change.file)) continue;
    if (change.status !== "D") {
      throw new Error(`overlay 不应拥有 ${classification.category} 文件：${change.file}`);
    }
    continue;
  }
  if (classification.category === "dual_until_split" || classification.category === "sites_only") {
    if (change.status === "D") {
      await removeTargetFile(change.file);
      overlayRemoved += 1;
    } else {
      await copyBlob(overlayDir, overlayRef, targetDir, change.file);
      overlayCopied += 1;
    }
    continue;
  }
  if (classification.category === "local_only") continue;
}

const hostingPath = path.join(targetDir, ".openai", "hosting.json");
if (!fsSync.existsSync(hostingPath)) {
  throw new Error("生成结果缺少 .openai/hosting.json，无法作为 Sites 源码使用。");
}

console.log(`Sites 源码已生成：${targetDir}`);
console.log(`main 公共文件：${mainCopied}；overlay 覆盖/新增：${overlayCopied}；overlay 删除：${overlayRemoved}`);
