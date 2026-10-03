/** Read-only replay of saved upstream text through the real Stage 3 receiver.
 * No Prisma/service imports, provider calls, mutations or private source output. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {prepareEpisodeReception} from '../lib/standard-script-reception';
import type {ProductionCatalog} from '../lib/foundation-production-contracts';

const [database, projectId] = process.argv.slice(2);
if (!database || !projectId) throw new Error('Usage: audit-stage1-current-reception.ts <database-path> <project-id>');
const require = createRequire(import.meta.url);
const {makeEpisodeInput} = require('../runtime/storyboard-v4/input.mjs');
const db = new DatabaseSync(database, {readOnly:true});
try {
  const project = db.prepare('SELECT id,title,style,aspectRatio FROM Project WHERE id=?').get(projectId);
  assert.ok(project, 'project exists');
  const row = db.prepare('SELECT content FROM SceneSnapshot WHERE projectId=? AND sceneKey=? ORDER BY createdAt DESC,id DESC LIMIT 1').get(projectId, 'FOUNDATION_DOCUMENT');
  assert.ok(row, 'saved foundation document exists');
  const document = JSON.parse(String(row.content));
  const episodes = db.prepare('SELECT id,projectId,number,content FROM Episode WHERE projectId=? ORDER BY number').all(projectId);
  const diagnostics: unknown[] = [], results: unknown[] = [];
  for (const record of episodes) {
    const episode = {id:String(record.id),projectId,number:Number(record.number),content:String(record.content)};
    const reception = prepareEpisodeReception(episode, document.f2 as ProductionCatalog);
    if (!reception.scriptReception.ready) {
      diagnostics.push({episode:episode.number,diagnostics:reception.scriptReception.diagnostics});
      continue;
    }
    const input = makeEpisodeInput({episode,project,handoff:{packet:{sourceText:episode.content,...reception}}});
    results.push({episode:episode.number,ready:true,dialogue:input.source.dialogue.length});
  }
  console.log(JSON.stringify({episodes:episodes.length,ready:results.length,diagnostics,addedProviderCalls:0},null,2));
  assert.deepEqual(diagnostics, [], 'saved episodes must reach the real Stage 3 receiver without catalogue-dependent role identity');
  assert.equal(results.length, episodes.length);
} finally {db.close();}
