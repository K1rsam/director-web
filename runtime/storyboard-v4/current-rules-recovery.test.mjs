import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCoordinator} from './coordinator.mjs';
import {captureRules} from './core/core.mjs';
import {DELTA_VERSION} from './core/delta.mjs';
import {normalizeSource} from './core/source.mjs';
import {VERSION, PLAN_VERSION, digest} from './core/shared.mjs';

// Exercise the actual newly captured rules, rather than the legacy transport fixture.
// Every request is answered by this local mock; no CLI or model is invoked.
const methodPath = 'skills/fantasy-expression-methods/SKILL.md';
const styles = [
  {
    name: '3D本人Q版',
    visualStyle: '3D国漫，16:9；同一角色的3D建模与立体受光保持连续。',
    form: '同一角色的3D建模Q版造型，保留甲的黑色短发、浓眉、蓝色外套与银色耳钉，头大身小，衣发仍有体积和受光变化',
  },
  {
    name: '明确选定的二维本人Q版',
    visualStyle: '2D动漫，16:9；二维线描与平涂，保持人物辨识特征。',
    form: '明确选定的二维线描平涂Q版造型，保留甲的黑色短发、浓眉、蓝色外套与银色耳钉，头大身小，沿用二维画风',
  },
];

function fixture(style) {
  const source = normalizeSource({key: 'source-q-recovery', title: style.name, sourceRows: [
    {id: 's1', line: 1, text: `△甲在主观画面中变成${style.form}，攥拳后抬眼。`},
    {id: 's2', line: 2, text: '甲：“前半，后半。”'},
  ]});
  assert.deepEqual(source.diagnostics, []);
  const quote = source.dialogue[0];
  assert.equal(quote.quote, '“前半，后半。”');
  const emotionContract = {subject: '甲', contextTone: '坚定', audienceEffect: '看见甲作出决定', change: '迟疑转决断', landing: '抬眼开口', retain: ['源Q版表现与逐字原话']};
  const boundaryBefore = {kind: 'episode_start', reason: '本集完整行动入口'};
  const plan = {
    schemaVersion: PLAN_VERSION, unitPackingPolicy: 'event-first-v1', emotionArc: '迟疑转决断', entryFacts: [],
    events: [{id: 'e1', sourceRefs: ['s1', 's2'], sceneKey: '门厅-日内', boundaryBefore, emotionContract}],
    workPackages: [{id: 'p1', eventId: 'e1', sourceRefs: ['s1', 's2'], emotionContract, entryFactIds: [], contextRefs: [], dependsOn: [], scenarioKeys: []}],
    provisionalUnits: [{id: 'p1-u1', packageId: 'p1', sourceRefs: ['s1', 's2'], secondsRange: [6, 10]}],
    fantasyCandidates: [],
  };
  const part = (text, delivery) => ({lineId: quote.id, text, presentation: '画内', delivery, voiceStart: 0.5, voiceEnd: 1.5});
  const direction = `甲以${style.form}完成源动作；攥拳带起肩背，抬眼接住决断，摄影沿同一侧面缓推，衣料声随动作收住。`;
  const draft = {
    schemaVersion: VERSION,
    units: [{id: 'p1-u1', eventId: 'e1', boundaryBefore, title: '甲的决定', unitDirection: direction,
      intent: {subject: '甲', change: '迟疑转决断', landing: '抬眼开口', retain: ['源Q版表现与逐字原话']},
      scene: '日 内 门厅', props: [], participants: ['甲'], lighting: '窗光保持侧照，衣发受光方向连续。',
      initialState: `甲已呈现${style.form}，站在门边。`, exitState: '甲攥拳后抬眼，站位仍在门边。',
      shots: [
        {id: 'p1-s1', duration: 4, camera: '侧面中景缓慢推进。', picture: `甲以${style.form}攥紧拳头，肩背随发力抬起后收住。`, lighting: '窗光照清拳头与衣袖体积。', sound: '衣料摩擦承接甲的发声。', dialogueParts: [part('“前半，', '甲：坚定。')], transition: '沿抬眼动作接下镜。', sourceRefs: ['s1', 's2'], contextRefs: []},
        {id: 'p1-s2', duration: 4, camera: '沿同一侧面推进到近景，保持人物位置。', picture: `甲仍是${style.form}，从攥拳的余势抬眼，目光落向门口。`, lighting: '延续窗光方向，照清眼神。', sound: '人声落下，保留轻微衣料余声。', dialogueParts: [part('后半。”', '甲：落定。')], transition: '停在甲的决断目光。', sourceRefs: ['s2'], contextRefs: []},
      ],
    }],
    fantasyRealization: [],
  };
  const invalid = structuredClone(draft);
  invalid.units[0].shots[0].dialogueParts[0].text = '前半，';
  invalid.units[0].shots[1].dialogueParts[0].text = '后半。';
  const settings = {model: 'gpt-6-sol', reasoning: 'medium', maxUnits: null, maxUnitSeconds: 30, fantasyMode: 'off', visualStyle: style.visualStyle};
  return {source, quote, plan, draft, invalid, settings, direction};
}

