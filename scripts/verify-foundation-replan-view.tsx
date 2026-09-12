/** Render the real viewer with complete saved-state fixtures. No database or provider. */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { buildSourceIndex } from '@/lib/project-foundation-contracts';
import { requireProductionCatalogAuthor } from '@/lib/foundation-production-contracts';
const require = createRequire(import.meta.url);
require.extensions['.css'] = module => { module.exports = {}; };
const { FoundationViewer } = require('../app/projects/[projectId]/foundation-viewer') as typeof import('../app/projects/[projectId]/foundation-viewer');
const { FoundationAssetCatalog } = require('../app/projects/[projectId]/foundation-asset-catalog') as typeof import('../app/projects/[projectId]/foundation-asset-catalog');

function displayFixture() {
  const common = { schema: 'FOUNDATION_CANDIDATE_V1', createdAt: new Date(0).toISOString(), sourceVersion: 'source', inputVersion: 'input', batchToken: 'batch', scope: [1], mechanicalIssues: [] };
  const run = (stageCode: string) => ({ id: `${stageCode}-run`, status: 'SUCCEEDED', log: null, stageCode });
  return {
    preprocessReady: true, planningReady: true, assetsReady: true, dataReady: true, dataIssues: [], f2Recovery: null,
    reviewReady: true, ready: true, draftComplete: true, finalOutput: null, message: '资料已整理', sourceVersion: 'source', inputVersion: 'input',
    candidates: {
      f1: { ...common, id: 'f1', runId: 'F1-run', stageCode: 'F1', upstreamSnapshotIds: {}, output: { coverage: [1], overview: '主线导航', episodes: [{ number: 1, summary: '一条变化', context: '', sourceSelections: [] }], issues: [] } },
      f2: { ...common, id: 'f2', runId: 'F2-run', stageCode: 'F2', upstreamSnapshotIds: { f1: 'f1' }, output: { coverage: [1], assets: [], episodes: [{ number: 1, context: '', assetKeys: [] }], issues: [] } }
    },
    review: { ...common, id: 'q1', runId: 'Q1-run', stageCode: 'Q1', upstreamSnapshotIds: { f1: 'f1', f2: 'f2' }, output: { coverage: [1], verdict: 'READY', summary: '', issues: [] } },
    approved: null, latestRuns: { f1: run('F1'), f2: run('F2'), q1: run('Q1') }
  };
}

