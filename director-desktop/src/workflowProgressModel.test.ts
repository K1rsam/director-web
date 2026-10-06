import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspacePoller, executionSummary, hasActiveWorkspaceTasks, selectWorkflowProgress, storyboardCompletion, storyboardNodeTitle, workflowNodeResolution } from './workflowProgressModel.ts';
import type { Workspace } from './types.ts';

const stamp = Date.parse('2026-10-05T23:00:00Z');
const episodeId = 'episode:source:508';
const node = (stage: string, status: string, batch = '') => ({ id: `${stage}:${episodeId}${batch ? ':batch:package:awakening-' + batch : ':'}`, stage, status, input: { episodeId }, execution: status === 'running' ? { elapsedSeconds: 135, outputQuietSeconds: 125, processAlive: true, phase: 'executing', observedAt: new Date(stamp).toISOString() } : null });
function fixture(fresh = true): Workspace {
  const nodes = fresh ? [node('storyboardPlan', 'accepted'), node('storyboardCreate', 'accepted', 'B01'), node('storyboardCreate', 'running', 'B02')] : [node('storyboardPlan', 'running')];
  return { project: { id: 'p', title: '离线进度测试' }, source: { episodes: [{ id: episodeId, number: 1, title: '第一集' }] }, assets: [], media: [], units: [], settings: {}, providers: [], rules: [], jobs: [{ id: 'current', kind: 'workflow', entityId: 'storyboard.run', provider: 'local', status: 'running', createdAt: '2026-10-05T22:49:00Z' }], workflowProgress: [{ workflowId: 'current', stage: 'storyboard.run', status: 'running', completedSteps: 0, nodes }] };
}
function harness(initial: Workspace, reader: (id: string) => Promise<Workspace> = async () => fixture()) {
  let current: Workspace | null = initial, hidden = true, busy = false, revision = 0, alive = true, reads = 0, applied = 0, failures = 0;
  const poll = createWorkspacePoller({
    current: () => current, hidden: () => hidden, busy: () => busy, revision: () => revision, alive: () => alive, now: () => stamp + 5000,
    read: async id => { reads++; assert.equal(id, 'p'); return reader(id); },
    apply: (next, checkedAt) => { applied++; current = { ...next, readState: { checkedAt } }; },
    fail: (error, id, failedAt) => { failures++; if (current?.project.id === id) current = { ...current, readState: { ...current.readState, failedAt, error: String(error) } }; },
  });
  return { poll, get current() { return current; }, get reads() { return reads; }, get applied() { return applied; }, get failures() { return failures; }, setCurrent(value: Workspace | null) { current = value; }, setHidden(value: boolean) { hidden = value; }, setBusy(value: boolean) { busy = value; }, changeRevision() { revision++; }, close() { alive = false; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('后台活跃工作流继续只读刷新，旧Plan切换为真实已完成批次与当前B02', async () => {
  const h = harness(fixture(false));
  await h.poll();
  assert.equal(h.reads, 1); assert.equal(h.applied, 1);
  const selected = selectWorkflowProgress(h.current!, 'storyboard');
  assert.equal(selected.completed, 2, 'accepted nodes override an inconsistent zero summary');
  assert.equal(storyboardCompletion(selected.nodes), '1 批情绪规划 · 1 批单元主创');
  const current = selected.nodes.find(item => item.status === 'running')!;
  assert.equal(storyboardNodeTitle(current, h.current!), '单元主创 · 第一集 · 批次 B02');
  assert.match(executionSummary(current, stamp + 5000), /已用时 2 分 20 秒/);
  assert.match(executionSummary(current, stamp + 5000), /执行监控持续跟踪/);
});
test('没有活跃任务才暂停后台轮询，回到前台强制立即读取', async () => {
  const idle = fixture(); idle.jobs = []; idle.workflowProgress = [];
  const h = harness(idle); await h.poll(); assert.equal(h.reads, 0);
  await h.poll(true); assert.equal(h.reads, 1);
});
test('后台活跃媒体任务也更新，未知提交不能被当成待执行任务', () => {
  const workspace = fixture(); workspace.workflowProgress = []; workspace.jobs = [{ id: 'video', kind: 'video', provider: 'dreamina', status: 'processing' }];
  assert.equal(hasActiveWorkspaceTasks(workspace), true);
  workspace.jobs[0].submissionUnknown = true; assert.equal(hasActiveWorkspaceTasks(workspace), false);
});
test('读取失败明确保留上次状态，成功后清除过期警告而不改任务', async () => {
  let fail = true;
  const h = harness(fixture(), async () => { if (fail) throw new Error('offline database read failed'); return fixture(); });
  const before = JSON.stringify(h.current!.workflowProgress);
  await h.poll(); assert.equal(h.failures, 1); assert.match(h.current!.readState!.error!, /read failed/);
  assert.equal(JSON.stringify(h.current!.workflowProgress), before);
  const current = selectWorkflowProgress(h.current!, 'storyboard').nodes[2];
  assert.match(executionSummary(current, stamp + 5000, true), /最后记录用时/);
  assert.doesNotMatch(executionSummary(current, stamp + 5000, true), /等待 CLI/);
  fail = false; await h.poll(); assert.equal(h.current!.readState!.error, undefined); assert.equal(h.applied, 1);
});
test('同一只读请求未返回时不会再启动另一轮', async () => {
  const pending = deferred<Workspace>(), h = harness(fixture(), () => pending.promise);
  const first = h.poll(); await h.poll(); assert.equal(h.reads, 1);
  pending.resolve(fixture()); await first; assert.equal(h.applied, 1);
});
test('未返回的本地读取有超时提示，仍只持有原读请求并在完成后恢复', async () => {
  const pending = deferred<Workspace>(), warned = deferred<void>();
  let reads = 0, failed = '', applied = 0;
  const poll = createWorkspacePoller({ current: () => fixture(), busy: () => false, hidden: () => true, revision: () => 0, alive: () => true, readTimeoutMs: 20,
    read: async () => { reads++; return pending.promise; }, apply: () => { applied++; }, fail: error => { failed = String(error); warned.resolve(); } });
  const first = poll(); await warned.promise;
  assert.match(failed, /超过期限/); await poll(); assert.equal(reads, 1); assert.equal(applied, 0);
  pending.resolve(fixture()); await first; assert.equal(applied, 1);
});
test('写操作或项目切换期间旧轮询返回不能覆盖新结果', async () => {
  for (const changeProject of [false, true]) {
    const pending = deferred<Workspace>(), h = harness(fixture(), () => pending.promise);
    const first = h.poll();
    if (changeProject) h.setCurrent({ ...fixture(), project: { id: 'other', title: '另一项目' } }); else h.changeRevision();
    pending.resolve(fixture(false)); await first; assert.equal(h.applied, 0); assert.equal(h.failures, 0);
  }
});
test('忙于前端操作或卸载后不启动进度请求', async () => {
  const h = harness(fixture()); h.setBusy(true); await h.poll(true); assert.equal(h.reads, 0);
  h.setBusy(false); h.close(); await h.poll(true); assert.equal(h.reads, 0);
});
test('投影顺序混杂仍按最新workflow身份绑定，不串用旧心跳', () => {
  const workspace = fixture(), old = { workflowId: 'old', stage: 'storyboard.run', status: 'running', nodes: [node('storyboardPlan', 'running')] };
  workspace.jobs.unshift({ id: 'old', kind: 'workflow', entityId: 'storyboard.run', provider: 'local', status: 'running', createdAt: '2026-10-01T00:00:00Z' });
  workspace.workflowProgress!.unshift(old);
  const before = JSON.stringify(workspace), selected = selectWorkflowProgress(workspace, 'storyboard');
  assert.equal(selected.id, 'current'); assert.equal(selected.nodes[0].status, 'accepted'); assert.equal(JSON.stringify(workspace), before);
});
test('新流程尚无投影时不借用旧流程完成数或执行状态', () => {
  const workspace = fixture(); workspace.jobs.unshift({ id: 'new', kind: 'workflow', entityId: 'storyboard.run', provider: 'local', status: 'queued', createdAt: '2026-10-06T00:00:00Z' });
  const selected = selectWorkflowProgress(workspace, 'storyboard');
  assert.equal(selected.id, 'new'); assert.equal(selected.state, 'queued'); assert.equal(selected.nodes.length, 0); assert.equal(selected.completed, 0);
});
test('只有已正式采用的步骤计入完成批次，未收到未来批次不猜总量', () => {
  const nodes = [node('storyboardCreate', 'accepted', 'B01'), node('storyboardCreate', 'received', 'B02'), node('storyboardCreate', 'rejected', 'B03')];
  assert.equal(storyboardCompletion(nodes), '1 批单元主创');
  assert.equal(storyboardCompletion([]), null);
});
test('Plan从精确集身份回读名称，整编哈希不伪造成主创批次号', () => {
  const workspace = fixture(), plan = node('storyboardPlan', 'accepted'); plan.input.episodeId = '';
  assert.equal(storyboardNodeTitle(plan, workspace), '情绪与事件规划 · 第一集');
  const finish = { ...node('storyboardFinish', 'running'), id: `storyboardFinish:${episodeId}:batch:finish:0123456789abcdef` };
  assert.equal(storyboardNodeTitle(finish, workspace), '关联范围整编 · 第一集');
});
test('过期心跳不外推用时或伪称当前进程存活，完成步骤不显示旧CLI', () => {
  const current = node('storyboardCreate', 'running', 'B03');
  assert.equal(executionSummary(current, stamp + 100000), '执行状态暂未更新 · 最后记录用时 2 分 15 秒');
  assert.equal(executionSummary({ ...current, status: 'accepted' }, stamp + 5000), '');
  assert.equal(executionSummary({ ...current, execution: null }, stamp), '正在读取本批执行状态');
});

function repairedFixture(kind = 'author-scope-repair') {
  const workspace = fixture(), originHash = 'a'.repeat(64), resolverHash = 'b'.repeat(64);
  const originStage = kind === 'continuity-superseded' ? 'storyboardPlan' : 'storyboardCreate', resolverStage = kind === 'continuity-superseded' ? 'storyboardPlan' : 'storyboardFinish';
  const origin = { ...node(originStage, 'rejected', 'B01'), requestHash: originHash, error: 'ASSET_SCENE_SCOPE', resolution: { version: 'workflow-step-resolution/v1', kind, workflowId: 'current', originNodeId: node(originStage, 'rejected', 'B01').id, originRequestHash: originHash, resolverNodeId: `${resolverStage}:bound-repair`, resolverRequestHash: resolverHash, verified: true } };
  const resolver = { ...node(resolverStage, 'accepted'), id: `${resolverStage}:bound-repair`, requestHash: resolverHash, input: { episodeId, executionBatchVersion: 'author-domain-repair/v1' } };
  const nodes = [origin, resolver, node('storyboardCreate', 'running', 'B02')];
  workspace.workflowProgress![0].nodes = nodes;
  return { workspace, origin, resolver, nodes };
}
test('已采用范围修订只消除绑定原节点的当前警告，保留原rejected及错误记录', () => {
  const { workspace, origin, nodes } = repairedFixture(), before = JSON.stringify(workspace);
  assert.equal(workflowNodeResolution(origin, nodes, 'current'), 'author-scope-repair');
  const selected = selectWorkflowProgress(workspace, 'storyboard');
  assert.equal(selected.nodes.length, 3); assert.equal(selected.currentNodes.length, 2); assert.equal(selected.completed, 1);
  assert.equal(selected.nodes[0].status, 'rejected'); assert.equal(selected.nodes[0].error, 'ASSET_SCENE_SCOPE');
  assert.equal(selected.currentNodes[0].status, 'accepted'); assert.equal(selected.currentNodes[1].status, 'running');
  assert.equal(JSON.stringify(workspace), before, 'projection never rewrites history or an original author acceptance');
});
test('修订证明逐项绑定workflow及原节点/修订节点哈希，缺字段或非accepted仍需要处理', () => {
  const { origin, resolver, nodes } = repairedFixture();
  for (const change of [{ version: 'unknown/v1' }, { kind: 'unknown' }, { verified: false }, { workflowId: 'other-workflow' }, { originNodeId: 'other-origin' }, { originRequestHash: 'c'.repeat(64) }, { resolverNodeId: 'missing' }, { resolverNodeId: origin.id }, { resolverRequestHash: 'c'.repeat(64) }]) {
    const changed = { ...origin, resolution: { ...origin.resolution, ...change } };
    assert.equal(workflowNodeResolution(changed, [changed, resolver], 'current'), null, JSON.stringify(change));
  }
  for (const status of ['completed', 'received', 'running', 'rejected']) assert.equal(workflowNodeResolution(origin, [origin, { ...resolver, status }], 'current'), null);
  assert.equal(workflowNodeResolution({ ...origin, resolution: undefined }, nodes, 'current'), null);
  assert.equal(workflowNodeResolution(origin, [origin], 'current'), null);
  assert.equal(workflowNodeResolution(origin, [...nodes, { ...resolver }], 'current'), null, 'ambiguous resolver identity cannot hide an error');
  assert.equal(workflowNodeResolution({ ...origin, requestHash: 'legacy-short-hash' }, nodes, 'current'), null);
  assert.equal(workflowNodeResolution(origin, [origin, { ...resolver, input: { episodeId, executionBatchVersion: 'related-range-finish/v1' } }], 'current'), null);
  const rejectedRepair = { ...origin, stage: 'storyboardFinish', input: { episodeId, executionBatchVersion: 'author-domain-repair/v1' } };
  assert.equal(workflowNodeResolution(rejectedRepair, [rejectedRepair, resolver], 'current'), 'author-scope-repair');
  assert.equal(workflowNodeResolution({ ...rejectedRepair, input: { episodeId } }, [rejectedRepair, resolver], 'current'), null);
});
test('同标题、相似修订键和流程completed不能替代修订证明，也不能借其他workflow的采用节点', () => {
  const { workspace, origin, resolver } = repairedFixture();
  const unresolved = { ...origin, resolution: undefined }, unrelated = { ...resolver, title: '单元主创', id: origin.id + ':author-domain-repair', status: 'completed' };
  assert.equal(workflowNodeResolution(unresolved, [unresolved, unrelated], 'current'), null);
  workspace.workflowProgress![0].status = 'completed'; workspace.workflowProgress![0].nodes = [unresolved, unrelated];
  assert.equal(selectWorkflowProgress(workspace, 'storyboard').currentNodes[0].error, 'ASSET_SCENE_SCOPE');
  workspace.jobs.unshift({ ...workspace.jobs[0], id: 'new-workflow', createdAt: '2026-10-06T01:00:00Z' });
  workspace.workflowProgress!.unshift({ workflowId: 'new-workflow', stage: 'storyboard.run', status: 'running', nodes: [origin, resolver] });
  const selected = selectWorkflowProgress(workspace, 'storyboard');
  assert.equal(selected.id, 'new-workflow'); assert.equal(selected.currentNodes.length, 2, 'proof from a different run cannot resolve this run');
});
test('只有正式末态变化证明才将旧分支移出当前计数，后续未采用不掩盖当前失败', () => {
  const { workspace, origin, resolver } = repairedFixture('continuity-superseded');
  const old = { ...origin, status: 'accepted', error: null }, current = resolver;
  workspace.workflowProgress![0].nodes = [old, current];
  assert.equal(workflowNodeResolution(old, [old, current], 'current'), 'continuity-superseded');
  assert.equal(selectWorkflowProgress(workspace, 'storyboard').completed, 1);
  assert.equal(storyboardCompletion(selectWorkflowProgress(workspace, 'storyboard').currentNodes), '1 批情绪规划');
  const failed = { ...origin, error: 'old branch failure' }, pending = { ...current, status: 'running' };
  assert.equal(workflowNodeResolution(failed, [failed, pending], 'current'), null);
  const author = { ...failed, stage: 'storyboardCreate' };
  assert.equal(workflowNodeResolution(author, [author, current], 'current'), null, 'a tail marker alone cannot retire an Author failure');
  workspace.workflowProgress![0].nodes = [{ ...old, resolution: undefined }, current];
  assert.equal(selectWorkflowProgress(workspace, 'storyboard').completed, 2, 'without provenance, history is not inferred from completion or titles');
});
