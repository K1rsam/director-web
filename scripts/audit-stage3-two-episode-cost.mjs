import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {changedConsumedMaterials} from '../runtime/production-materials.mjs';
import {boundaryEvidenceRows, validateProductionFeedback} from '../runtime/episode-boundary.mjs';
import {restoreModelCoordinates} from '../runtime/storyboard-v4/core/model-coordinates.mjs';

// Offline, fixed historical sample. No provider, coordinator, database or service imports.
const root = process.cwd();
const samples = [
  ['3008', 1, '.storyboard-stage3-v2', 'ad4a98e7-b693-45e3-b31d-d5c34066636e'],
  ['3008', 2, '.storyboard-stage3-v2', '5f68388b-f423-4522-b332-7d8e772da294'],
  ['3007', 1, '../director-web-stage1-20260909/.storyboard-v4', '65611fa7-38ae-4f7e-8c98-3914cca4ec6c'],
  ['3007', 2, '../director-web-stage1-20260909/.storyboard-v4', '5fa831aa-39d2-4d9a-8623-a83a4ce43d15'],
];
const hash = x => createHash('sha256').update(x).digest('hex');
const protectedFiles = new Map();
async function read(file) {
  const absolute = path.resolve(root, file), text = await readFile(absolute, 'utf8');
  protectedFiles.set(absolute, hash(text));
  return text;
}
const json = async file => JSON.parse(await read(file));
const chars = value => value === undefined ? 0 : JSON.stringify(value).length;
const sizes = object => Object.fromEntries(Object.entries(object ?? {}).map(([k,v]) => [k, chars(v)]));
const promptBody = request => JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
function expand(request) {
  const input = promptBody(request), aliases = request.modelCoordinates?.aliases ?? {};
  const get = p => p.slice(2).split('/').reduce((v,k) => v[k.replaceAll('~1','/').replaceAll('~0','~')], input);
  const visit = v => {
    if (typeof v === 'string') return aliases[v] ?? v;
    if (!v || typeof v !== 'object') return v;
    if (v.$same) return visit(get(v.$same));
    if (v.$rowIds) return v.$rowIds.flatMap(([k,a,b]) => input.source[k].slice(a,b+1).map(row => visit(row.id)));
    if (v.$joinRows) { const [k,a,b,s] = v.$joinRows; return input.source[k].slice(a,b+1).map(row => row.text).join(s); }
    if (v.$boundaryNodes) return v.$boundaryNodes.rows.map(row => Object.fromEntries(v.$boundaryNodes.columns.map((k,i) => [k,visit(row[i])])));
    if (v.$jsonOf) return JSON.stringify(visit(get(v.$jsonOf)));
    return Array.isArray(v) ? v.map(visit) : Object.fromEntries(Object.entries(v).map(([k,x]) => [k,visit(x)]));
  };
  return visit(input);
}
const rowsText = rows => (rows ?? []).map(row => row.text.trim()).filter(Boolean);
const spokenText = (unit, source) => (unit.shots ?? []).flatMap(shot => shot.dialogueParts ?? []).map(d => {
  const line = source.dialogue.find(q => q.id === d.lineId);
  return {lineId:d.lineId,speaker:line?.speaker,channel:line?.channel,presentation:d.presentation,text:d.text};
});
const sum = (calls, key) => calls.reduce((n,c) => n + c.usage[key], 0);
const documents = new Map(), requestMap = new Map(), result = [];
let creativeText = '# 新旧稿逐镜只读审阅摘录\n\n本文件含全部镜头的表演与机位，供人工比较；不是自动创作品质评分。\n';
for (const [side, episode, base, id] of samples) {
  const d = await json(`${base}/documents/${id}.json`); documents.set(`${side}-${episode}`, d);
  const calls = [];
  for (const op of d.operations) {
    const prefix = `${base}/attempts/${op.attemptId}`;
    const r = await json(`${prefix}/request.json`), receipt = await json(`${prefix}/receipt.json`);
    const paid = JSON.parse(await read(`${prefix}/raw.txt`));
    const raw = r.modelCoordinates ? restoreModelCoordinates(paid,r.modelCoordinates) : paid;
    const m = promptBody(r), expanded = expand(r); requestMap.set(op.attemptId, r);
    assert.ok(receipt.usage, `Unknown usage: ${op.attemptId}`);
    assert.equal(receipt.usage.totalTokens, receipt.usage.inputTokens + receipt.usage.outputTokens);
    assert.deepEqual(op.receipt.usage, receipt.usage, 'Task receipt and disk receipt must agree');
    const candidates = d.candidates.filter(c => c.attemptId === op.attemptId);
    const currentSourceText = (r.source.sourceRows ?? []).map(row => row.text).join('');
    calls.push({attemptId:op.attemptId, stage:op.stage, packages:op.packageIds, finishMode:op.finishMode,
      transport:r.productionSnapshot?.transportVersion ?? 'legacy', usage:receipt.usage, durationMs:receipt.durationMs,
      totalActualChars:r.prompt.length + r.instructions.length + chars(r.schema), promptChars:r.prompt.length,
      schemaChars:chars(r.schema), instructionsChars:r.instructions.length, bodyChars:chars(m), sections:sizes(m),
      sourceSections:sizes(m.source), contextSections:sizes(m.source.context), retrievalFactSections:sizes(m.source.context?.retrievalFacts),
      currentSourceTextChars:currentSourceText.length, currentSourceRows:r.source.sourceRows.length,
      contextRows:r.source.contextRows?.length ?? 0, sentMaterials:expanded.productionMaterials?.map(x => ({id:x.id,name:x.value?.name,facts:x.value?.sourceFacts?.length ?? 0})) ?? [],
      factTableGroups:Object.fromEntries(Object.entries(m.source.context?.retrievalFacts?.groups ?? {}).map(([key,indices]) => [key,{
        rows:indices.length,chars:chars(indices.map(i => m.source.context.retrievalFacts.rows[Array.isArray(i)?i[0]:i]))
      }])),
      historicalCandidateCount:r.source.context?.retrievalFacts?.historicalEvidenceCandidates?.length ?? 0,
      suppliedAdoptedDesigns:r.productionSnapshot?.materials?.filter(x => x.value.adoptedDesign).length ?? 0,
      usedMaterialIds:raw.productionFeedback?.usedMaterialIds ?? [],
      loadedFiles:r.loadedFiles, errors:candidates.flatMap(c => c.errors ?? []), issues:op.issues,
      revisionNotes:raw.revisionNotes ?? [], candidateStatuses:candidates.map(c => c.status),
      previousDraftChars:chars(m.previousDraft), previousDraftRawTextChars:chars(m.previousDraft?.rawText),
    });
  }
  const draft = d.assembly.draft;
  const units = draft.units.map(u => ({id:u.id,title:u.title,seconds:u.shots.reduce((n,s) => n+s.duration,0),
    shots:u.shots.length,eventId:u.eventId,boundary:u.boundaryBefore,initialState:u.initialState,exitState:u.exitState,
    sourceRefCount:new Set(u.shots.flatMap(s => s.sourceRefs ?? [])).size,dialogue:spokenText(u,d.source)}));
  creativeText += `\n## ${side} 第${episode}集 ${id}\n\n幻想设置：${d.settings.fantasyMode}\n`;
  for (const u of draft.units) {
    creativeText += `\n### ${u.id} ${u.title}\n\n初态：${u.initialState}\n末态：${u.exitState}\n`;
    for (const s of u.shots) creativeText += `\n- ${s.id} (${s.duration}s)\n  - 机位：${s.camera}\n  - 画面：${s.picture}\n  - 光影：${s.lighting}\n  - 台词：${(s.dialogueParts ?? []).map(q => {
      const line = d.source.dialogue.find(x => x.id === q.lineId);
      return `${line?.speaker}/${line?.channel}/${q.presentation} ${q.text} [${q.voiceStart}-${q.voiceEnd}] ${q.delivery ?? ''}`;
    }).join('；')}\n`;
  }
  const allParts = draft.units.flatMap(u => u.shots.flatMap(s => s.dialogueParts));
  const dialogueChecks = d.source.dialogue.map(line => {
    const actual = allParts.filter(q => q.lineId === line.id).map(q => q.text).join('');
    return {lineId:line.id,speaker:line.speaker,exact:actual === line.quote,expected:line.quote,actual};
  });
  assert.ok(dialogueChecks.every(q => q.exact), `${side} EP${episode}: dialogue words must be retained once`);
  const partsHaveValidWindows = draft.units.every(u => u.shots.every(s => s.dialogueParts.every(q => q.voiceStart >= 0 && q.voiceEnd > q.voiceStart && q.voiceEnd <= s.duration)));
  assert.ok(partsHaveValidWindows);
  result.push({side,episode,id,status:d.status,settings:d.settings,choice:d.choice,operations:calls.length,
    totals:Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','totalTokens'].map(k => [k,sum(calls,k)])),
    totalSeconds:units.reduce((n,u) => n+u.seconds,0),units,shotCount:units.reduce((n,u) => n+u.shots,0),
    fantasy:draft.fantasyRealization,seriesDirection:d.source.context?.seriesDirection ?? null,
    seriesKnowledgeCount:d.source.context?.seriesKnowledge?.length ?? 0,production:d.production,calls,
    dialogueChecks,partsHaveValidWindows});
}
// Replay only feedback validation, with exact saved canonical coordinates and authority roles.
const firstPlanId = 'ba875dc5-9de2-4d61-aa35-1928d87d3077';
const firstPlanRequest = requestMap.get(firstPlanId);
const firstPlan = JSON.parse(await read(`.storyboard-stage3-v2/attempts/${firstPlanId}/raw.txt`));
let feedbackError = null;
try { validateProductionFeedback(firstPlan.productionFeedback, {...firstPlanRequest,plan:firstPlan}); }
catch (error) { feedbackError = {code:error.code,message:error.message}; }
assert.equal(feedbackError?.code, 'PRODUCTION_FEEDBACK');
const evidence = [...firstPlanRequest.source.sourceRows,...firstPlanRequest.source.contextRows,...boundaryEvidenceRows(firstPlanRequest.episodeBoundary)];
const spoken = new Set(firstPlanRequest.source.dialogue.flatMap(q => q.sourceIds ?? [q.rowId]));
const invalidSourceRefs = firstPlan.productionFeedback.entry.flatMap(state => state.authority !== 'SOURCE' ? [] : state.sourceRefs.flatMap(ref => {
  const row = evidence.find(row => row.id === ref);
  return !row || row.kind === 'guidance' || row.evidenceRole === 'guidance' || row.kind === 'dialogue' || spoken.has(ref)
    ? [{stateKey:state.key,ref,kind:row?.kind,evidenceRole:row?.evidenceRole,text:row?.text}] : [];
}));
// The material update was frozen into the first scoped editor pass. Determine its actual changed content.
const deltaRequest = requestMap.get('486afe26-6f8b-4d0e-89dd-bc1af87b405b');
const currentMaterials = deltaRequest.productionSnapshot.materials;
const materialChanges = [];
for (const attemptId of ['63d06917-3fdd-46de-89e8-7b01fe1d72a9','84457f51-744e-407b-a98f-105dfd41240a']) {
  const r = requestMap.get(attemptId), raw = JSON.parse(await read(`.storyboard-stage3-v2/attempts/${attemptId}/raw.txt`));
  const changed = changedConsumedMaterials(r.productionSnapshot.materials,currentMaterials,raw.productionFeedback.usedMaterialIds,r.source);
  const details = changed.map(id => {
    const before = r.productionSnapshot.materials.find(m => m.id === id), after = currentMaterials.find(m => m.id === id);
    const {sourceFacts:bf,...b} = before.value, {sourceFacts:af,...a} = after.value;
    const oldIds = new Set((bf ?? []).map(f => f.id)), added = (af ?? []).filter(f => !oldIds.has(f.id));
    return {id,name:after.value.name,onlySourceFactIndexChanged:JSON.stringify(b) === JSON.stringify(a),
      oldFacts:bf?.length ?? 0,newFacts:af?.length ?? 0,
      addedFactsAlreadyInCurrentRows:added.filter(f => r.source.sourceRows.some(row => row.text === f.quote)).length,
      addedFactsAlreadyInContextRows:added.filter(f => r.source.contextRows.some(row => row.text === f.quote)).length,
      addedFactsAlreadyInFullUnchangedEpisode:added.filter(f => documents.get('3008-2').source.sourceRows.some(row => row.text === f.quote)).length,
      addedFacts:added.map(f => ({claim:f.claim,quote:f.quote,evidence:f.evidence}))};
  });
  materialChanges.push({attemptId,packages:r.packageIds,changedIds:changed,details});
}
const sourceComparisons = [1,2].map(episode => {
  const old = rowsText(documents.get(`3007-${episode}`).source.sourceRows), next = rowsText(documents.get(`3008-${episode}`).source.sourceRows);
  const layoutOrAnnotation = text => /^第\s*\d+\s*集$/.test(text) || text === '【镜头切：竹林】';
  assert.deepEqual(old.filter(text => !layoutOrAnnotation(text)),next.filter(text => !layoutOrAnnotation(text)), 'Source body sequence must agree after title/annotation routing');
  const annotationRetained = episode !== 1 || documents.get('3008-1').source.contextRows.some(row => row.text.trim() === '【镜头切：竹林】');
  assert.ok(annotationRetained, 'The source bamboo cut must remain in readable annotations');
  return {episode,bodySequenceEqual:true,annotationRetained,onlyOldRows:old.filter(x => !next.includes(x)),onlyNewRows:next.filter(x => !old.includes(x))};
});
const comparisons = [1,2].map(episode => {
  const old = result.find(x => x.side === '3007' && x.episode === episode), next = result.find(x => x.side === '3008' && x.episode === episode);
  return {episode,oldTokens:old.totals.totalTokens,newTokens:next.totals.totalTokens,
    deltaTokens:next.totals.totalTokens-old.totals.totalTokens,
    increasePercent:100*(next.totals.totalTokens-old.totals.totalTokens)/old.totals.totalTokens,
    inputDelta:next.totals.inputTokens-old.totals.inputTokens,outputDelta:next.totals.outputTokens-old.totals.outputTokens,
    controlledFantasy:false};
});
for (const [file,before] of protectedFiles) assert.equal(hash(await readFile(file,'utf8')),before,`Source file changed: ${file}`);
const directory = await mkdtemp(path.join(root,'runtime-3008/stage3-two-episode-audit-'));
const report = {schema:'STAGE3_TWO_EPISODE_OFFLINE_AUDIT_V1',at:new Date().toISOString(),providerCalls:0,productionWrites:0,
  protectedFilesChecked:protectedFiles.size,characterMeasure:'JSON UTF-16 characters, NOT field Token attribution',
  samples:result,comparisons,sourceComparisons,feedbackError,invalidSourceRefs,materialChanges};
await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
await writeFile(path.join(directory,'creative-review.md'),creativeText);
console.log(JSON.stringify({directory,providerCalls:0,productionWrites:0,protectedFilesChecked:protectedFiles.size,
  comparisons,sourceComparisons,feedbackError,invalidSourceRefs,
  materialChanges:materialChanges.map(x => ({packages:x.packages,changedCards:x.details.length,
    onlySourceFactIndexChanged:x.details.every(d => d.onlySourceFactIndexChanged)})),
  samples:result.map(s => ({side:s.side,episode:s.episode,totals:s.totals,operations:s.operations,
    units:s.units.length,shots:s.shotCount,seconds:s.totalSeconds,dialogueExact:s.dialogueChecks.every(q => q.exact),validVoiceWindows:s.partsHaveValidWindows}))},null,2));
