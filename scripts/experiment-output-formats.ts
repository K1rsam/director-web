/**
 * 输出格式对比实验（只读，不接管线）：
 * 同一份真实 E4 返修任务（对应 06:36 出错的场景：长文本 + 中文引号 + unit_lighting + patches），
 * 让 deepseek-v4-flash 分别按 JSON / XML / 字段前缀行 三种契约输出，各跑 3 次，
 * 统计：严格可解析率、容错后可解析率、字段完整率、命中率（越界率）、截断率、残留率。
 *
 * 用法：npx tsx --env-file=.env scripts/experiment-output-formats.ts
 */
import fs from "node:fs";
import path from "node:path";

const API_BASE = process.env.DEEPSEEK_API_BASE ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_API_MODEL ?? "deepseek-v4-flash";

async function callRaw(system: string, prompt: string): Promise<{ content: string; finishReason: string; usage: string; ms: number }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("缺少 DEEPSEEK_API_KEY（用 --env-file=.env 跑）");
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ],
    stream: false,
    max_tokens: 16_384,
    temperature: 0.3
  };
  // 与生产一致：DEEPSEEK_API_THINKING=enabled 时不传 thinking（默认开启）；reasoning_effort 可覆盖
  const thinkingMode = process.env.DEEPSEEK_API_THINKING;
  if (thinkingMode !== "enabled") body.thinking = { type: "disabled" };
  const effort = process.env.EXPERIMENT_EFFORT ?? process.env.DEEPSEEK_API_REASONING_EFFORT ?? "high";
  if (["low", "high", "max"].includes(effort)) body.reasoning_effort = effort;

  const startedAt = Date.now();
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${detail.slice(-500)}`);
  }
  const payload = (await res.json()) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  return {
    content: payload.choices?.[0]?.message?.content ?? "",
    finishReason: payload.choices?.[0]?.finish_reason ?? "",
    usage: payload.usage ? `${payload.usage.prompt_tokens ?? "?"}/${payload.usage.completion_tokens ?? "?"}` : "?/?",
    ms: Date.now() - startedAt
  };
}

// ============ 任务输入（真实数据，取自 ep1 S009-S012 / U04-U05） ============
const SHOTS = [
  { shot_id: "1-1-S009", scene_id: "1-1", duration: 3.6, unit_id: "1-1-U04",
    e1: { shot_function: "反应镜", picture: "苏远肩头忽然浮现一个Q版小人大喊，话音未落便消失；同学甲一把拍上苏远肩膀，凑近连声惊叹。", sound: "Q版惊呼，同学甲兴奋声" },
    e2: { picture: "苏远肩头亮起一点白光，光点汇聚成Q版小人浮在他肩侧，双手叉腰大喊一声后化作光点消散；他刚偏头去看，同学甲已经一把拍上他的肩膀，凑近他耳边连声惊叹，眼睛瞪得溜圆" } },
  { shot_id: "1-1-S010", scene_id: "1-1", duration: 4.9, unit_id: "1-1-U05",
    e1: { shot_function: "反应镜", picture: "同学乙从另一侧凑过来，指指台上的赵清雅又指指苏远，语气笃定地接话。", sound: "人群嘈杂声渐弱，记忆涌入的嗡鸣混响层层叠起" },
    e2: { picture: "同学乙从苏远另一侧凑过来，先抬手指指高台上的赵清雅，又点点苏远，语气笃定地接话；苏远被两名同学夹在中间，脸上的笑意还挂着，眼神带着一丝不知所措" } },
  { shot_id: "1-1-S011", scene_id: "1-1", duration: 4.2, unit_id: "1-1-U05",
    e1: { shot_function: "过渡镜", picture: "同学乙话音落下，苏远消化完信息，抬头看向台上光芒万丈的赵清雅，神情微定。", sound: "人群嘈杂，脚步移动声" },
    e2: { picture: "同学乙话音落下，苏远低头眨了眨眼消化信息，随即抬头望向高台上光芒万丈的赵清雅，下巴微微收住，神情定了下来" } },
  { shot_id: "1-1-S012", scene_id: "1-1", duration: 3.4, unit_id: "1-1-U05",
    e1: { shot_function: "信息动作镜", picture: "苏远对身旁同学点点头，笑着低声说，随后目光转向台上赵清雅，心里开始盘算。", sound: "大厅人声嘈杂，Q版小人现身的咻声音效，同学甲手掌拍上苏远肩膀的闷响" },
    e2: { picture: "苏远对身边的同学甲点点头，笑着低声说了一句，目光随即转向高台上的赵清雅，视线落在她脸上，眉梢轻轻动了一下" } }
];

const REVISION_ISSUES = [
  { coordinate: "1-1-S010.e1.sound", code: "PROMPT_LITERAL_ARTIFACT", evidence: "「e1.sound」含模板/替换残留「人群起哄，$1」", requested_effect: "清理占位符为真实内容（声音写实际音效）" },
  { coordinate: "1-1-S012.e1.sound", code: "PROMPT_LITERAL_ARTIFACT", evidence: "「e1.sound」含模板/替换残留「$1，大厅人声」", requested_effect: "清理占位符为真实内容（声音写实际音效）" }
];

const UNIT_WINDOWS = [
  { unit_id: "1-1-U04", shot_ids: ["1-1-S009"], duration: 3.6 },
  { unit_id: "1-1-U05", shot_ids: ["1-1-S010", "1-1-S011", "1-1-S012"], duration: 12.5 }
];

const COMMON_TASK = `你是 E4 摄影光影导演，执行返修轮（只修命中镜，不重拆整片）。

