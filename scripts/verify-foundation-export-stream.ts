/** Offline synthetic export checks: no Prisma imports, database, model or network calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { types } from "node:util";
import ts from "typescript";

type ExportApi = {
  foundationExportFilename: (projectId: string) => string;
  serializeFoundationExport: (value: unknown, keys?: Array<string | undefined>) => string | undefined;
  foundationExportChunks?: (value: unknown, keys?: Array<string | undefined>) => Generator<string>;
  foundationExportStream?: (value: unknown, keys?: Array<string | undefined>) => ReadableStream<Uint8Array>;
};
const source = readFileSync("lib/foundation-export.ts", "utf8");
const api = {} as ExportApi;
new Function("exports", "types", ts.transpileModule(source.slice(source.indexOf("export function foundationExportFilename")), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText)(api, types);
// Exercise the existing one-string path before the chunk API exists, so RED identifies the actual defect.
function chunks(value: unknown, keys: Array<string | undefined> = []): Iterable<string> {
  if (api.foundationExportChunks) return api.foundationExportChunks(value, keys);
  const text = api.serializeFoundationExport(value, keys);
  return text === undefined ? [] : [text];
}
function stream(value: unknown, keys: Array<string | undefined> = []) {
  assert.ok(api.foundationExportStream, "export needs a pull-based byte stream");
  return api.foundationExportStream(value, keys);
}
function fixture() {
  const shared = { text: "known-secret / sk-fiction / cache / input", nothing: null };
  return {
    "10": "ten", "2": "two", "known-secret": "property names stay intact",
    date: new Date("2026-10-21T01:02:03.000Z"), invalidDate: new Date(NaN),
    custom: { toJSON(key: string) { return { key, response: "known-secret" }; } },
    missing: undefined, fn: () => 1, symbol: Symbol("ignored"),
    sparse: [, undefined, () => 1, Symbol("ignored"), NaN, Infinity, -Infinity, -0],
    strings: "中文😀\r\n\t\"\\\u0000\ud800\udc00\ud800",
    input: "input cache sk-fiction", cache: "cache input", shared: [shared, shared],
    boxed: [new Number(3), new Boolean(false), new String("known-secret"), Object(Symbol("symbol"))],
    empty: [{}, []]
  };
}

test("chunk JSON exactly matches the existing two-space serializer and exact-key redaction", () => {
  const keys = [undefined, "", "known-secret"];
  const expected = api.serializeFoundationExport(fixture(), keys)!;
  const actual = Array.from(chunks(fixture(), keys)).join("");
  assert.equal(actual, expected);
  const parsed = JSON.parse(actual);
  assert.equal(parsed["known-secret"], "property names stay intact");
  assert.equal(parsed.shared[0].text, "[REDACTED_API_KEY] / sk-fiction / cache / input");
  assert.equal(parsed.input, "input cache sk-fiction");
  assert.equal(parsed.cache, "cache input");
  for (const value of [null, true, -0, NaN, "😀\r\n", undefined, () => 1, Symbol("root")]) {
    assert.equal(Array.from(chunks(value)).join(""), api.serializeFoundationExport(value) ?? "");
  }
});

test("ordinary objects do not invoke Symbol.toStringTag or unbox solely by prototype", () => {
  const value = [
    { text: "valid JSON", get [Symbol.toStringTag]() { throw new Error("native JSON never reads this"); } },
    Object.create(Number.prototype), Object.create(String.prototype), Object.create(Boolean.prototype)
  ];
  assert.equal(Array.from(chunks(value)).join(""), api.serializeFoundationExport(value));
});

test("large logical trees serialize scalars only, in bounded aggregated Unicode-safe chunks", () => {
  const shared = { log: "x".repeat(1024) + "😀\r\n", input: "cache remains" };
  const rows = 25_000, value = Array(rows).fill(shared);
  const row = api.serializeFoundationExport(shared)!.split("\n").map(line => `  ${line}`).join("\n");
  const expectedChars = 4 + rows * row.length + (rows - 1) * 2;
  const expectedBytes = 4 + rows * Buffer.byteLength(row) + (rows - 1) * 2;
  const original = JSON.stringify;
  let chars = 0, bytes = 0, count = 0;
  try {
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      assert.ok(args[0] === null || typeof args[0] !== "object", "must not JSON.stringify the root or a subtree");
      return original(...args);
    }) as typeof JSON.stringify;
    for (const chunk of chunks(value)) {
      assert.ok(chunk.length <= 65_537, "chunk must stay bounded");
      assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      chars += chunk.length; bytes += Buffer.byteLength(chunk); count++;
    }
  } finally { JSON.stringify = original; }
  assert.equal(chars, expectedChars); assert.equal(bytes, expectedBytes);
  assert.ok(count > 100 && count < rows / 2, "aggregate small JSON tokens without retaining the complete output");
});

test("UTF-8 stream preserves emoji and escapes across chunk boundaries", async () => {
  const value = { text: "😀".repeat(70_000) + "\r\n\ud800", custom: { toJSON() { return "known-secret"; } } };
  const expected = api.serializeFoundationExport(value, ["known-secret"]);
  assert.equal(await new Response(stream(value, ["known-secret"])).text(), expected);
});

test("shared references are legal while cycles and BigInt fail explicitly", async () => {
  const shared = { a: 1 };
  assert.equal(Array.from(chunks([shared, shared])).join(""), api.serializeFoundationExport([shared, shared]));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [cyclic, { nested: [1n] }, Object(1n)]) {
    assert.throws(() => Array.from(chunks(value)), TypeError);
    await assert.rejects(new Response(stream(value)).arrayBuffer(), TypeError);
  }
});

test("pull-based streams respect backpressure and stop traversing on cancellation", async () => {
  let visits = 0;
  const row = { toJSON() { visits++; return { log: "x".repeat(2048) }; } };
  const reader = stream(Array(1000).fill(row)).getReader();
  await setImmediate(); assert.equal(visits, 0, "do not serialize before the consumer pulls");
  const first = await reader.read(); assert.ok(!first.done && first.value.byteLength > 32_000);
  assert.ok(visits > 0 && visits < 1000);
  const pausedAt = visits;
  await setImmediate(); assert.equal(visits, pausedAt, "a stalled reader must stop traversal");
  await reader.cancel("download cancelled"); await setImmediate();
  assert.equal(visits, pausedAt); assert.equal((await reader.read()).done, true);
});

test("stream errors propagate after partial output rather than silently truncating", async () => {
  const error = new Error("synthetic getter failure");
  const reader = stream(["x".repeat(100_000), { get later() { throw error; } }]).getReader();
  assert.equal((await reader.read()).done, false);
  await assert.rejects(async () => { while (!(await reader.read()).done) { /* drain */ } }, e => e === error);
});