function modelInput(request) {
  // The public prompt contains one JSON line after this marker; embedded newlines are escaped.
  const payload = request.prompt.split('【生效设置与本次完整资料】\n')[1];
  assert.ok(payload, 'request must include its actual model input');
  return JSON.parse(payload.split('\n')[0]);
}

for (const hasCandidate of [false, true]) test(`current all mode completes in one start with ${hasCandidate ? 'a partially covered' : 'an empty'} fantasy plan`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'v4-all-existing-fantasy-'));
  let c;
  t.after(async () => {try {await c?.shutdown();} finally {await rm(directory, {recursive: true, force: true});}});
  const f = fixture(styles[0]), calls = [];
  f.settings.fantasyMode = 'all';
  f.plan.provisionalUnits = [
    {id: 'rough-1', packageId: 'p1', sourceRefs: ['s1'], secondsRange: [3, 5]},
    {id: 'rough-2', packageId: 'p1', sourceRefs: ['s2'], secondsRange: [3, 5]},
  ];
  if (hasCandidate) {
    f.plan.fantasyCandidates = [{id: 'f1', anchorRefs: ['s1'], subject: '甲', emotionPurpose: '决心增强', recommended: false,
      proposal: '主观画面中，甲肩侧浮出握拳的小化身，伴随本人抬眼收回。', screenSecondsRange: [2, 4], extraSecondsRange: [0, 0]}];
    f.draft.units[0].shots[0].picture += '甲肩侧浮出同角色的3D小化身，握拳前倾，随本人肩背落稳收回。';
    f.draft.fantasyRealization = [{candidateId: 'f1', unitIds: ['p1-u1'], shotIds: ['p1-s1'], screenSeconds: 3,
      entry: '小化身从甲肩侧浮出', exit: '随肩背落稳收回', domain: '主观', preservedFunction: '决心增强', status: 'realized'}];
  }
  c = createCoordinator({dataRoot: directory, modelRunner: async request => {
    calls.push(request);
    const output = request.stage === 'plan' ? structuredClone(f.plan) : request.stage === 'author' ? structuredClone(f.draft) : {
      schemaVersion: DELTA_VERSION, baseDraftHash: request.baseDraftHash, retainedUnitIds: ['p1-u1'], replacements: [], revisionNotes: [], unresolved: [],
    };
    return {output, raw: JSON.stringify(output), usage: {totalTokens: 1}, requestOutcome: 'RESPONDED'};
  }});
  const d = await c.create({source: f.source, settings: f.settings, binding: {projectId: 'test-all-selection', episodeId: `coverage-${hasCandidate}`, sourceVersion: 'fixture-v1'}});
  await c.start(d.id, {mode: 'all'}); await c.wait(d.id);
  const result = await c.read(d.id);
  assert.equal(result.web.progress, 'text_ready_for_review', JSON.stringify({status: result.status, progress: result.web.progress, error: result.web.error, errors: result.candidates.map(x => x.errors || x.validation?.errors)}));
  assert.deepEqual(calls.map(r => r.stage), ['plan', 'author', 'finish']);
  assert.deepEqual(result.choice.unitOverrides, {}, 'skipping uncovered units must not manufacture user overrides');
  assert.equal(result.web.autoRepairs, 0);
  assert.deepEqual(result.assembly.validation.errors, []);
  assert.deepEqual(result.assembly.draft.fantasyRealization, f.draft.fantasyRealization);
  assert.deepEqual(result.assembly.draft.units, f.draft.units, 'ordinary performance and source Q-form remain intact');
  for (const request of calls.filter(r => r.stage !== 'plan')) {
    assert.deepEqual(request.selection.selectedIds, hasCandidate ? ['f1'] : []);
    assert.equal(request.settings.fantasyEnabled, hasCandidate);
    assert.ok(request.snapshot.some(file => file.path === methodPath), 'source Q-form still loads methods without added candidates');
  }
});