const base = (key: string, name: string, mode: string, extra = {}) => ({
  key, name, type: 'PROP' as const, aliases: [], description: '', sourceRefs: [], appearances: [],
  usageEpisodes: [1], variants: [], preparation: { mode, ...extra }
});
function fixture() {
  const current = displayFixture();
  const f1 = { ...current.candidates.f1!, workflow: 'PRODUCTION_FOUNDATION_V3' };
  const catalog = {
    format: 'ASSET_CATALOG_V2', coverage: [1], issues: [],
    assets: [base('ring', '唯一婚戒', 'REFERENCE'), base('page', '图鉴封面', 'DERIVE', { fromKey: 'ring', note: '复用戒指图面' }),
      base('apple', '普通苹果', 'INLINE'), base('voice', '门外报信声', 'AUDIO'), base('unknown', '未辨明信物', 'UNRESOLVED', { note: '原文无法确定是否同一件' })],
    episodes: [{ number: 1, context: '', assetKeys: ['ring', 'page', 'apple', 'voice', 'unknown'] }]
  };
  const f2 = { ...current.candidates.f2!, workflow: 'PRODUCTION_FOUNDATION_V3', output: catalog };
  const finalOutput = { f1: f1.output, f2: catalog };
  const review = { ...current.review!, workflow: 'PRODUCTION_FOUNDATION_V3', finalOutput,
    output: { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], verdict: 'REPAIR', issues: [], summary: '已整理可用部分。', notes: [],
      unresolved: [{ key: 'unknown', episodes: [1], note: '原文无法确定是否同一件' }] } };
  return { ...current, candidates: { f1, f2 }, review, finalOutput, ready: false, reviewReady: false, draftComplete: true,
    message: '资料已整理，1项待定。', sourceContext: { version: 'source-extra', background: [], complete: true, issues: [] } };
}
function render(value: unknown) {
  return renderToStaticMarkup(createElement(FoundationViewer, { state: value as Parameters<typeof FoundationViewer>[0]['state'] }));
}
const state = fixture();
const before = JSON.stringify(state);
const html = render(state);
assert.ok(html.includes('仍待处理的资料问题') && html.includes('需要你确认'), '资料缺口不冒充第二个用户问卷；人工选择仅在统一入口');
assert.ok(!html.includes('href="#presentation-contracts"'), '仅有资料缺口、确认区未渲染时不能留下死链接');
assert.ok(!html.includes('待决定的具体项'));
assert.ok(html.includes('scroll-margin-top:96px'), 'asset section anchor must clear the sticky project toolbar');
assert.ok(html.includes('id="asset-catalog-details"') && html.includes('<table'), '默认完整目录使用真实表格');
assert.ok(html.includes('普通苹果') && html.includes('门外报信声') && html.includes('未辨明信物'), '完整目录保留非制图记录');
const queueHtml = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: state.finalOutput.f2 as Parameters<typeof FoundationAssetCatalog>[0]['catalog'], initialView: 'queue', pendingKeys: ['unknown'] }));
assert.ok(queueHtml.includes('id="asset-preparation-queue"'), '真实制图队列应有独立范围');
const queue = queueHtml.split('id="asset-preparation-queue"')[1].split('</table>')[0];
assert.ok(queue.includes('唯一婚戒') && queue.includes('图鉴封面'));
assert.ok(!queue.includes('普通苹果') && !queue.includes('门外报信声') && !queue.includes('未辨明信物'), '随场/声音/待定不能成为默认图片订单');
assert.ok(html.includes('复用戒指图面') && html.includes('原文无法确定是否同一件'));
assert.ok(html.includes('待定') && !html.includes('Q1已完成最终优化'), '有未决项仍能读最终整理稿，但不能显示全部可制作');
assert.equal(JSON.stringify(state), before);

const historical = fixture();
Object.assign(historical, { finalOutput: null, ready: false, planningReady: false, assetsReady: false, reviewReady: false, draftComplete: false, inputVersion: 'new-method' });
const oldHtml = render(historical);
assert.ok(oldHtml.includes('历史整理结果') && oldHtml.includes('唯一婚戒'), '方法更新后历史完整成果仍可读');
assert.ok(oldHtml.includes('不代表当前版本已完成'));
const numbered = fixture();
Object.assign(numbered, { finalOutput: null, ready: false, approved: { id: 'approval', sourceVersion: 'source', inputVersion: 'input', f1SnapshotId: 'f1', f2SnapshotId: 'f2', q1SnapshotId: 'q1', assets: [{ key: 'ring', code: 'PROP-VERIFIED' }] } });
assert.ok(render(numbered).includes('PROP-VERIFIED'), '确切匹配历史成果的已核编号不随ready失效而消失');
Object.assign(numbered.approved!, { q1SnapshotId: 'other-review' });
assert.ok(!render(numbered).includes('PROP-VERIFIED'), '其他成果批准编号不能串用');

for (const phase of ['F2', 'Q1']) {
  const stale = fixture();
  stale.review.finalOutput.f2.assets.push(base('final-only', '仅最终稿保留对象', 'REFERENCE'));
  stale.candidates.f2.output = { ...stale.candidates.f2.output, assets: stale.candidates.f2.output.assets.filter(a => a.key !== 'final-only') };
  Object.assign(stale, { finalOutput: null, ready: false, planningReady: true, assetsReady: phase === 'Q1', reviewReady: false });
  stale.review.output.notes.push('历史制作提醒' as never);
  const rendered = render(stale);
  assert.ok(rendered.includes('仅最终稿保留对象') && rendered.includes('历史制作提醒'), `${phase}方法单独过期仍显示Q1完整历史`);
  stale.candidates.f2.id = 'new-author';
  assert.ok(!render(stale).includes('仅最终稿保留对象'), '新作者不能混用旧最终目录');
}