test("route preserves authentication, access order and private download headers while streaming lazily", async () => {
  const routeSource = ts.createSourceFile("route.ts", readFileSync("app/projects/[projectId]/foundation/export/route.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const code = ts.transpileModule(routeSource.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(routeSource)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  let loggedIn = false, deny = false, authorized = false, builds = 0, visits = 0;
  let exported: unknown = fixture();
  const forbidden = new Error("forbidden"), route = {} as { GET: (request: Request, context: { params: Promise<{ projectId: string }> }) => Promise<Response> };
  new Function("exports", "getCurrentUser", "requireProjectAccess", "buildFoundationExport", "foundationExportFilename", "serializeFoundationExport", "foundationExportStream", "process", code)(
    route, async () => loggedIn ? { id: "synthetic-user" } : null,
    async (id: string) => { assert.equal(id, "p /示例"); if (deny) throw forbidden; authorized = true; },
    async () => { assert.ok(authorized); builds++; return exported; },
    api.foundationExportFilename, api.serializeFoundationExport, api.foundationExportStream, { env: { DEEPSEEK_API_KEY: "known-secret" } }
  );
  const request = () => route.GET(new Request("http://offline.invalid/export"), { params: Promise.resolve({ projectId: "p /示例" }) });
  assert.equal((await request()).status, 401); assert.equal(builds, 0);
  loggedIn = true; deny = true; await assert.rejects(request(), e => e === forbidden); assert.equal(builds, 0);
  deny = false;
  const response = await request();
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="foundation-p%20%2F%E7%A4%BA%E4%BE%8B.json"');
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await response.text(), api.serializeFoundationExport(fixture(), ["known-secret"]));
  exported = Array(1000).fill({ toJSON() { visits++; return { text: "x".repeat(2048) }; } });
  const lazyResponse = await request();
  assert.equal(visits, 0, "route must return a stream before walking the full export");
  const reader = lazyResponse.body!.getReader(); await reader.read();
  assert.ok(visits > 0 && visits < 1000); await reader.cancel();
});
