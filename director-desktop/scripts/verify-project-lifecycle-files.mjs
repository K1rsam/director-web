import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const reportPath = resolve('docs/verification/project-lifecycle/native/report.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
assert.equal(report.ok, true);
assert.equal(report.projectArchiveRestoreDeleteUiRoundTrip, true);
assert.equal(report.generationRequestsSent, 0);
assert.equal(report.generationJobs, 0);
const isolatedHome = await realpath(join(dirname(reportPath), 'startup-verification-home'));
assert.equal(await realpath(report.home), isolatedHome);
const projectRoot = await realpath(report.projectRoot);
const projectRelative = relative(isolatedHome, projectRoot);
assert.ok(projectRelative.startsWith(`projects${sep}`) && !projectRelative.includes('..'));
const originalPath = await realpath(report.originalMediaPath);
const mediaRelative = relative(projectRoot, originalPath);
assert.ok(mediaRelative && !mediaRelative.startsWith('..') && !mediaRelative.includes(':'));
const registry = JSON.parse(await readFile(join(isolatedHome, 'projects.json'), 'utf8'));
assert.equal(registry.some(project => project.id === report.projectId), false);
const mediaSha256 = createHash('sha256').update(await readFile(originalPath)).digest('hex');
assert.equal(mediaSha256, report.mediaSha256);
const db = new DatabaseSync(join(projectRoot, 'project.sqlite'), { readOnly: true });
let sourceVersions;
try {
  assert.equal(db.prepare('SELECT id FROM project').get().id, report.projectId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media WHERE sha256=?').get(mediaSha256).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assets WHERE id='probe-asset'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM units WHERE id='probe-unit'").get().count, 1);
  sourceVersions = db.prepare('SELECT COUNT(*) AS count FROM sources').get().count;
  assert.ok(sourceVersions > 0);
} finally { db.close(); }
const proof = {
  ok: true,
  scope: 'isolated Windows native verification project only',
  method: 'Read-only SQLite plus SHA-256 after actual UI archive, restore and registry deletion',
  projectRemovedFromRegistry: true,
  projectDatabaseRetained: true,
  sourceVersions,
  sourceAssetUnitAndMediaRecordsRetained: true,
  originalMediaRetained: true,
  originalMediaSha256: mediaSha256,
  generationJobs: 0,
  productionDatabaseAccess: false,
  localFileDeletion: false,
};
await writeFile(join(dirname(reportPath), 'file-retention.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
