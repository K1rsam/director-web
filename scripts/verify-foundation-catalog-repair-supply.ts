import assert from 'node:assert/strict';
import { collectFoundationPublicationIssues } from '@/lib/foundation-state';
import { buildProductionFoundationPrompt, PRODUCTION_OUTPUT_SCHEMAS } from '@/lib/foundation-production-prompts';
import { requireProductionCatalogAuthor } from '@/lib/foundation-production-contracts';
import { buildSourceIndex } from '@/lib/project-foundation-contracts';

const index = buildSourceIndex([0, 1].map(number => ({ number, title: null, content: '器物及状态待核。' })));
const catalog = requireProductionCatalogAuthor({
  format: 'ASSET_CATALOG_V2', coverage: [0, 1],
  assets: [{ name: '器物', type: 'PROP', episodes: [0], preparation: { mode: 'REFERENCE' },
    variants: [{ name: '破碎状态', episodes: [0, 1], note: '保存待核原范围，不宣称额外入镜', preparation: { mode: 'DERIVE' } }] }],
}, index, [0, 1]);
const before = JSON.stringify(catalog);
const issues = collectFoundationPublicationIssues(catalog);
assert.equal(issues.filter(issue => issue.owner === 'PROGRAM' && issue.severity !== 'MINOR').length, 1, 'unresolved receiver repairs must block publication even when preparations are valid');
assert.ok(issues[0].coordinate.includes(catalog.assets[0].key));
assert.equal(JSON.stringify(catalog), before);
assert.ok('resolvedCatalogIssues' in PRODUCTION_OUTPUT_SCHEMAS.Q1, 'Q1 must explicitly acknowledge a supported local repair');
const prompt = buildProductionFoundationPrompt('Q1', { candidates: { f2: catalog } });
assert.match(prompt, /resolvedCatalogIssues/);
assert.match(prompt, /暂存.*不代表/);
assert.match(prompt, /repairItems/);
assert.equal(JSON.stringify(catalog), before);
console.log('PASS repair supply: program issues block approval, Q1 method requires explicit repair, original declarations preserved (not model quality)');
