/** Real confirmation UI SSR; only CSS and the uncalled action boundary are substituted. No DB or provider. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FoundationChoiceView } from "../lib/foundation-choice-store";
import { deriveProjectGuidance } from "../lib/ui-guidance";

const require = createRequire(import.meta.url);
require.extensions[".css"] = module => { module.exports = {}; };
const actionPath = require.resolve("../app/actions");
let actionCalls = 0;
require.cache[actionPath] = { id: actionPath, filename: actionPath, loaded: true, exports: {
  decidePresentationContractAction: async () => { actionCalls += 1; throw new Error("SSR must not submit decisions"); },
  skipPresentationContractAction: async () => { throw new Error("SSR must not skip decisions"); }
} } as NodeModule;
const { PresentationContracts } = require("../app/projects/[projectId]/presentation-contracts") as typeof import("../app/projects/[projectId]/presentation-contracts");

const longOption = "保留为两个独立人物，各自沿用所属段落中的姓名、形象、关系与出场范围；后续整理不得将其中任意一人的对白、动作、伤态、道具持有情况或人物关系转移给另一人。最后这段关键约束必须完整显示。";
const choice = (extra: Partial<FoundationChoiceView> = {}): FoundationChoiceView => ({
  id: "choice-safe", category: "asset_identity", question: "两处称呼是否指向同一人物？", options: [longOption, "视为同一人物，保留两处称呼作为别名。", "暂保留身份未明，不推断两者相同或不同。"],
  evidence: "第0集 L3；第2集 L9", userAnswer: null, episodes: [0, 2], sourceStages: ["F2", "Q1"],
  reason: "原文有两种合理解释，现有资料无法确定身份，需由你选择创作口径。",
  recommended: "视为同一人物，保留两处称呼作为别名。", recommendationReason: "两处关系与外观一致，合并可保持已有线索连续。",
  revision: "revision-fixture", round: 1, decidedAt: null, ...extra
});
const base = choice();
Object.freeze(base.options); Object.freeze(base.episodes); Object.freeze(base.sourceStages); Object.freeze(base);
const before = JSON.stringify(base);
const render = (pending = [base], confirmed: FoundationChoiceView[] = [], active = false) => renderToStaticMarkup(createElement(PresentationContracts, { projectId: "project-safe", pending, confirmed, active } as Parameters<typeof PresentationContracts>[0]));
const html = render();
const article = (markup: string) => markup.match(/<article\b[^>]*>[\s\S]*?<\/article>/)?.[0] ?? "";
const buttons = (markup: string) => [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], body: match[2] }));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const failures: string[] = [];
let checks = 0;
function check(name: string, verify: () => void) { checks += 1; try { verify(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); } }

check("统一必要确认入口", () => {
  assert.ok(html.includes("需要你确认") && html.includes("F1") && html.includes("F2") && html.includes("Q1"));
  for (const retired of ["P1 发现", "Q版苏远", "先定\"怎么演\"再生成分镜", "表现规范确认"]) assert.ok(!html.includes(retired));
  assert.ok(html.includes('id="presentation-contracts"'));
});
check("真实岗位元数据与第0集范围", () => {
  assert.ok(article(html).includes("资产身份"));
  assert.ok(article(html).includes("F2 · Q1") && !article(html).includes("F1 · F2 · Q1"));
  assert.ok(article(html).includes("第0、2集"));
});
for (const [category, label] of [["SOURCE_CONFLICT", "原文取舍"], ["PRODUCTION_CHOICE", "制作取舍"]]) {
  check(`${category}在待确认与历史中使用中文标签`, () => {
    const item = choice({ category });
    for (const markup of [render([item]), render([], [{ ...item, userAnswer: "已选方案", decidedAt: new Date(0) }])]) {
      assert.ok(markup.includes(label), `应显示${label}`);
      assert.ok(!markup.includes(category), `不能泄露原始枚举${category}`);
    }
  });
}
check("方案完整可见且推荐准确匹配", () => {
  assert.ok(html.includes(longOption));
  const options = buttons(html).filter(button => /name="optionIndex"/.test(button.attributes));
  assert.equal(options.length, 3);
  for (const [index, option] of options.entries()) assert.ok(option.attributes.includes(`value="${index}"`));
  assert.ok(options[1].body.includes("推荐") && !options[0].body.includes("推荐") && !options[2].body.includes("推荐"));
  assert.ok(html.includes(base.recommendationReason!));
});
check("提交原编号与版本而非全文或默认答案", () => {
  assert.ok(html.includes('name="revision"') && html.includes('value="revision-fixture"'));
  assert.ok(!html.includes('name="answer"') && !html.includes('name="suggested_default"'));
  assert.ok(!html.includes("checked=") && !html.includes("selected="));
  assert.equal(actionCalls, 0);
});
check("需要决定的理由和证据可折叠", () => {
  const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0] ?? "";
  assert.ok(details.includes(base.reason!) && details.includes(base.evidence!) && details.includes("<summary"));
});
check("自定义必须独立输入且没有跳过", () => {
  assert.match(html, /<textarea[^>]*name="customAnswer"[^>]*required=""/);
  assert.match(html, /<label[^>]*for="[^"]+"[^>]*>自定义方案<\/label>/);
  assert.ok(!html.includes('name="customAnswer" type="hidden"') && !html.includes("D. 自定义") && !html.includes("暂不处理"));
  assert.equal(buttons(html).filter(button => /name="optionIndex"/.test(button.attributes)).length, base.options.length);
});
check("旧自定义占位项不能当答案且过滤不改变原编号", () => {
  const legacy = render([choice({ options: ["A. 用户自定义", "保留为同一人物。", "保留为两个独立人物。"], recommended: "保留为两个独立人物。" })]);
  const options = buttons(legacy).filter(button => /name="optionIndex"/.test(button.attributes));
  assert.equal(options.length, 2);
  assert.ok(options[0].attributes.includes('value="1"') && options[1].attributes.includes('value="2"'));
  assert.ok(options.every(button => !button.body.includes("用户自定义")) && options[1].body.includes("推荐"));
});
check("未匹配推荐不得默认标首项", () => {
  const unmatched = render([choice({ recommended: "不存在的方案" })]);
  assert.ok(buttons(unmatched).every(button => !button.body.includes("推荐")));
});
check("运行中真实控件禁用", () => {
  const busy = render([base], [], true);
  assert.ok(busy.includes("请先等待当前运行结束"));
  assert.ok(buttons(busy).length > 0 && buttons(busy).every(button => button.attributes.includes('disabled=""')));
  assert.match(busy, /<textarea[^>]*disabled=""/);
});
check("历史缺元数据不伪造来源", () => {
  const legacy = article(render([choice({ category: "旧自定义类别", sourceStages: [], episodes: [], reason: null, recommended: null, recommendationReason: null })]));
  assert.ok(legacy.includes("旧自定义类别") && legacy.includes("全剧") && legacy.includes("来源未记录"));
  assert.ok(!legacy.includes("F1") && !legacy.includes("P1") && !legacy.includes("推荐"));
});
check("所有问题与证据由React转义", () => {
  const unsafe = render([choice({ question: "<img src=x onerror=alert(1)>", evidence: "<script>证据</script>", options: ["<b>第一项</b>", "第二项"], recommended: null })]);
  assert.ok(unsafe.includes("&lt;img") && unsafe.includes("&lt;script&gt;") && unsafe.includes("&lt;b&gt;"));
  assert.ok(!unsafe.includes("<img") && !unsafe.includes("<script>证据"));
});
check("已确认历史折叠并保留epoch零日期", () => {
  const confirmed = render([], [choice({ userAnswer: "已明确的口径", decidedAt: new Date(0) })]);
  assert.ok(confirmed.includes("已确认的决定") && confirmed.includes("已明确的口径") && confirmed.includes("1970-01-01"));
  assert.equal(buttons(confirmed).length, 0);
  assert.match(confirmed, /<details\b[^>]*>[\s\S]*已确认的决定/);
});
check("无题无历史不渲染", () => assert.equal(render([], []), ""));
check("保存与继续边界明确", () => {
  assert.ok(html.includes("只保存决定，不自动运行"));
  assert.ok(html.includes("可能需要更新 F1、F2、Q1") && html.includes("继续前请核对实际范围"));
  assert.ok(!html.includes("确认后直接接Q1"));
});
check("顶部引导聚焦人类取舍", () => {
  const guidance = deriveProjectGuidance({ pendingContracts: 2, foundationReady: true, episodes: [] });
  assert.equal(guidance.kind, "contracts");
  assert.ok(guidance.title.includes("需要你确认") && guidance.title.includes("2"));
  assert.ok(guidance.description.includes("F1") && guidance.description.includes("F2") && guidance.description.includes("Q1"));
  assert.ok(!JSON.stringify(guidance).includes("表现规范"));
});
check("页面通过连续交付loader筛选必要事项且保持鉴权先行", () => {
  const page = read("app/projects/[projectId]/page.tsx");
  assert.ok(page.includes("await getFoundationDeliveryState(projectId)"));
  assert.ok(!page.includes("prisma.presentationContract.findMany") && !page.includes("JSON.parse(c.options)"));
  assert.ok(page.indexOf("await requireSessionUser") < page.indexOf("await getProjectStudio"));
  assert.ok(page.indexOf("if (!studio) notFound()") < page.indexOf("await getFoundationDeliveryState"));
  assert.ok(page.includes("pending={delivery.requiredChoices}") && page.includes("confirmed={delivery.confirmedChoices}"));
  assert.ok(page.includes("active={delivery.busy || unknownOutcome}") && page.includes("expectedTaskId={delivery.task?.id}"));
});
check("五种确认结果提示与返回入口", () => {
  const page = read("app/projects/[projectId]/page.tsx");
  for (const code of ["decision-changed", "decision-invalid", "decision-running", "decision-required", "decision-saved"]) assert.ok(page.includes(`"${code}"`), code);
  assert.ok(page.includes('href="#presentation-contracts"') && page.includes('role="status"'));
  for (const code of ["state-changed", "call-unknown", "worker-unknown", "worker-unchanged"]) assert.ok(page.includes(`"${code}"`), `旧安全提示不能丢：${code}`);
});
check("无效输入不误报资料版本变化", () => {
  const page = read("app/projects/[projectId]/page.tsx");
  assert.match(page, /foundationNotice === "decision-invalid" \? "请选择有效方案，或填写具体的自定义决定；本次尚未保存。"/);
  assert.match(page, /foundationNotice === "decision-changed" \? "问题或资料已更新，本次未保存；请查看当前选项后重新选择。"/);
});
check("局部样式保障键盘和窄屏文本", () => {
  const css = read("app/projects/[projectId]/presentation-contracts.module.css");
  assert.ok(css.includes(":focus-visible") && css.includes("overflow-wrap: anywhere") && css.includes("@media"));
  assert.ok(css.includes("white-space: normal") && css.includes("min-width: 0"));
});
check("输入不变且SSR不提交", () => { assert.equal(JSON.stringify(base), before); assert.equal(actionCalls, 0); });

for (const failure of failures) console.error(`FAIL ${failure}`);
assert.equal(failures.length, 0, `${failures.length}/${checks} confirmation UI checks failed`);
console.log(`PASS ${checks} confirmation UI checks: real SSR, safe forms, source metadata, version fields and page wiring (not browser verification)`);
