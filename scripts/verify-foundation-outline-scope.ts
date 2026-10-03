import assert from 'node:assert/strict';
import {buildFoundationFacts} from '../lib/foundation-facts';
const text='规则：编号条目不表示分集。\n1.白天可以进山。\n分集概括：\n1.甲尚不知真相。\n2.甲调查乙。\n30.甲揭开秘密。\n人物小传：\n1.甲二十岁。\n';
const context:any={version:'ctx',background:[{key:'a',text}]},index:any={version:'src',episodes:[{number:1,content:'甲：出发。'}]};
const store=buildFoundationFacts(index,context,null);
const outlines=store.facts.filter(f=>(f as any).contextUse);
assert.deepEqual(outlines.map(f=>(f as any).contextUse.episode),[1,2,30]);
for(const fact of outlines){const h=(fact as any).contextUse.heading;assert.equal(h.quote,text.slice(h.start,h.end));assert.equal(fact.statement,text.slice(fact.evidence.start,fact.evidence.end));}
assert.ok(store.facts.find(f=>f.statement.includes('白天可以进山')&&!(f as any).contextUse));
assert.ok(store.facts.find(f=>f.statement.includes('二十岁')&&!(f as any).contextUse));
process.stdout.write('foundation outline source-coordinate scope passed\n');
const variants='分集大纲：\n第一集：甲出发。\n２．乙抵达。\n制作约束：\n1.门只能从内部打开。\n';
const varied=buildFoundationFacts(index,{...context,background:[{key:'a',text:variants}]},null);
assert.deepEqual(varied.facts.filter(f=>f.contextUse).map(f=>f.contextUse!.episode),[1,2]);
assert.ok(varied.facts.find(f=>f.statement.includes('内部打开')&&!f.contextUse),'a new section must not turn a production rule into an episode outline');