const recoveryCases = [...styles.map(style => ({style, allAtOnce: false})), {style: styles[0], allAtOnce: true}];
for (const {style, allAtOnce} of recoveryCases) test(`current rules recover quote edges and export v3 without losing ${style.name}${allAtOnce ? ' in one mode:all run' : ''}`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'v4-current-rules-recovery-'));
  let c, beforeAutomaticFinish;
  t.after(async () => {try {await c?.shutdown();} finally {await rm(directory, {recursive: true, force: true});}});
  const f = fixture(style), calls = [], frozenRules = captureRules(), frozenHash = digest(frozenRules);
  assert.equal(frozenRules.seedanceExportVersion, 'seedance-execution-v3');
  assert.equal(frozenRules.unitDirectionVersion, 'unit-direction-v1');
  assert.equal(frozenRules.sourceExpressionMethodsVersion, 'source-expression-methods-v2');
  const originalSource = structuredClone(f.source), originalDraft = structuredClone(f.draft);
  const rawAuthor = JSON.stringify(f.invalid);
  c = createCoordinator({dataRoot: directory, modelRunner: async (request, options) => {
    calls.push(request);
    let output;
    if (request.stage === 'plan') output = structuredClone(f.plan);
    else if (request.stage === 'author') output = structuredClone(f.invalid);
    else {
      assert.equal(request.stage, 'finish');
      if (allAtOnce) beforeAutomaticFinish = await c.read(options.runId);
      assert.equal(request.finishMode, 'full', 'rawText repair must request a complete draft');
      const input = modelInput(request);
      assert.equal(input.previousDraft.rawText, rawAuthor);
      assert.ok(input.issues.some(issue => issue.code === 'DIALOGUE_CONTENT'));
      assert.deepEqual(input.previousDraft.supplementalCandidates[0].draft, f.invalid);
      output = {...structuredClone(f.draft), revisionNotes: [{coordinate: f.quote.id, sourceRefs: ['s2'], change: '恢复源quote最外侧中文引号，保留动作、原话与相对发声窗。', preservedFunction: '原话与源Q版表现'}], unresolved: []};
    }
    return {output, raw: JSON.stringify(output), usage: {totalTokens: 1}, requestOutcome: 'RESPONDED'};
  }});
  const d = await c.create({source: f.source, settings: f.settings, binding: {projectId: 'test-current-rules', episodeId: style.name, sourceVersion: 'fixture-v1'}});
  assert.equal(digest(d.rulesSnapshot), frozenHash);
  // The additional case observes the rejected candidate without interrupting one all-mode run.
  if (allAtOnce) {
    await c.start(d.id, {mode: 'all'}); await c.wait(d.id);
  } else {
    await c.start(d.id, {mode: 'next'}); await c.wait(d.id);
    await c.start(d.id, {mode: 'next'}); await c.wait(d.id);
  }
  const before = allAtOnce ? beforeAutomaticFinish : await c.read(d.id);
  assert.ok(before, 'automatic finishing must observe the saved rejected author candidate');
  const original = before.candidates.find(candidate => candidate.stage === 'author');
  assert.equal(original.status, 'needs_repair');
  assert.equal(original.raw, rawAuthor);
  assert.deepEqual(original.output, f.invalid);
  assert.deepEqual(original.draft, f.invalid);
  assert.deepEqual(original.validation.errors.map(issue => issue.code), ['DIALOGUE_CONTENT']);
  assert.equal(original.resolvedBy, undefined);
  assert.equal(before.adopted.length, 0);
  const savedCandidate = structuredClone(original);
  if (!allAtOnce) {await c.start(d.id, {mode: 'all'}); await c.wait(d.id);}
  const result = await c.read(d.id), preserved = result.candidates.find(candidate => candidate.id === original.id), repaired = result.candidates.find(candidate => candidate.stage === 'finish');
  assert.deepEqual(calls.map(request => request.stage), ['plan', 'author', 'finish']);
  assert.deepEqual(calls.map(request => request.packageIds), [[], ['p1'], ['p1']]);
  assert.equal(result.operations.length, 3);
  assert.equal(result.web.autoRepairs, 1);
  assert.equal(result.web.reserved, 0);
  assert.equal(result.status, 'text_ready_for_review');
  assert.equal(result.web.progress, 'text_ready_for_review');
  assert.equal(digest(result.rulesSnapshot), frozenHash, 'saved task rules must remain frozen through repair');
  assert.equal(result.rulesSnapshot.seedanceExportVersion, 'seedance-execution-v3');
  assert.deepEqual(result.assembly.validation.errors, []);
  assert.equal(repaired.status, 'adopted');
  assert.equal(preserved.resolvedBy, repaired.id);
  const {resolvedBy, ...candidateWithoutResolution} = preserved;
  assert.deepEqual(candidateWithoutResolution, savedCandidate, 'earlier response and validation evidence must remain intact');
  assert.equal(result.adopted.length, 1);
  assert.equal(result.adopted[0].stage, 'finish');
  assert.equal(result.adopted[0].candidateId, repaired.id);
  const operation = result.operations.find(op => op.stage === 'finish');
  assert.equal(operation.finishMode, 'full');
  assert.equal(operation.previousDraft.rawText, rawAuthor);
  assert.ok(operation.issues.some(issue => issue.code === 'DIALOGUE_CONTENT'));
  for (const request of calls.filter(request => request.stage !== 'plan')) {
    assert.equal(request.settings.fantasyEnabled, false, 'loading source-expression methods must not enable added fantasy');
    assert.deepEqual(request.selection.selectedIds, []);
    assert.deepEqual(request.plan.fantasyCandidates, []);
    const method = request.snapshot.find(file => file.path === methodPath);
    assert.ok(method, 'source-required Q-form must load detailed methods even when extra fantasy is off');
    assert.match(method.body, /3D建模Q版/);
    assert.match(method.body, /二维/);
    assert.match(method.body, /本人/);
    assert.match(method.body, /化身/);
  }
  assert.deepEqual(result.source, originalSource);
  assert.deepEqual(f.draft, originalDraft, 'the export and repair checks must not mutate their input fixture');
  assert.deepEqual(result.assembly.draft.fantasyRealization, []);
  assert.deepEqual(result.adopted[0].draft.units, f.draft.units);
  assert.deepEqual(result.assembly.draft.units, f.draft.units, 'repair must preserve direction, motion, camera, sound and stored relative windows');
  const unit = result.assembly.draft.units[0], parts = unit.shots.flatMap(shot => shot.dialogueParts);
  assert.equal(unit.unitDirection, f.direction);
  assert.equal(parts.map(part => part.text).join(''), f.quote.quote);
  assert.deepEqual(parts.map(({voiceStart, voiceEnd}) => [voiceStart, voiceEnd]), [[0.5, 1.5], [0.5, 1.5]]);
  assert.equal(unit.shots.reduce((seconds, shot) => seconds + shot.duration, 0), 8);
  const text = result.assembly.text;
  assert.ok(text.includes(style.visualStyle));
  assert.ok(text.includes(f.direction));
  for (const shot of f.draft.units[0].shots) {
    for (const field of ['camera', 'picture', 'lighting', 'sound', 'transition']) assert.ok(text.includes(shot[field]), `export must retain ${field}`);
  }
  assert.deepEqual(text.split('\n').filter(line => line.startsWith('台词：')), [
    '台词：0.5–1.5秒｜甲（坚定）：“前半，”',
    '台词：4.5–5.5秒｜甲（落定）：“后半。”',
  ]);
  assert.ok(text.includes('分镜2｜4-8s｜4s'));
  assert.doesNotMatch(text, /：““|。””|本镜|额外幻想关闭|遵守已有幻想选择|本单元不加入额外幻想段落|已选幻想只按/);
  assert.ok(text.includes(style.form));
  if (style.name.startsWith('明确')) assert.doesNotMatch(text, /3D/);
});