INPUT_JSON 给出了命中镜号的问题卡（revision_issues）与相关镜头（shots，含相邻镜仅供衔接）及单元窗口（unit_windows）。

必须遵守：
1. 只修复 revision_issues 命中的镜号（1-1-S010、1-1-S012）：按 evidence / requested_effect 定向修正你负责的格子（camera_motion / lighting 镜级），不越权改其它岗位的列。
2. unit_lighting：本轮被开「.lighting」卡的单元只有 1-1-U04 与 1-1-U05（单元级布光设定：主光/辅光/色温/摄影基调），其它单元禁止输出。
3. 每镜机位五要素齐全（景别+角度+构图+运镜+焦点），光影按"光型+变化量"写，禁止模板复制。
4. 不得输出命中镜之外的镜号；不得输出 $1、undefined、待补充 等占位符残留。
5. 只输出内容本身，不要任何解释、前后缀说明或 Markdown 代码围栏。

【INPUT】
revision_issues: ${JSON.stringify(REVISION_ISSUES)}
unit_windows: ${JSON.stringify(UNIT_WINDOWS)}
shots: ${JSON.stringify(SHOTS)}
`;

// ============ 三种输出契约 ============
const CONTRACTS: Record<string, { system: string; promptExtra: string }> = {
  json: {
    system: "你只输出一个合法 JSON 对象，严格遵守下面给出的字段与转义规则。",
    promptExtra: `【输出格式：JSON】
只返回一个合法 JSON 对象，不要代码围栏：
{
  "role": "E4",
  "base_revision": "V2_TEST",
  "unit_lighting": [
    { "unit_id": "1-1-U04", "lighting": "单元光型文本（可含中文引号，如“水晶石重新亮起”……）" },
    { "unit_id": "1-1-U05", "lighting": "单元光型文本" }
  ],
  "patches": [
    { "shot_id": "1-1-S010", "action": "set", "fields": { "camera_motion": "机位文本", "lighting": "光影变化文本" } },
    { "shot_id": "1-1-S012", "action": "set", "fields": { "camera_motion": "机位文本", "lighting": "光影变化文本" } }
  ],
  "issues": []
}
JSON 规则：字符串内的中文引号“”不用转义，但英文双引号 " 必须写成 \\"；所有字符串用英文双引号包裹；字段名用英文双引号；数组/对象用 [ ] { } 且逗号分隔；不允许尾逗号；不允许换行符直接出现在字符串里（用文字描述代替）。`
  },
  xml: {
    system: "你只输出一个 XML 文档，严格遵守下面给出的标签结构。",
    promptExtra: `【输出格式：XML】
