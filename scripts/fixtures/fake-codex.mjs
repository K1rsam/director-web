import { appendFile, readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const fixtureOption = (name) => args.find((arg) => arg.startsWith(`--fixture-${name}=`))?.split("=").slice(1).join("=");
const callsPath = fixtureOption("calls");
if (callsPath) await appendFile(callsPath, `${JSON.stringify(args)}\n`, "utf8");
if (args[args.indexOf("mcp") + 1] === "list") {
  const mode = fixtureOption("mcp");
  if (mode === "timeout") await new Promise((resolve) => setTimeout(resolve, 10_000));
  if (mode === "exit") {
    process.stderr.write("fixture-secret-inventory-token");
    process.exit(2);
  }
  const inventory = mode === "bad-json" ? "fixture-secret-inventory-token is not JSON"
    : mode === "bad-shape" ? JSON.stringify({ servers: [{ name: "unexpected" }] })
      : mode === "bad-entry" ? JSON.stringify([{ enabled: true, env: { TOKEN: "fixture-secret-inventory-token" } }])
        : mode === "large" ? "fixture-secret-inventory-token".repeat(20_000)
          : JSON.stringify([
              { name: "node_repl", enabled: true, transport: { type: "stdio", command: "node", env: { TOKEN: "fixture-secret-inventory-token" } } },
              { name: "already_off", enabled: false },
              { name: mode === "unsafe-name" ? "quoted.\"server\\name" : "custom-server_2", url: "https://fixture.invalid/?token=fixture-secret-inventory-token" },
            ]);
  process.stdout.write(inventory);
  process.exit(0);
}
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
