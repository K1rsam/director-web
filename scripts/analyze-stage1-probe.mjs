/** Zero-model inspection of a completed probe. Writes analysis only, never the saved responses. */
import fs from 'node:fs';
import path from 'node:path';
import { makeEpisodeInput } from '../runtime/storyboard-v4/input.mjs';
import { buildRequest } from '../runtime/storyboard-v4/core/core.mjs';
import { projectRetrievalFacts } from '../runtime/storyboard-v4/core/fact-projection.mjs';

const directory = path.resolve(process.argv[2] || '');
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const manifest = read('manifest.json');
if (manifest.schema !== 'STAGE1_PROBE_V1' || !manifest.live) throw Error('Expected an existing live probe; no calls are started here.');
const summary = read('summary.json'), calls = read('calls.json');
const episodes = read('final-episodes.json'), handoffs = read('handoff-packets.json');
const chars = value => JSON.stringify(value).length;
const totals = Object.fromEntries(['inputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'].map(key => [key, calls.every(c => Number.isFinite(c.usage?.[key])) ? calls.reduce((sum, c) => sum + c.usage[key], 0) : null]));
const requestMetrics = calls.map(call => {
  const request = read(`${call.number}-${call.stage}-request.json`);
  const split = request.taskPrompt.indexOf('INPUT_JSON:\n');
  const business = split >= 0 ? JSON.parse(request.taskPrompt.slice(split + 'INPUT_JSON:\n'.length)) : null;
  return { stage: call.stage, systemChars: request.systemChars, taskChars: request.taskChars, sentChars: request.sentChars,
    fixedTaskPrefixChars: split >= 0 ? split : null, inputJsonChars: business ? chars(business) : null,
    topLevelValueChars: business ? Object.fromEntries(Object.entries(business).map(([key, value]) => [key, chars(value)])) : null,
    rawSourceOccurrences: business?.source?.episodes?.map(e => ({ number: e.number, lineCount: e.lines.length, sourceChars: e.lines.reduce((n, line) => n + line[1].length, 0) })) ?? null };
});
const inspections = episodes.map(episode => {
  const handoff = handoffs.find(item => item.packet?.episode === episode.number);
  const prepared = makeEpisodeInput({ episode: { ...episode, projectId: summary.projectId }, project: { id: summary.projectId, style: '3D国漫', aspectRatio: '16:9' }, handoff });
  const source = prepared.source, facts = source.context.retrievalFacts;
  let planRequest;
  try {
    const request = buildRequest({ stage: 'plan', source, settings: { fantasyMode: 'off', maxUnits: null, visualStyle: prepared.visualStyle } });
    const marker = '\n\n【生效设置与本次完整资料】\n';
    const modelInput = JSON.parse(request.prompt.slice(request.prompt.indexOf(marker) + marker.length));
    planRequest = { status: 'BUILDABLE_ONLY_NOT_SENT', chars: request.prompt.length, modelInputChars: chars(modelInput),
      retrievalFactsChars: chars(modelInput.source.context.retrievalFacts), retrievalFactsIncludedExactly: JSON.stringify(modelInput.source.context.retrievalFacts) === JSON.stringify(facts),
      retrievalFactsMatchExpectedProjection: JSON.stringify(modelInput.source.context.retrievalFacts) === JSON.stringify(projectRetrievalFacts(facts)) };
  } catch (error) { planRequest = { status: 'BLOCKED_BEFORE_MODEL', code: error.code, message: error.message }; }
  const ids = new Set((facts?.sourceFactIndex || []).map(f => f.id));
  const duplicateCurrent = (facts?.current || []).filter(f => ids.has(f.id));
  const backgroundIds = new Set((facts?.backgroundCandidates || []).map(f => f.id));
  const duplicateBackground = (facts?.unlinkedBackground || []).filter(f => backgroundIds.has(f.id));
  return { episode: episode.number, readiness: prepared.readiness, warnings: prepared.warnings, sourceUnchangedFromEpisode: handoff.packet.sourceText === episode.content,
    sourceChars: episode.content.length, packetChars: chars(handoff.packet), retrievalFactsChars: chars(facts),
    packetFieldValueChars: Object.fromEntries(Object.entries(handoff.packet).map(([key, value]) => [key, chars(value)])),
    factGroups: Object.fromEntries(Object.entries(facts).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, { count: value.length, chars: chars(value) }])),
    repeatedFactObjects: { currentAlreadyInSourceFactIndex: duplicateCurrent.length, currentArrayChars: chars(duplicateCurrent), unlinkedAlreadyInBackgroundCandidates: duplicateBackground.length, unlinkedArrayChars: chars(duplicateBackground) },
    knownFalseSpeakersInFactHints: [...new Set(facts.sourceFactIndex.filter(f => f.kind === 'UTTERANCE').flatMap(f => f.subjects).filter(name => ['第一集', '第二集', '出场人物', '你刚才说'].includes(name)))],
    dialogue: source.dialogue.map(({ speaker, channel, cue, quote }) => ({ speaker, channel, cue, quote })),
    diagnostics: source.diagnostics.map(item => ({ ...item, text: source.sourceRows.find(row => row.id === item.rowId)?.text })),
    contextRowCount: source.contextRows.length, entryFactCount: source.entryFacts.length,
    scenes: handoff.packet.scenes.map(({ sceneKey, characters }) => ({ sceneKey, characters })),
    assets: handoff.packet.assets.map(({ key, name, type, variants }) => ({ key, name, type, variants: variants.map(({ name, sceneRefs, preparation }) => ({ name, sceneRefs, preparation })) })),
    boundarySummary: handoff.packet.boundaryContext ? { previousScene: handoff.packet.boundaryContext.previousSource.sceneKey, clipped: handoff.packet.boundaryContext.previousSource.clipped, priorStates: handoff.packet.boundaryContext.priorStates.map(a => a.name) } : null,
    confirmedSeriesDirectionPresent: Object.hasOwn(source.context, 'seriesDirection'), planRequest };
});
const result = { schema: 'STAGE1_PROBE_ANALYSIS_V1', directory, noAdditionalModelCalls: true,
  testBoundary: 'One synthetic baseline, two episodes; semantic judgments still require human review; new upstream modules not wired.',
  pipelineStatus: summary.status, sourceUnchanged: summary.sourceUnchanged, episodeCount: episodes.length,
  durationMs: Date.parse(summary.finishedAt) - Date.parse(summary.startedAt), modelCalls: calls.length, repairCalls: calls.filter(c => c.repair).length,
  usage: totals, requestMetrics, inspections,
  note: 'UTF-16/JSON character lengths are not token counts. Cached input is included in total input; reasoning is included in output. Third-stage prompts are only built in memory, never sent.' };
const output = path.join(directory, 'analysis-v1.json');
if (fs.existsSync(output)) throw Error('Analysis already exists; preserve it and create a new version for revisions.');
fs.writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ output, pipelineStatus: result.pipelineStatus, durationMs: result.durationMs, usage: result.usage,
  downstream: inspections.map(({ episode, readiness, diagnostics, planRequest }) => ({ episode, readiness, diagnosticCount: diagnostics.length, planRequest })) }, null, 2));