只输出一个 XML 文档，不要代码围栏，不要 XML 声明（<?xml ...?>）：
<e4 role="E4" base_revision="V2_TEST">
  <unit_lighting unit="1-1-U04">单元光型文本（可以自由包含中文标点，不需要任何转义）</unit_lighting>
  <unit_lighting unit="1-1-U05">单元光型文本</unit_lighting>
  <patch shot="1-1-S010">
    <camera_motion>机位文本</camera_motion>
    <lighting>光影变化文本</lighting>
  </patch>
  <patch shot="1-1-S012">
    <camera_motion>机位文本</camera_motion>
    <lighting>光影变化文本</lighting>
  </patch>
</e4>
XML 规则：每个开始标签必须有对应的结束标签；标签内容就是纯文本，中文引号/冒号/逗号/换行都可以直接写，不需要转义（只有 < 和 & 需要写成 &lt; &amp;）；属性用英文双引号包裹。`
  },
  prefix: {
    system: "你只输出字段前缀行（每行一个字段），严格遵守下面定义的定位符。",
    promptExtra: `【输出格式：字段前缀行】
每行一个字段，格式为：@@定位符@@ 内容
定位符规则：单元光影用 @@unit_lighting:单元ID@@；镜级格子用 @@patch:镜号.字段名@@（字段名只能是 camera_motion 或 lighting）。
内容写在定位符后、同一行内；内容里可以自由包含中文标点，不需要任何转义；内容里不要换行。
示例：
@@unit_lighting:1-1-U04@@ 主光为水晶石冷白定向光，辅光为礼堂顶光冷灰散射，色温偏冷，本单元摄影基调为中近景为主、轻微手持呼吸
@@unit_lighting:1-1-U05@@ 主光为水晶石冷白光，两侧人脸各受半边光，辅光为礼堂顶光冷灰散射，色温偏冷，本单元摄影基调为中近景为主、轻微手持呼吸
@@patch:1-1-S010.camera_motion@@ 中近景，45度侧面，平视，苏远居中，同学乙居右前探身，轻微手持呼吸，焦点锁同学乙笃定的眼神
@@patch:1-1-S010.lighting@@ 水晶石白光映亮同学乙半张脸，同学甲侧脸没入阴影
@@patch:1-1-S012.camera_motion@@ 中近景，30度侧面，平视，苏远居左，点头后目光转向画面外高台方向，轻微手持呼吸，焦点锁苏远眉梢轻动的侧脸
@@patch:1-1-S012.lighting@@ 大厅顶光平铺，苏远侧脸被水晶石余光勾出轮廓
规则：只输出这样的行，每行一个字段；不要输出解释、标题或空行以外的任何内容。`
  }
};

// ============ 解析器（三种格式，各自严格 + 容错） ============
type Parsed = { ok: boolean; data: Record<string, unknown>; notes: string[] };
type CellTexts = { unitLighting: Map<string, string>; patches: Map<string, { camera_motion: string; lighting: string }> };

function score(content: string, parse: (raw: string) => { ok: boolean; cells: CellTexts; strict: boolean; notes: string[] }) {
  const strict = parse(content);
  const notes = [...strict.notes];
  const cells = strict.cells;
  const roleOk = true; // 三种格式都以自身根元素表达角色，见各解析器
  // 字段完整：unit_lighting 覆盖 U04/U05
  const unitCoverage = ["1-1-U04", "1-1-U05"].every((u) => cells.unitLighting.has(u) && cells.unitLighting.get(u)!.trim().length > 10);
  // patches：命中镜 S010/S012 都必须有（no_change 也算覆盖：为空标记）
  const patchCoverage = ["1-1-S010", "1-1-S012"].every((s) => cells.patches.has(s));
  // 越界：patches 出现非命中镜（S009/S011 是相邻镜，出现即越界）
  const outOfScope = [...cells.patches.keys()].filter((k) => k !== "1-1-S010" && k !== "1-1-S012");
  // 残留：$1/undefined/待补充
  const artifact = /(\$\d+|\bundefined\b|待补充)/.test(JSON.stringify([...cells.unitLighting.values(), ...[...cells.patches.values()].flatMap((p) => [p.camera_motion, p.lighting])]));
  // 空字段
  const emptyFields = [...cells.patches.entries()].filter(([, p]) => !p.camera_motion.trim() && !p.lighting.trim()).map(([k]) => k);
  return { strictOk: strict.strict && strict.ok, lenientOk: strict.ok, unitCoverage, patchCoverage, outOfScope, artifact, emptyFields, notes };
}

function parseJsonFormat(raw: string): { ok: boolean; cells: CellTexts; strict: boolean; notes: string[] } {
  const notes: string[] = [];
  let text = raw.trim();
  const fence = /^```(?:json)?\s*/.exec(text);
  if (fence) { text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""); notes.push("带代码围栏"); }
  let obj: unknown = null;
  let strict = true;
  try { obj = JSON.parse(text); }
  catch {
    strict = false;
    // 容错：取 { } 区间（parseApiJson 同款）
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return { ok: false, cells: emptyCells(), strict, notes: [...notes, "无 {} 区间"] };
    try { obj = JSON.parse(text.slice(start, end + 1)); notes.push("容错取区间解析成功"); }
    catch (e) { return { ok: false, cells: emptyCells(), strict, notes: [...notes, `容错失败: ${(e as Error).message.slice(0, 60)}`] }; }
  }
  const rec = obj as Record<string, unknown>;
  const cells = emptyCells();
  for (const item of Array.isArray(rec.unit_lighting) ? rec.unit_lighting : []) {
    const r = item as Record<string, unknown>;
    if (r && typeof r.unit_id === "string") cells.unitLighting.set(r.unit_id, String(r.lighting ?? ""));
  }
  for (const item of Array.isArray(rec.patches) ? rec.patches : []) {
    const r = item as Record<string, unknown>;
    if (!r || typeof r.shot_id !== "string") continue;
    const f = (r.fields ?? {}) as Record<string, unknown>;
    cells.patches.set(r.shot_id, { camera_motion: String(f.camera_motion ?? ""), lighting: String(f.lighting ?? "") });
  }
  return { ok: true, cells, strict, notes };
}