for (const defect of ['missing quote edges', 'changed dialogue words']) test(`current rules reject ${defect} from finish and stop when the same error persists`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'v4-current-rules-rejection-'));
  let c;
  t.after(async () => {try {await c?.shutdown();} finally {await rm(directory, {recursive: true, force: true});}});
  const f = fixture(styles[0]), calls = [], invalidFinish = structuredClone(defect === 'missing quote edges' ? f.invalid : f.draft);
  if (defect === 'changed dialogue words') invalidFinish.units[0].shots[0].dialogueParts[0].text = '“改写，';
  const rawAuthor = JSON.stringify(f.invalid), originalSource = structuredClone(f.source);
  c = createCoordinator({dataRoot: directory, modelRunner: async request => {
    calls.push(request);
    let output;
    if (request.stage === 'plan') output = structuredClone(f.plan);
    else if (request.stage === 'author') output = structuredClone(f.invalid);
    else {
      assert.equal(request.stage, 'finish');
      assert.equal(request.finishMode, 'full');
      assert.ok(modelInput(request).issues.some(issue => issue.code === 'DIALOGUE_CONTENT'));
      output = structuredClone(invalidFinish);
    }
    return {output, raw: JSON.stringify(output), usage: {totalTokens: 1}, requestOutcome: 'RESPONDED'};
  }});
  const d = await c.create({source: f.source, settings: f.settings, binding: {projectId: 'test-current-rules', episodeId: defect, sourceVersion: 'fixture-v1'}, budget: {maxCalls: 8, maxTokens: 100}});
  await c.start(d.id, {mode: 'all'}); await c.wait(d.id);
  const result = await c.read(d.id), author = result.candidates.find(candidate => candidate.stage === 'author');
  assert.deepEqual(calls.map(request => request.stage), ['plan', 'author', 'finish']);
  assert.equal(result.operations.length, 3);
  assert.equal(result.web.autoRepairs, 1);
  assert.equal(result.web.error?.code, 'REPAIR_NO_PROGRESS');
  assert.equal(result.web.reserved, 0);
  assert.equal(result.status, 'needs_repair');
  assert.equal(result.web.progress, 'needs_repair', 'repair policy, not the larger call budget, must stop dispatch');
  assert.equal(result.assembly, null, 'invalid finishing cannot produce an accepted export');
  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.source, originalSource);
  assert.equal(result.rulesSnapshot.seedanceExportVersion, 'seedance-execution-v3');
  assert.equal(result.rulesSnapshot.sourceExpressionMethodsVersion, 'source-expression-methods-v2');
  assert.equal(author.raw, rawAuthor);
  assert.deepEqual(author.output, f.invalid);
  assert.equal(author.resolvedBy, undefined);
  for (const candidate of result.candidates.filter(candidate => candidate.stage !== 'plan')) {
    assert.equal(candidate.status, 'needs_repair');
    assert.deepEqual(candidate.validation.errors.map(issue => issue.code), ['DIALOGUE_CONTENT']);
    assert.equal(candidate.resolvedBy, undefined);
  }
  await c.start(d.id, {mode: 'all'}); await c.wait(d.id);
  assert.equal(calls.length, 3, 'restarting all mode must not repeat a repair that made no progress');
  assert.equal((await c.read(d.id)).assembly, null);
});