const withSourceIssues = fixture();
Object.assign(withSourceIssues, { sourceContext: { version: 'source-extra', background: [{ key: 'b1', text: '背景原文' }], complete: false,
  issues: [{ code: 'DUPLICATE_EPISODE', message: '两段第16集正文均已保留，待确认归属。', sectionKeys: ['u1', 'u2'] }] } });
const sourceHtml = render(withSourceIssues);
assert.ok(sourceHtml.includes('两段第16集正文均已保留') && sourceHtml.includes('背景原文'), '来源未决和保留背景需能查看，不藏在后台');
const receiver = fixture();
const receiverIndex = buildSourceIndex([0, 1, 2].map(number => ({ number, title: null, content: '待核对象与状态。' })));
const receiverCatalog = requireProductionCatalogAuthor({
  format: 'ASSET_CATALOG_V2', coverage: [0, 1, 2],
  assets: [{ name: '<b>待核人物</b>', type: 'PROP', episodes: [0, 1], preparation: { mode: 'REFERENCE' },
    variants: [{ name: '<script>争议版本</script>', episodes: [2], note: '保留原备注', preparation: { mode: 'DERIVE' } }] }],
  repairItems: [
    { id: 'scope-known', code: 'VARIANT_SCOPE', assetKey: 'receiver-parent', variantKey: 'receiver-version', episodes: [2], assetEpisodes: [0, 1], variantEpisodes: [2] },
    { id: 'scope-unknown', code: 'VARIANT_SCOPE', assetKey: 'missing-object', variantKey: '<img src=x onerror=alert(1)>', episodes: [3], assetEpisodes: [1], variantEpisodes: [3] }
  ]
}, receiverIndex, [0, 1, 2]);
Object.assign(receiver.candidates.f2, { output: receiverCatalog });
Object.assign(receiver, { finalOutput: null, review: null, ready: false, reviewReady: false, draftComplete: false, message: '目录候选已保存，待Q1处理。' });
const receiverBefore = JSON.stringify(receiver);
const receiverHtml = render(receiver);
const receiverFailures: string[] = [];
for (const [name, verify] of [
  ['候选显示程序发现的原范围矛盾且不是Q1审查结论', () => {
    assert.ok(receiverHtml.includes('待Q1核对') && receiverHtml.includes('接收时发现'));
    assert.ok(receiverHtml.includes('父原范围：第0、1集') && receiverHtml.includes('子原范围：第2集'));
    assert.ok(receiverHtml.includes('包络仅为保留待核') && receiverHtml.includes('不代表已批准或新增已核入镜'));
    assert.ok(receiverHtml.includes('不是Q1审查结论'));
  }],
  ['对象版本安全可读，伪造未定位键不进入候选或人工问卷', () => {
    assert.ok(receiverHtml.includes('对象：&lt;b&gt;待核人物&lt;/b&gt;') && receiverHtml.includes('版本：&lt;script&gt;争议版本&lt;/script&gt;'));
    assert.ok(!receiverHtml.includes('missing-object') && !receiverHtml.includes('onerror=alert(1)'));
    assert.ok(!receiverHtml.includes('<script>') && !receiverHtml.includes('<img'));
    assert.ok(!receiverHtml.includes('<form') && !receiverHtml.includes('需要你确认') && !receiverHtml.includes('href="#presentation-contracts"'));
    assert.equal(JSON.stringify(receiver), receiverBefore);
  }],
  ['未清除repair不能因ready标志展示Q1完成式标题', () => {
    const inconsistent = { ...receiver, ready: true, finalOutput: { f1: receiver.candidates.f1.output, f2: receiverCatalog } };
    const markup = render(inconsistent);
    assert.ok(markup.includes('待Q1核对'));
    assert.ok(!markup.includes('Q1已完成最终优化') && !markup.includes('Q1优化后的最终目录'));
  }]
] as const) { try { verify(); } catch { receiverFailures.push(name); } }
assert.deepEqual(receiverFailures, [], `接收待核展示缺口：${receiverFailures.join('、')}`);
console.log('PASS replan viewer: receiver original scopes, no questionnaire, pending queue, historical results and source context (rendered fixtures only)');