function parseXmlFormat(raw: string): { ok: boolean; cells: CellTexts; strict: boolean; notes: string[] } {
  const notes: string[] = [];
  const text = raw.trim();
  // 严格：根元素配对（简单栈扫描标签，忽略注释）
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:\s+[a-zA-Z_:][\w:.-]*="[^"]*")*)\s*\/?>/g;
  const stack: string[] = [];
  let strict = true;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = tagRe.exec(text))) {
    const gap = text.slice(last, m.index).trim();
    last = tagRe.lastIndex;
    if (gap && !/^[^<>]*$/.test(gap)) { strict = false; notes.push("标签间存在非法字符"); }
    const name = m[1];
    if (m[0].startsWith("</")) {
      if (stack.pop() !== name) { strict = false; notes.push(`标签不配对: </${name}>`); }
    } else if (!m[0].endsWith("/>")) {
      stack.push(name);
    }
  }
  if (stack.length) { strict = false; notes.push(`未闭合标签: ${stack.join(",")}`); }

  const cells = emptyCells();
  const ulRe = /<unit_lighting\s+unit="([^"]+)"\s*>([\s\S]*?)<\/unit_lighting>/g;
  while ((m = ulRe.exec(text))) cells.unitLighting.set(m[1], m[2].trim());
  // patch 块内字段顺序不限：分别提取 camera_motion / lighting
  const patchBlockRe = /<patch\s+shot="([^"]+)"\s*>([\s\S]*?)<\/patch>/g;
  while ((m = patchBlockRe.exec(text))) {
    const shot = m[1];
    const block = m[2];
    const camM = /<camera_motion>([\s\S]*?)<\/camera_motion>/.exec(block);
    const lightM = /<lighting>([\s\S]*?)<\/lighting>/.exec(block);
    cells.patches.set(shot, {
      camera_motion: (camM ? camM[1] : "").trim(),
      lighting: (lightM ? lightM[1] : "").trim()
    });
  }
  const ok = /<e4[\s>]/.test(text) && (cells.unitLighting.size > 0 || cells.patches.size > 0);
  if (!ok) notes.push("无 e4 根或内容为空");
  return { ok, cells, strict, notes };
}