test('current rules retain one long OS across two capacity units and delta finish resets each v3 timeline', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'v4-current-rules-long-os-'));
  let c;
  t.after(async () => {try {await c?.shutdown();} finally {await rm(directory, {recursive: true, force: true});}});
  const style = styles[0], f = fixture(style), fragments = [
    '“我已经站在门前很久，手里的钥匙越握越紧，可我知道里面的人也在等我，',
    '如果现在转身，昨晚答应过的话就只剩一句空话，我不能再让他们独自承担，',
    '所以先把呼吸稳下来，再抬头看清门上的旧划痕，那是我们一起搬进来时留下的，',
    '这一次我要亲手推开门，把该说的话完整说完，无论结果怎样，都不再后退。”',
  ];
  const source = normalizeSource({key: 'long-os-capacity', title: '门前长OS', sourceRows: [
    {id: 's1', line: 1, text: `△甲在主观画面中保持${style.form}，攥拳后抬眼；内心独白连续，画面中的甲不张嘴。`},
    {id: 's2', line: 2, text: `甲（OS）：${fragments.join('')}`},
  ]});
  assert.deepEqual(source.diagnostics, []);
  const quote = source.dialogue[0], plan = structuredClone(f.plan), draft = structuredClone(f.draft), calls = [];
  assert.equal(quote.channel, 'OS');
  assert.equal(quote.quote, fragments.join(''));
  plan.provisionalUnits = [1, 2].map(i => ({id: `p1-u${i}`, packageId: 'p1', sourceRefs: i === 1 ? ['s1', 's2'] : ['s2'], secondsRange: [22, 26]}));
  const handoff = `甲保持${style.form}，拳头松开一指，目光仍停在门口，呼吸尚未落稳。`;
  draft.units = [0, 1].map(index => {
    const unit = structuredClone(f.draft.units[0]);
    unit.id = `p1-u${index + 1}`;
    unit.title = `门前长OS-${index + 1}`;
    unit.unitDirection = `甲保持${style.form}，以攥拳、松指和抬眼延续同一内心决定；OS连续，画面人物不张嘴，声画在容量接点接续。`;
    if (index) {unit.boundaryBefore = {kind: 'capacity', reason: '同一连续事件自然时长48秒超过30秒容量，在松指动作与OS语义接点续接。'}; unit.initialState = handoff;}
    unit.exitState = index ? `甲保持${style.form}，目光落定，手指已经松开。` : handoff;
    unit.shots = unit.shots.map((shot, offset) => ({...shot, id: `os-u${index + 1}-s${offset + 1}`, duration: 12,
      picture: `${shot.picture}甲不张嘴，内心独白随可见动作延续。`, sound: '甲的OS平稳接续，门厅环境底声不断。',
      dialogueParts: [{lineId: quote.id, text: fragments[index * 2 + offset], presentation: 'OS', delivery: '甲：压住迟疑。', voiceStart: 0.5, voiceEnd: 11}],
      sourceRefs: index === 0 && offset === 0 ? ['s1', 's2'] : ['s2'], transition: '同一OS与松指动作连续承接，不另起事件。',
    }));
    return unit;
  });
  const originalSource = structuredClone(source), originalDraft = structuredClone(draft);
  c = createCoordinator({dataRoot: directory, modelRunner: async request => {
    calls.push(request);
    let output;
    if (request.stage === 'plan') output = structuredClone(plan);
    else if (request.stage === 'author') output = structuredClone(draft);
    else {
      assert.equal(request.stage, 'finish');
      assert.equal(request.finishMode, 'delta');
      assert.deepEqual(modelInput(request).previousDraft.units, draft.units);
      output = {schemaVersion: DELTA_VERSION, baseDraftHash: request.baseDraftHash, retainedUnitIds: draft.units.map(unit => unit.id), replacements: [], revisionNotes: [], unresolved: []};
    }
    return {output, raw: JSON.stringify(output), usage: {totalTokens: 1}, requestOutcome: 'RESPONDED'};
  }});
  const d = await c.create({source, settings: f.settings, binding: {projectId: 'test-current-rules', episodeId: 'long-os-capacity', sourceVersion: 'fixture-v1'}});
  await c.start(d.id, {mode: 'all'}); await c.wait(d.id);
  const result = await c.read(d.id), finished = result.candidates.find(candidate => candidate.stage === 'finish');
  assert.deepEqual(calls.map(request => request.stage), ['plan', 'author', 'finish']);
  assert.equal(result.status, 'text_ready_for_review');
  assert.equal(result.web.autoRepairs, 0);
  assert.equal(result.rulesSnapshot.seedanceExportVersion, 'seedance-execution-v3');
  assert.equal(result.rulesSnapshot.sourceExpressionMethodsVersion, 'source-expression-methods-v2');
  assert.deepEqual(result.assembly.validation.errors, []);
  assert.equal(finished.output.schemaVersion, DELTA_VERSION);
  assert.equal(finished.status, 'adopted');
  assert.deepEqual(finished.output.retainedUnitIds, ['p1-u1', 'p1-u2']);
  assert.ok(finished.normalizations.some(change => change.reason === 'capacity_exceeded' && change.action === 'retain'));
  assert.deepEqual(result.source, originalSource);
  assert.deepEqual(draft, originalDraft);
  assert.deepEqual(result.assembly.draft.units, originalDraft.units, 'delta finishing must preserve both capacity units and their handoff');
  assert.deepEqual(result.assembly.draft.fantasyRealization, []);
  const units = result.assembly.draft.units, parts = units.flatMap(unit => unit.shots.flatMap(shot => shot.dialogueParts));
  assert.equal(units.length, 2);
  assert.deepEqual(units.map(unit => unit.shots.reduce((sum, shot) => sum + shot.duration, 0)), [24, 24]);
  assert.equal(units[0].exitState, units[1].initialState);
  assert.equal(units[1].boundaryBefore.kind, 'capacity');
  assert.equal(parts.map(part => part.text).join(''), quote.quote);
  assert.ok(parts.every(part => part.lineId === quote.id && part.presentation === 'OS'));
  for (const request of calls.filter(request => request.stage !== 'plan')) {
    assert.equal(request.settings.fantasyEnabled, false);
    assert.deepEqual(request.selection.selectedIds, []);
    assert.ok(request.snapshot.some(file => file.path === methodPath), 'source Q-form methods remain available with extra fantasy off');
  }
  const sections = result.assembly.text.split('\n\n---\n\n');
  assert.equal(sections.length, 2);
  const displayParts = [`${fragments[0]}”`, `“${fragments[1]}”`, `“${fragments[2]}”`, `“${fragments[3]}`];
  for (const [index, section] of sections.entries()) {
    assert.deepEqual(units[index].participants, ['甲']);
    assert.ok(section.includes(style.form));
    assert.ok(section.includes('分镜1｜0-12s｜12s'));
    assert.ok(section.includes('分镜2｜12-24s｜12s'));
    assert.deepEqual(section.split('\n').filter(line => line.startsWith('台词：')), [
      `台词：0.5–11秒｜甲（OS·压住迟疑）：${displayParts[index * 2]}`,
      `台词：12.5–23秒｜甲（OS·压住迟疑）：${displayParts[index * 2 + 1]}`,
    ]);
    assert.doesNotMatch(section, /：““|。””|24\.5–|本镜/);
  }
});
