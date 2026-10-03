import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {compileStandardScript, createSourceIndex} from '../lib/standard-script';
import type {SourceIndex, SourcePart, StandardScriptEntry, StandardScriptPlan} from '../lib/standard-script';

const part = (index: SourceIndex, line: number, start: number, end: number): SourcePart => ({
  kind: /^[\t \r\n]+$/.test(index.text.slice(start, end)) ? 'SOURCE_SEPARATOR' : 'SOURCE_SLICE',
  unitId: index.units[line].id, start, end,
});
const planFor = (index: SourceIndex, entry: StandardScriptEntry): StandardScriptPlan => ({
  schemaVersion: 'STANDARD_SCRIPT_PLAN_V1', sourceId: index.sourceId, sourceVersion: index.sourceVersion, entries: [entry],
});

async function main() {
  const compilerFailures: string[] = [];
  for (const label of ['filled triangle', 'split dialogue header', 'voice and cue separator']) {
    const raw = label === 'filled triangle' ? '▲起身。\n' : label === 'split dialogue header' ? '甲：\r\n你好。\r\n' : '甲（VO，对讲机声）：嗯。\n';
    const index = createSourceIndex(raw, label);
    let entry: StandardScriptEntry;
    if (label === 'filled triangle') {
      entry = {id: 'e1', target: 'BODY', kind: 'ACTION', unitIds: [index.units[0].id],
        parts: [part(index, 0, 1, raw.length - 1)], layout: [part(index, 0, 0, 1), part(index, 0, raw.length - 1, raw.length)]};
    } else if (label === 'split dialogue header') {
      entry = {id: 'e1', target: 'BODY', kind: 'DIALOGUE', channel: 'SPEECH', unitIds: index.units.map(unit => unit.id),
        speaker: [part(index, 0, 0, 1)], parts: [part(index, 1, 4, 7)], layout: [part(index, 0, 1, 4), part(index, 1, 7, 9)]};
    } else {
      const cueStart = raw.indexOf('对'), cueEnd = raw.indexOf('）'), bodyStart = raw.indexOf('嗯');
      entry = {id: 'e1', target: 'BODY', kind: 'DIALOGUE', channel: 'VO', unitIds: [index.units[0].id], speaker: [part(index, 0, 0, 1)],
        channelSource: [part(index, 0, 2, 4)], cue: [part(index, 0, cueStart, cueEnd)], parts: [part(index, 0, bodyStart, raw.length - 1)],
        layout: [part(index, 0, 1, 2), part(index, 0, 4, cueStart), part(index, 0, cueEnd, bodyStart), part(index, 0, raw.length - 1, raw.length)]};
    }
    try {compileStandardScript(index, planFor(index, entry));} catch (error) {compilerFailures.push(`${label}: ${(error as Error).message}`);}
  }
  assert.deepEqual(compilerFailures, [], 'compiler must preserve explicit outer layout without inserting it into spoken text');
  const leadingComma = createSourceIndex(',甲（VO）：嗯。\n', 'leading-comma');
  assert.throws(() => compileStandardScript(leadingComma, planFor(leadingComma, {
    id: 'e1', target: 'BODY', kind: 'DIALOGUE', channel: 'VO', unitIds: [leadingComma.units[0].id],
    speaker: [part(leadingComma, 0, 1, 2)], channelSource: [part(leadingComma, 0, 3, 5)], parts: [part(leadingComma, 0, 7, 9)],
    layout: [part(leadingComma, 0, 0, 1), part(leadingComma, 0, 2, 3), part(leadingComma, 0, 5, 7), part(leadingComma, 0, 9, 10)],
  })), /DIALOGUE_PREFIX_BOUNDARY/, 'comma layout is allowed between header fields, never before the first field');
  assert.ok(existsSync('lib/standard-script-plan.ts'), 'RED: deterministic standard-script plan preparer is missing');
  const {prepareStandardEpisode, deriveStandardScriptLines} = await import('../lib/standard-script-plan');
  // Frozen pre-upstream grammar retains all historical rejection and receipt assertions.
  const prepare = (raw: string) => prepareStandardEpisode(raw, 'synthetic', {syntax: 'legacy'});
  const successful = (raw: string) => {
    const result = prepare(raw);
    assert.deepEqual(result.diagnostics, [], raw);
    assert.ok(result.compiled, raw);
    assert.equal(result.index.text, raw);
    assert.equal(result.index.units.map(unit => unit.text).join(''), raw);
    assert.deepEqual(result.plan.entries.flatMap(entry => entry.unitIds), result.index.units.map(unit => unit.id));
    assert.equal(result.compiled.receipt.semantic, 'NOT_RUN');
    assert.equal(result.compiled.receipt.acceptedForDispatch, false);
    assert.deepEqual(deriveStandardScriptLines(result).map(line => line.text).join(''), raw);
    assert.deepEqual(prepare(raw), result, 'same source and identity produce the same plan and receipt');
    return result;
  };

  for (const eol of ['\n', '\r\n', '\r']) {
    const raw = ['第一集：借来的钥匙', '1-1 后台 日 内', '出场人物：林岚、程野', '林岚（压低声音）：', '你刚才说：“借你一天：明早还我。”', '现在又催？', '', '程野：我催的是午饭。', '△林岚收起钥匙。', '导演处理：先看手部。', '连续性备注：钥匙仍在右袋。', '情绪备注：不能直接断言喜欢。', '▲程野离开。', ''].join(eol);
    const result = successful(raw);
    const dialogues = result.compiled!.package.script.entries.filter(entry => entry.kind === 'DIALOGUE');
    assert.equal(dialogues.length, 2);
    assert.equal(dialogues[0].speaker?.text, '林岚');
    assert.equal(dialogues[0].cue?.text, '压低声音');
    assert.equal(dialogues[0].text, `你刚才说：“借你一天：明早还我。”${eol}现在又催？`);
    assert.equal(result.compiled!.package.annotations.length, 3);
    assert.equal(result.compiled!.package.script.entries.at(-1)?.text, '程野离开。');
    const lines = deriveStandardScriptLines(result);
    assert.equal(lines[4].speaker, '林岚');
    assert.equal(lines[4].entryId, lines[5].entryId);
    assert.equal(lines[9].target, 'ANNOTATION');
    assert.equal(lines[6].kind, 'BLANK');
  }

  const voices = successful('出场人物：林岚、陈叔\n林岚（OS）：原来他还记得。\n陈叔（VO，对讲机声）：后台谁锁？\n林岚（低声,VO）：我来。');
  const voiceLines = voices.compiled!.package.script.entries.filter(entry => entry.kind === 'DIALOGUE');
  assert.deepEqual(voiceLines.map(entry => entry.channel), ['OS', 'VO', 'VO']);
  assert.deepEqual(voiceLines.map(entry => entry.channelSource?.text), ['OS', 'VO', 'VO']);
  assert.deepEqual(voiceLines.map(entry => entry.cue?.text ?? null), [null, '对讲机声', '低声']);
  assert.equal(successful('出场人物：甲\n甲：：我说的是字面\\n，不是真换行。').compiled!.package.script.entries.at(-1)?.text, '：我说的是字面\\n，不是真换行。');
  assert.equal(successful('出场人物：甲\n甲\n真的？\n我还没走。').compiled!.package.script.entries.at(-1)?.text, '真的？\n我还没走。');
  assert.equal(successful('出场人物：甲\n甲：\n头一句。\n\n尾一句。').compiled!.package.script.entries.at(-1)?.text, '头一句。\n\n尾一句。');
  assert.equal(successful('出场人物：甲\n甲：“不要走。\n明天再说。”').compiled!.package.script.entries.at(-1)?.text, '“不要走。\n明天再说。”');
  assert.equal(successful('灯光渐暗。').compiled!.package.script.entries[0].kind, 'ACTION');
  assert.equal(successful('\uFEFF第一集：开端\n△甲看着😀。').compiled!.package.script.entries.at(-1)?.text, '甲看着😀。');
  assert.equal(prepareStandardEpisode('林岚：不能猜出但已提供姓名。', 'known', {knownSpeakers: ['林岚']}).compiled?.package.script.entries[0].speaker?.text, '林岚');
  assert.equal(prepare('林岚：未提供姓名依据。').compiled, null, 'bare colon labels require declared speaker evidence');
  for (const cast of ['人物', '角色', '出场人物']) {
    const metadata = ['时间：夜', '地点：旧牢房', '场景：走廊', '天气：雨', '内外：内', '时间层：现实', '道具：钥匙'];
    const result = successful(['第七集', '7-1 日 内 旧牢房', `${cast} ：甲、乙`, ...metadata, '甲：时间：明天；地点：后台。'].join('\r\n'));
    assert.equal(result.compiled!.package.script.entries.filter(entry => entry.kind === 'SCENE_METADATA').length, 8);
    assert.equal(result.compiled!.package.script.entries.at(-1)?.speaker?.text, '甲');
    assert.equal(result.compiled!.package.script.entries.at(-1)?.text, '时间：明天；地点：后台。');
    assert.ok(!result.compiled!.package.script.entries.some(entry => entry.speaker?.text === cast));
  }
  const grammarFailures: string[] = [];
  const checkGrammar = (label: string, check: () => void) => {try {check();} catch {grammarFailures.push(label);}};
  checkGrammar('unknown inline second speaker must block', () => assert.equal(prepare('出场人物：甲\n甲：你好。乙：再见。').compiled, null));
  checkGrammar('completed inline utterance cannot swallow unmarked action', () => assert.equal(prepare('出场人物：甲\n甲：我在。\n灯光渐暗。').compiled, null));
  checkGrammar('lowercase OS preserves source but uses OS channel', () => {
    const entry = prepare('甲（os）：心里话。').compiled?.package.script.entries[0];
    assert.equal(entry?.channel, 'OS'); assert.equal(entry?.channelSource?.text, 'os');
  });
  checkGrammar('explicit audio roles do not require physical character assets', () => assert.deepEqual(
    prepare('旁白：门关了。\n画外音：谁在里面？\n系统音：叮。').compiled?.package.script.entries.map(entry => entry.channel), ['NARRATION', 'VO', 'SYSTEM']));
  checkGrammar('episode heading requires a token boundary after 集', () => assert.equal(prepare('第十集团军的士兵冲进院子。\n△林岚关上窗。').compiled?.package.script.entries[0].kind, 'ACTION'));
  checkGrammar('space-delimited voice token cannot become on-camera speech', () => {
    const entry = prepare('甲（OS 低声）：这句话只在心里。').compiled?.package.script.entries[0];
    assert.equal(entry?.channel, 'OS'); assert.equal(entry?.channelSource?.text, 'OS'); assert.equal(entry?.cue?.text, '低声');
  });
  checkGrammar('arbitrary parenthetical cue is not speaker evidence', () => assert.equal(prepare('注意事项（保密）：不要外传。\n△甲入屋。').compiled, null));
  checkGrammar('undeclared ordinary cue must block', () => assert.equal(prepare('甲（低声）：你好。').compiled, null));
  checkGrammar('closed whole-utterance quotes stop unmarked continuation', () => assert.equal(prepare('人物：甲\n甲：\n“再见。”\n灯光渐暗。').compiled, null));
  checkGrammar('inline ellipsis stops unmarked continuation', () => assert.equal(prepare('人物：甲\n甲：我在……\n灯光渐暗。').compiled, null));
  checkGrammar('comma or whitespace before unknown second speaker must block', () => {
    for (const separator of ['，', ',', '；', ';', ' ', '\t']) assert.equal(prepare(`人物：甲\n甲：你好${separator}乙：再见。`).compiled, null);
  });
  assert.deepEqual(grammarFailures, [], 'syntax ambiguities must not be silently accepted');
  assert.equal(successful('人物：甲\n甲：时间：明天').compiled!.package.script.entries.at(-1)?.text, '时间：明天');
  assert.equal(successful('人物：甲\n甲： 时间：明天').compiled!.package.script.entries.at(-1)?.text, '时间：明天');
  assert.equal(successful('人物：甲\n甲：他说：“你好，乙：再见。”').compiled!.package.script.entries.at(-1)?.text, '他说：“你好，乙：再见。”');
  const knownCue = prepareStandardEpisode('甲（低声）：你好。', 'known-cue', {knownSpeakers: ['甲']});
  assert.equal(knownCue.compiled?.package.script.entries[0].channel, 'SPEECH');
  assert.equal(knownCue.compiled?.package.script.entries[0].cue?.text, '低声');
  const spacedVoice = successful('甲（vo\t低声）：声音来自画外。');
  assert.equal(spacedVoice.compiled!.package.script.entries[0].channel, 'VO');
  assert.equal(spacedVoice.compiled!.package.script.entries[0].channelSource?.text, 'vo');

  const probe = successful(readFileSync('examples/stage1-probe-v1/source.txt', 'utf8'));
  assert.equal(probe.compiled!.package.script.entries.filter(entry => entry.kind === 'EPISODE_HEADING').length, 2);
  assert.equal(probe.compiled!.package.script.entries.filter(entry => entry.kind === 'DIALOGUE').length, 7);
  assert.equal(probe.compiled!.package.annotations.length, 1, 'author material stays auxiliary, not production action');
  assert.ok(!deriveStandardScriptLines(probe).some(line => line.speaker === '你刚才说'));

  const rejected: Array<[string, number, string]> = [
    ['第一集\n：没有说者。', 2, 'MISSING_SPEAKER'],
    ['第一集\n（低声）：没有说者。', 2, 'MISSING_SPEAKER'],
    ['第一集\n注意事项：不可猜成角色。', 2, 'UNKNOWN_COLON_LINE'],
    ['出场人物：甲\n甲：\n△他起身。', 2, 'EMPTY_DIALOGUE'],
    ['出场人物：甲\n甲（OS,VO）：未知混合声道。', 2, 'AMBIGUOUS_CHANNEL'],
    ['第一集\n【未知提示】不得降级为动作。', 2, 'UNKNOWN_TYPED_LINE'],
    ['第一集\n[未知提示]不得降级为动作。', 2, 'UNKNOWN_TYPED_LINE'],
    ['出场人物：甲、乙\n甲：你好\n乙转身离开。', 3, 'AMBIGUOUS_CONTINUATION'],
    ['出场人物：甲\n甲：你好。乙：再见。', 2, 'MULTIPLE_SPEAKERS_ON_LINE'],
    ['出场人物：甲\n甲：我在。\n灯光渐暗。', 3, 'AMBIGUOUS_CONTINUATION'],
    ['出场人物：甲\n甲：头一句。\n\n尾一句。', 4, 'AMBIGUOUS_CONTINUATION'],
    ['注意事项（保密）：不要外传。\n△甲入屋。', 1, 'UNKNOWN_SPEAKER'],
    ['甲（低声）：你好。', 1, 'UNKNOWN_SPEAKER'],
    ['甲（低声）\n你好。', 1, 'UNKNOWN_SPEAKER'],
    ['人物：甲\n甲：\n“再见。”\n灯光渐暗。', 4, 'AMBIGUOUS_CONTINUATION'],
    ['人物：甲\n甲：我在……\n灯光渐暗。', 3, 'AMBIGUOUS_CONTINUATION'],
    ['人物：甲\n甲：你好，乙：再见。', 2, 'MULTIPLE_SPEAKERS_ON_LINE'],
    ['人物：甲\n甲：你好 乙：再见。', 2, 'MULTIPLE_SPEAKERS_ON_LINE'],
    ['', 1, 'EMPTY_SOURCE'],
  ];
  for (const raw of ['出场人物：甲、乙\n甲：你好。乙：再见。', '出场人物：甲、乙\n甲：你好。 乙：再见。']) {
    const explicit = successful(raw);
    assert.equal(explicit.compiled!.package.script.entries.at(-1)?.kind, 'DIALOGUE_GROUP', '明确双说者升级为保真子目录，不撤掉未知与歧义保护');
    assert.equal(explicit.compiled!.package.schemaVersion, 'DIRECTOR_STANDARD_SCRIPT_SLICE_V2');
  }
  for (const [raw, line, code] of rejected) {
    const result = prepare(raw);
    assert.equal(result.compiled === null, true, raw);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.line === line && diagnostic.code === code), JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.every(diagnostic => diagnostic.message.length > 0));
    assert.equal(result.index.text, raw);
    if (raw) assert.ok(deriveStandardScriptLines(result).some(item => item.target === 'UNRESOLVED'));
  }
  const comma = successful('出场人物：甲\n甲：别走，等我。');
  const corrupt = structuredClone(comma.plan);
  const dialogue = corrupt.entries.at(-1)!;
  assert.equal(dialogue.target, 'BODY');
  if (dialogue.target !== 'BODY') throw new Error('unreachable');
  const original = dialogue.parts[0], commaStart = comma.index.text.indexOf('，');
  dialogue.parts.splice(0, 1, {...original, end: commaStart}, {...original, start: commaStart + 1});
  dialogue.layout.push({...original, start: commaStart, end: commaStart + 1});
  assert.throws(() => compileStandardScript(comma.index, corrupt), /TEXT_GAP/, 'body comma is not removable layout');
  console.log(`PASS standard-script-plan: 3 compiler boundary regressions; LF/CRLF/CR, multiline dialogue, voice/cue, annotations, exact literal escapes, 2-episode probe, ${rejected.length} blocking cases; 0 DB/network/model calls`);
}
main().catch(error => {console.error(error); process.exitCode = 1;});
