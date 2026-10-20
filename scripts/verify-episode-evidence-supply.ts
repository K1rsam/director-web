/** Offline regression: episode-oriented evidence, not a whole-series dialogue replay. */
import assert from 'node:assert/strict';
import { buildSourceIndex } from '../lib/project-foundation-contracts';
import { buildFoundationFacts, selectFoundationFacts } from '../lib/foundation-facts';

const episodes = Array.from({length: 80}, (_, at) => ({number: at + 1, title: null,
  content: `${at + 1}-1 房间 日 内\n` + Array.from({length: 24}, (_, n) => `林岚：第${at + 1}次闲聊，第${n}句话。\n`).join('')}));
episodes[1].content += '△林岚右臂骨折，固定带缠在手臂上。\n';
episodes[9].content += '△林岚取下固定带，伤已经治好了。\n';
episodes[11].content += '林岚是程野的姐姐。\n林岚的身份是监察员。\n林岚知道程野藏起了钥匙。\n林岚：我不知道密码，你必须相信我。\n';
episodes[77].content += '△林岚递给程野一把钥匙。\n程野：谢谢。\n';
episodes[78].content = '79-1 房间 日 内\n林岚：程野，开门吧。\n';
episodes[79].content += '△林岚一个月后又受了伤。\n';
const index = buildSourceIndex(episodes);
const context: any = {version: 'evidence-synthetic', background: [{key: 'author', text:
  '规则：门只有持钥匙者能打开。\n分集概括：\n80集：林岚得知未来真相。\n'}]};
const store = buildFoundationFacts(index, context, null, {standard: true}), before = structuredClone(store);
const full = selectFoundationFacts(store, index, [79]);
const selected = selectFoundationFacts(store, index, [79], {historyMode: 'episode'});
assert.ok(selected.historicalEvidenceCandidates.length < full.historicalEvidenceCandidates.length / 5,
  '单集不能仍携带七十多集的人物旧对白');
assert.ok(!selected.historicalEvidenceCandidates.some((f: any) => f.evidence.episode === 1 && f.kind === 'UTTERANCE'),
  '人物同名不是全量旧对白的读取理由');
for (const phrase of ['骨折', '治好了', '姐姐', '监察员', '藏起了钥匙', '不知道密码', '递给']) {
  const f = selected.historicalEvidenceCandidates.find((f: any) => f.statement.includes(phrase));
  assert.ok(f, `缺少必要证据 ${phrase}`);
  assert.equal(f.statement, index.episodes.find(e => e.number === f.evidence.episode)!.content.slice(f.evidence.start, f.evidence.end));
  assert.equal(f.currentApplicability, 'UNKNOWN', '检索不能擅自确认为本集状态');
}
assert.equal(selected.historicalEvidenceCandidates.find(f => f.statement.includes('不知道密码'))?.claim, 'CHARACTER_CLAIM');
assert.ok(!selected.historicalEvidenceCandidates.some((f: any) => f.evidence.episode >= 79));
assert.ok(!selected.background.some((f: any) => f.contextUse?.episode === 80), '未来分集大纲不提前投递');
assert.deepEqual(store, before, '不改来源库、未知有效期或已保存原文');
const requested = store.facts.find(f => f.evidence.episode === 1 && f.kind === 'UTTERANCE')!;
const expanded = selectFoundationFacts(store, index, [79], {historyMode: 'episode', requestedEvidence: [requested.evidence]});
assert.ok(expanded.historicalEvidenceCandidates.some((f: any) => f.id === requested.id), '局部补读能从索引恢复被省略的旧原句');
assert.ok(expanded.historicalEvidenceCandidates.length < full.historicalEvidenceCandidates.length / 5);
console.log(JSON.stringify({status: 'PASS', fullRows: full.historicalEvidenceCandidates.length,
  episodeRows: selected.historicalEvidenceCandidates.length, fullChars: JSON.stringify(full).length,
  episodeChars: JSON.stringify(selected).length, providerCalls: 0}));
