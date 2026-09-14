import assert from 'node:assert/strict';
import { buildFoundationFacts, selectFoundationFacts } from '../lib/foundation-facts';
import { buildSourceIndex } from '../lib/project-foundation-contracts';
import type { FoundationSourceContext } from '../lib/foundation-source';
const index = buildSourceIndex([{ number: 1, title: '第1集', content: '第1集\n1-1 日 外 门口\n甲乙：你好。\n' }]);
const headings = ['第 0 集', '第零集', '第〇集', '第十二集', '第一百二十四集', '第 ２４ 集', '24集', '## 第三十集', 'Episode 0', 'episode 24', 'EP0', 'Ep. 12', 'Episode Zero', 'Episode One', '# Episode 12：', '作者资料', '第0集：人物设定', '【人物小传】', '【30 集段纲】', '[三十集段纲]', '（故事梗概）', '## 【背景资料】'];
const prose = ['第零集发生事故。', '第 0 集 发生事故。', '第12集：院长离开。', '第零集内容尚未归属', 'Episode 0 begins with a storm.', 'Episode One: A visitor arrives.', 'Episode begins', 'EP12事故', '24集以后发生事故。', '0', '人物设定包含一封匿名信。', '蓝色笔记。', '尚未关联的匿名背景。', '【人物小传】甲乙失踪。', '【30 集段纲】后山发生事故', '【人物小传]', '30集段纲中发生事故'];
const raw = [...headings, ...prose].map((line, index) => line + (index % 2 ? '\n' : '\r\n')).join('');
const context: FoundationSourceContext = { version: 'format-context', background: [{ key: 'background', text: raw }], unresolved: [], issues: [], notices: [], complete: true, coverage: 'COMPLETE' };
const facts = buildFoundationFacts(index, context, null);
const background = facts.facts.filter(fact => fact.evidence.domain === 'CONTEXT');
assert.deepEqual(background.filter(fact => fact.kind === 'FORMAT').map(fact => fact.statement.trim()), headings, 'only exact standalone format headings are excluded from unresolved facts');
for (const text of prose) assert.notEqual(background.find(fact => fact.statement.trim() === text)!.kind, 'FORMAT', text);
const selected = selectFoundationFacts(facts, index, [1]);
assert(selected.unlinkedBackgroundCount > 0, 'real anonymous background remains available as unlinked evidence');
assert(selected.backgroundCandidates.some(fact => fact.statement.includes('蓝色笔记')));
assert(selected.backgroundCandidates.some(fact => fact.statement.includes('尚未关联的匿名背景')));
assert(selected.backgroundCandidates.every(fact => !headings.includes(fact.statement.trim())));
for (const fact of background) assert.equal(fact.statement, raw.slice(fact.evidence.start, fact.evidence.end), 'classification does not rewrite source or shift coordinates');
assert.equal(background.map(fact => fact.statement).join(''), raw);
assert.equal(facts.facts.find(fact => fact.evidence.domain === 'EPISODE' && fact.statement === '第1集\n')!.kind, 'SETTING', 'episode-domain extraction is unchanged');
for(const [titleText, expected] of [
  ['山城寻影\n\n第 0 集\n上线备用剧名：《山城寻影》《另一剧名》\n', 'FORMAT'],
  ['山城寻影\n剧本名称：山城寻影\n', 'FORMAT'],
  ['山城发生事故\n剧本名称：另一剧名\n', 'CONTEXT'],
  ['山城发生事故\n这是无标点的真实匿名叙事\n', 'CONTEXT'],
  ['甲乙：走吧\n剧名：甲乙：走吧\n', 'UTTERANCE'],
] as const){
  const sample=buildFoundationFacts(index,{...context,background:[{key:'title-source',text:titleText}]},null);
  const first=sample.facts.find(f=>f.evidence.domain==='CONTEXT')!;
  assert.equal(first.kind,expected);
  assert.equal(first.statement,titleText.slice(first.evidence.start,first.evidence.end));
  if(expected==='FORMAT') assert(!selectFoundationFacts(sample,index,[1]).backgroundCandidates.some(f=>f.id===first.id));
}
console.log('PASS pure Chinese/numeric/English episode headings; prose and anonymous background retained; source/CRLF/ranges preserved');