function parsePrefixFormat(raw: string): { ok: boolean; cells: CellTexts; strict: boolean; notes: string[] } {
  const notes: string[] = [];
  const cells = emptyCells();
  let strict = true;
  let fieldCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^@@([^@]+)@@\s*(.*)$/.exec(trimmed);
    if (!m) { strict = false; notes.push(`非定位符行: ${trimmed.slice(0, 40)}`); continue; }
    fieldCount++;
    const key = m[1].trim();
    const value = m[2].trim();
    if (key.startsWith("unit_lighting:")) {
      cells.unitLighting.set(key.slice("unit_lighting:".length), value);
    } else if (key.startsWith("patch:")) {
      const [shot, field] = key.slice("patch:".length).split(".");
      if (!shot || !field) { strict = false; notes.push(`patch 定位符缺字段: ${key}`); continue; }
      const entry = cells.patches.get(shot) ?? { camera_motion: "", lighting: "" };
      if (field === "camera_motion") entry.camera_motion = value;
      else if (field === "lighting") entry.lighting = value;
      else { strict = false; notes.push(`未知字段: ${field}`); continue; }
      cells.patches.set(shot, entry);
    } else {
      strict = false;
      notes.push(`未知定位符: ${key}`);
    }
  }
  return { ok: fieldCount > 0, cells, strict, notes };
}

function emptyCells(): CellTexts {
  return { unitLighting: new Map(), patches: new Map() };
}

// ============ 主流程 ============
const PARSERS: Record<string, (raw: string) => { ok: boolean; cells: CellTexts; strict: boolean; notes: string[] }> = {
  json: parseJsonFormat,
  xml: parseXmlFormat,
  prefix: parsePrefixFormat
};

const RUNS = 3;
const results: Record<string, Array<Record<string, unknown>>> = {};
const summary: Record<string, Record<string, unknown>> = {};

void (async () => {
  for (const format of ["json", "xml", "prefix"] as const) {
    const contract = CONTRACTS[format];
    const rows: Array<Record<string, unknown>> = [];
    for (let run = 1; run <= RUNS; run++) {
      process.stdout.write(`[${format} #${run}] 调用中...\n`);
      const { content, finishReason, usage, ms } = await callRaw(contract.system, COMMON_TASK + contract.promptExtra);
      process.stdout.write(`[${format} #${run}] 返回 ${content.length} 字符, finish=${finishReason}, tokens=${usage}, ${(ms / 1000).toFixed(0)}s\n`);
      const parsed = score(content, PARSERS[format]);
      rows.push({
        run,
        chars: content.length,
        finishReason,
        usage,
        ms,
        strictOk: parsed.strictOk,
        lenientOk: parsed.lenientOk,
        unitCoverage: parsed.unitCoverage,
        patchCoverage: parsed.patchCoverage,
        outOfScope: parsed.outOfScope,
        artifact: parsed.artifact,
        emptyFields: parsed.emptyFields,
        notes: parsed.notes.slice(0, 5)
      });
      fs.writeFileSync(path.join(process.cwd(), "scripts", ".experiment-raw", `${format}-${run}.txt`), content);
    }
    results[format] = rows;
    summary[format] = {
      strictOk: rows.filter((r) => r.strictOk).length,
      lenientOk: rows.filter((r) => r.lenientOk).length,
      unitCoverage: rows.filter((r) => r.unitCoverage).length,
      patchCoverage: rows.filter((r) => r.patchCoverage).length,
      outOfScopeRuns: rows.filter((r) => (r.outOfScope as string[]).length > 0).length,
      artifactRuns: rows.filter((r) => r.artifact).length,
      truncatedRuns: rows.filter((r) => r.finishReason === "length").length,
      avgChars: Math.round(rows.reduce((s, r) => s + Number(r.chars), 0) / rows.length)
    };
  }
  fs.writeFileSync(path.join(process.cwd(), "scripts", ".experiment-results.json"), JSON.stringify({ results, summary }, null, 2));
  console.log("\n==================== 结果汇总（每格 = 3 次中通过的次数 /3） ====================");
  console.table(summary);
  console.log("\n详细结果：scripts/.experiment-results.json；原始输出：scripts/.experiment-raw/*.txt");
})();
