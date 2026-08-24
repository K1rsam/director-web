import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const prompt = await new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
});

if (!outputPath) throw new Error("missing output path");
const schemaIndex = args.indexOf("--output-schema");
if (schemaIndex >= 0) await readFile(args[schemaIndex + 1], "utf8");

process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fake-session-001" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "fake.args", args })}\n`);
await writeFile(outputPath, JSON.stringify({ ok: true, promptReceived: prompt.includes("测试输入") }), "utf8");
