import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

/** Exercise the public assembler with independently changing read snapshots, never real DB/model/network. */
async function main() {
  const require = createRequire(import.meta.url);
  const modules = ['../lib/light-foundation-reader', '../lib/series-direction-service', '../lib/asset-design-adoption', '../lib/production-episodes', '../lib/prisma'];
  const paths = modules.map(name => require.resolve(name)), wrapperPath = require.resolve('../lib/episode-upstream-material');
  const saved = new Map([...paths, wrapperPath].map(filename => [filename, require.cache[filename]]));
  const failures: string[] = [];
  try {
    for (const scenario of ['source', 'direction', 'design', 'stable']) {
      let sourceEdition = 1, directionEdition = 1, designEdition = 1, baseReads = 0, directionReads = 0, designReads = 0, writes = 0;
      const write = () => {writes++; throw new Error('Handoff read attempted a write');};
      const base = () => {
        const sourceText=`合成人物：这是合成原文版本${sourceEdition}。`;
        return {readiness:'READY',reasons:[],packet:{episode:1,sourceVersion:`source-${sourceEdition}`,documentRevision:`document-${sourceEdition}`,sourceText,
          assets:[{key:'local',name:'合成人物',type:'CHAR',aliases:[],variants:[],sceneRefs:[{episode:1,sceneKey:'1-1'}]}],materialDependencies:[],
          scenes:[{sceneKey:'1-1',sourceRange:{start:0,end:sourceText.length}}],
          facts:{sourceFactIndex:[{id:'synthetic-dialogue',kind:'DIALOGUE',claim:'CHARACTER_CLAIM',subjects:['合成人物'],evidence:{domain:'EPISODE',episode:1,start:0,end:sourceText.length}}]}}};
      };
      const direction = () => ({status: 'CONFIRMED', projection: {schemaVersion: 'DIRECTOR_SERIES_DIRECTION_V1', id: 'direction', revision: directionEdition, sourceVersion: `source-${sourceEdition}`, cardHash: `direction-${directionEdition}`, brief: '已确认的合成短方向'}});
      const designs = () => [{assetKey: 'local', status: 'TEXT_ADOPTED', adoptionVersion: designEdition, brief: '已采用的本集简述', materialAvailability: 'TEXT_ONLY', references: []}, {assetKey: 'unrelated', status: 'TEXT_ADOPTED', adoptionVersion: 1, brief: '不应混入的外集长设计', materialAvailability: 'TEXT_ONLY', references: []}];
      const implementations = [
        {readLightEpisodeFoundation: async (projectId: string, episode: number) => {
          assert.equal(projectId, 'synthetic'); assert.equal(episode, 1); baseReads++;
          const snapshot = structuredClone(base());
          // Original counterexample: source changes after base capture, before direction/material reads.
          if (scenario === 'source' && baseReads === 1) {sourceEdition++; directionEdition++; designEdition++;}
          return snapshot;
        }},
        {readSeriesDirectionProjection: async () => {directionReads++; const snapshot = structuredClone(direction()); if (scenario === 'direction' && directionReads === 1) directionEdition++; return snapshot;}},
        {readAssetDesignHandoff: async (_project: string, keys: string[]) => {assert.deepEqual(keys, ['local']); designReads++; const snapshot = structuredClone(designs()); if (scenario === 'design' && designReads === 1) designEdition++; return snapshot;}},
        {readProductionScope: async () => ({}), isProductionEpisodeNumber: () => true},
        {prisma: {episode: {findFirstOrThrow: async () => ({id: 'episode-1'}), create: write, update: write, delete: write}, sceneSnapshot: {create: write, update: write, delete: write}}},
      ];
      for (const [index, filename] of paths.entries()) require.cache[filename] = {id: filename, filename, loaded: true, exports: implementations[index]} as NodeModule;
      delete require.cache[wrapperPath];
      const {readProductionEpisodeHandoff} = require(wrapperPath) as typeof import('../lib/episode-upstream-material');
      try {
        if (scenario === 'stable') {
          const before = JSON.stringify([base(), direction(), designs()]);
          const first = await readProductionEpisodeHandoff('synthetic', 1), second = await readProductionEpisodeHandoff('synthetic', 1);
          assert.equal(first.materialVersion, second.materialVersion);
          assert.equal(first.packet.sourceText, '合成人物：这是合成原文版本1。');
          assert.equal(first.packet.upstream.modelDesigns.length, 1);
          assert.ok(!JSON.stringify(first).includes('不应混入的外集长设计'));
          assert.equal(JSON.stringify([base(), direction(), designs()]), before, 'canonical input snapshots stay unchanged');
        } else await assert.rejects(() => readProductionEpisodeHandoff('synthetic', 1), (error: unknown) => {
          const value = error as {code?: string; status?: number; message?: string};
          return value.code === 'UPSTREAM_CHANGED' && value.status === 409 && Boolean(value.message?.includes('刷新'));
        }, `${scenario} changes must not return a mixed handoff package`);
        assert.equal(writes, 0);
        console.log(`PASS upstream ${scenario} snapshot guard; reads only, no models/network/DB writes`);
      } catch (error) {failures.push(`${scenario}: ${(error as Error).message}`);}
    }
  } finally {
    for (const [filename, original] of saved) {if (original) require.cache[filename] = original; else delete require.cache[filename];}
  }
  assert.deepEqual(failures, [], 'public reader must reject independently changing source/direction/design snapshots');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
