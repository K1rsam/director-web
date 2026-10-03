import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const sha256 = source => createHash('sha256').update(source).digest('hex');
const once = (source, before, after) => {
  if (source.split(before).length !== 2) throw Error('Background patch anchor must occur exactly once');
  return source.replace(before, after);
};
export function patchImageTransfer(source) {
  // Preserve all image byte, ordering, integrity and native-source checks. Hidden
  // pages throttle nested timer tasks; this small bounded transfer needs no timer.
  return once(source, "        await delay(0);", "        if (globalThis.ChatGptArtifactImage.isImageArtifact(artifact)) await Promise.resolve();\n        else await delay(0);");
}
export function patchComposerNamespace(source) {
  source = once(source, "'chatgpt-bridge-composer-main-v1'", "'chatgpt-browser-bridge-composer-main-v1'");
  return once(source, "'chatgpt-bridge-composer-content-v1'", "'chatgpt-browser-bridge-composer-content-v1'");
}
export const backgroundTransferSpecs = [
  {relative: 'content/artifactTransfer.js', beforeHashes: [
    '344d09848f670684f5cf38639802048fe8c09290d456206fc4584ec517224ebd',
    '37f58e3b5995fc4db012803b1d5937c619cab358453d2ede11527ed19cdc9659',
  ], afterHashes: [
    'f42d497f2bbd60e79c9e389c369c61468427429ea2765fbda425c53e36a24e5f',
    '62d4e6c1e325f575d9e8753fcae0bcdfb05facae3d1a11e7c56bf98914579e3b',
  ], patch: patchImageTransfer},
  {relative: 'content/composerCommands.js', beforeHashes: [
    '1efc0c7943c1296b773917aa05a285b0e6dbc0717da6048a7bcbeae7e0a59947',
  ], afterHashes: ['6253aa93a24a8099a9fc1204dba49b04f783b3482ba855f393c39c64de079afe'], patch: patchComposerNamespace},
];
export const composerMainHash = '8e18a877be46affacc9cf5c36dfc274f8c03c06b9c1dfb5778d381cedbcd9f62';
export function prepareBackgroundPatch(spec, source) {
  const beforeHash = sha256(source);
  if (spec.afterHashes.includes(beforeHash)) return source;
  if (!spec.beforeHashes.includes(beforeHash)) throw Error('Unexpected vendor drift: ' + spec.relative);
  const after = spec.patch(source);
  if (!spec.afterHashes.includes(sha256(after))) throw Error('Unexpected patch postimage: ' + spec.relative);
  return after;
}

export async function installImageBackgroundTransferFix(home, options = {}) {
  if (!home || !path.isAbsolute(home)) throw Error('Absolute pinned bridge home required');
  const backupRoot = options.backupRoot || path.join(root, 'runtime-3008/bridge-image-background-transfer-fix');
  const receiptFile = path.join(backupRoot, 'install-receipt.json');
  let previous = {files: []};
  try { previous = JSON.parse(await readFile(receiptFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const plan = [];
  // Validate both copies and the receiving MAIN-world protocol before any write.
  for (const base of ['tools/chrome-bridge-extension', 'extension']) {
    if (sha256(await readFile(path.join(home, base, 'artifactCaptureMain.js'))) !== composerMainHash) {
      throw Error('Unexpected composer MAIN-world drift: ' + base);
    }
    for (const spec of backgroundTransferSpecs) {
      const file = path.join(home, base, spec.relative);
      const before = await readFile(file, 'utf8');
      const after = prepareBackgroundPatch(spec, before);
      const beforeHash = sha256(before), afterHash = sha256(after);
      const backup = path.join(backupRoot, base, spec.relative + '.' + beforeHash + '.original');
      plan.push({file, base, relative: spec.relative, before, after, beforeHash, afterHash, backup});
    }
  }
  for (const spec of backgroundTransferSpecs) {
    const copies = plan.filter(item => item.relative === spec.relative);
    if (copies[0].afterHash !== copies[1].afterHash) throw Error('Vendor copies have inconsistent prerequisite patches: ' + spec.relative);
  }
  for (const item of plan.filter(item => item.before !== item.after)) {
    await mkdir(path.dirname(item.backup), {recursive: true});
    try { await writeFile(item.backup, item.before, {flag: 'wx'}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (sha256(await readFile(item.backup)) !== item.beforeHash) throw Error('Backup drift: ' + item.relative);
  }
  // Recheck every preimage so a third-party edit during backup is never clobbered.
  for (const item of plan) {
    if (sha256(await readFile(item.file)) !== item.beforeHash) throw Error('Concurrent vendor drift: ' + item.relative);
  }
  for (const item of plan) if (item.before !== item.after) await writeFile(item.file, item.after);
  for (const item of plan) if (sha256(await readFile(item.file)) !== item.afterHash) throw Error('Installed postimage mismatch');
  await mkdir(backupRoot, {recursive: true});
  const receipt = {version: 1, upstream: '671815e1939db9effb556ea7ef67673fc21e4121', home,
    installedAt: new Date().toISOString(), files: plan.map(({base, relative, beforeHash, afterHash, backup, before, after}) => {
      const prior = previous.files?.find(file => file.base === base && file.relative === relative && file.afterHash === afterHash);
      return {base, relative, beforeHash, afterHash, changed: before !== after,
        ...(before !== after ? {backup, backupSha256: beforeHash} : prior?.backup ? {backup: prior.backup, backupSha256: prior.backupSha256} : {})};
    })};
  await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  console.log('Installed image-only background chunk and exact composer protocol fixes; no browser operation.');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await installImageBackgroundTransferFix(process.argv[2]);
}
