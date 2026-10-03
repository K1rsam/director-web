import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {backgroundTransferSpecs, prepareBackgroundPatch, sha256, composerMainHash,
  installImageBackgroundTransferFix} from './install-image-background-transfer-fix.mjs';
import {recordProofSpecs} from './install-image-record-proof.mjs';

const home = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'Programs/Director-3008-ChatGPT-Bridge/671815e');
const sources = new Map();
for (const spec of backgroundTransferSpecs) {
  const current = await readFile(path.join(home, 'extension', spec.relative), 'utf8');
  const after = prepareBackgroundPatch(spec, current);
  new vm.Script(after, {filename: spec.relative});
  assert.equal(prepareBackgroundPatch(spec, after), after, 'postimage idempotence');
  assert.throws(() => prepareBackgroundPatch(spec, current + '\n// drift'), /drift/);
  assert.throws(() => spec.patch(''), /exactly once/);
  sources.set(spec.relative, {current, after});
}
const originalTransfer = await readFile(new URL('../runtime-3008/bridge-image-parser-experiment/content_artifactTransfer.js.original', import.meta.url), 'utf8');
const transferSpec = backgroundTransferSpecs[0];
assert.equal(sha256(originalTransfer), transferSpec.beforeHashes[0]);
assert.ok(transferSpec.afterHashes.includes(sha256(prepareBackgroundPatch(transferSpec, originalTransfer))));
const proofSpec = recordProofSpecs.find(spec => spec.relative === transferSpec.relative);
assert.equal(sha256(proofSpec.patch(originalTransfer)), '62d4e6c1e325f575d9e8753fcae0bcdfb05facae3d1a11e7c56bf98914579e3b', 'proof startup retains both native cache and microtask transfer');

const actualTransfer = sources.get(transferSpec.relative).after;
const functionStart = actualTransfer.indexOf('    async function streamArtifactPayload(');
const functionEnd = actualTransfer.indexOf('    async function streamArtifactDownloadedFile(', functionStart);
assert.ok(functionStart > 0 && functionEnd > functionStart);
async function runTransfer(kind, bytes, original = false, throwingTimer = false) {
  const events = []; let timerCalls = 0;
  const source = original ? originalTransfer : actualTransfer;
  const start = source.indexOf('    async function streamArtifactPayload(');
  const end = source.indexOf('    async function streamArtifactDownloadedFile(', start);
  const context = vm.createContext({crypto: webcrypto, Uint8Array, DataView,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    CONFIG: {artifactChunkSize: 256 * 1024}, send: event => events.push(event),
    delay: async ms => {assert.equal(ms, 0); timerCalls++; if (throwingTimer) throw Error('Hidden-tab timer must not be used');},
  });
  for (const module of ['shared/artifactImage.js', 'shared/transferIntegrity.js']) {
    vm.runInContext(await readFile(path.join(home, 'extension', module), 'utf8'), context);
  }
  vm.runInContext(source.slice(start, end) + '\nglobalThis.fixtureTransfer=streamArtifactPayload;', context);
  const artifact = {id: 'fixture-image', kind, name: kind === 'image' ? 'fixture.png' : 'fixture.txt', mime: kind === 'image' ? 'image/png' : 'text/plain'};
  const perform = () => context.fixtureTransfer('fixture-command', artifact, {contentBase64: bytes.toString('base64'), mime: artifact.mime});
  if (original && throwingTimer) { await assert.rejects(perform, /Hidden-tab timer/); return; }
  const result = await perform();
  assert.equal(events[0].type, 'artifact.data.started'); assert.equal(events.at(-1).type, 'artifact.data.done');
  const chunks = events.slice(1, -1); assert.ok(chunks.length > 7);
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.type, 'artifact.data.chunk'); assert.equal(chunk.commandId, 'fixture-command');
    assert.equal(chunk.artifactId, artifact.id); assert.equal(chunk.index, index); assert.equal(chunk.offset, offset);
    offset += chunk.contentBase64.length;
    for (const key of ['transferId', 'size', 'encodedSize', 'totalChunks', 'sha256', 'encoding']) assert.equal(chunk[key], events[0][key]);
  }
  const reconstructed = Buffer.from(chunks.map(chunk => chunk.contentBase64).join(''), 'base64');
  assert.deepEqual(reconstructed, bytes); assert.equal(events[0].sha256, sha256(bytes));
  assert.equal(events[0].totalChunks, chunks.length); assert.equal(events[0].size, bytes.length);
  assert.equal(events[0].encodedSize, bytes.toString('base64').length); assert.equal(result.size, bytes.length);
  await context.ChatGptTransferIntegrity.verifyBytes(new Uint8Array(reconstructed), events[0]);
  assert.equal(timerCalls, kind === 'image' ? 0 : chunks.length);
  assert.equal(result.mime, artifact.mime);
}
// Real byte-sized fixture reproduces the failed live transfer's >7-chunk shape.
const imageBytes = Buffer.alloc(1_654_409, 0x37);
Buffer.from([137,80,78,71,13,10,26,10]).copy(imageBytes);
await runTransfer('image', imageBytes, true, true); // the original fails this timer simulation
await runTransfer('image', imageBytes, false, true);
await runTransfer('file', Buffer.alloc(1_654_409, 0x61));
console.log('PASS: actual image transfer >7 chunks uses zero timer tasks, exact bytes/SHA/order/count; original fails mocked background timer, non-image timer behavior unchanged.');

// Run the actual MAIN-world listener together with the actual patched content
// setter. A mocked event bus verifies request identity and protocol, not regexes.
const mainSource = await readFile(path.join(home, 'extension/artifactCaptureMain.js'), 'utf8');
assert.equal(sha256(mainSource), composerMainHash);
const mainStart = mainSource.indexOf("  const INSTANCE_KEY = '__chatgptBridgeComposerMainV1';");
assert.ok(mainStart > 0);
const composerSource = sources.get('content/composerCommands.js').after;
const composerStart = composerSource.indexOf('function setComposerTextByPageMain(');
const composerEnd = composerSource.indexOf('function setComposerTextByTextContent(', composerStart);
assert.ok(composerStart > 0 && composerEnd > composerStart);
const listeners = new Set(), messages = [], timers = new Map(); let timerId = 0, removed = 0;
const editor = {tagName:'DIV', isContentEditable:true, isConnected:true, children:[], innerText:'',
  getAttribute:key => key === 'contenteditable' ? 'true' : null,
  getClientRects:() => [{}], focus:() => {}, dispatchEvent:() => {},
};
const windowFixture = {
  addEventListener:(_type, callback) => listeners.add(callback),
  removeEventListener:(_type, callback) => {if(listeners.delete(callback)) removed++;},
  getComputedStyle:() => ({display:'block',visibility:'visible'}),
  getSelection:() => ({removeAllRanges(){},addRange(){}}),
  postMessage(data) {messages.push(data); queueMicrotask(() => {for(const callback of [...listeners]) callback({source:windowFixture,data});});},
};
const composerContext = vm.createContext({window:windowFixture,
  document:{querySelectorAll:() => [editor], createRange:() => ({selectNodeContents(){}}),
    execCommand:(_action,_show,text) => {editor.innerText=text; return true;}},
  setTimeout:callback => {const id=++timerId; timers.set(id,callback);return id;},
  clearTimeout:id => timers.delete(id),
});
vm.runInContext('(() => {\n' + mainSource.slice(mainStart), composerContext);
vm.runInContext(composerSource.slice(composerStart, composerEnd) + '\nglobalThis.fixtureSet=setComposerTextByPageMain;', composerContext);
const text='完整提示词：一块蓝色玻璃立方体。';
const result=await composerContext.fixtureSet(editor,text,{requestId:'fixture-request'});
assert.equal(result.ok,true); assert.equal(editor.innerText,text); assert.equal(timers.size,0); assert.equal(removed,1);
assert.equal(messages.length,2); assert.equal(messages[0].source,'chatgpt-browser-bridge-composer-content-v1');
assert.equal(messages[1].source,'chatgpt-browser-bridge-composer-main-v1');
assert.equal(messages[1].requestId,messages[0].requestId); assert.equal(messages[0].diagnosticRequestId,'fixture-request');
// Wrong source/request/type messages cannot settle the content-side Promise.
let releaseReply, pendingMessage; const savedPost = windowFixture.postMessage;
windowFixture.postMessage = data => {pendingMessage=data;releaseReply=()=>savedPost.call(windowFixture,data);};
let settled=false; const guarded=composerContext.fixtureSet(editor,text,{}).then(value=>{settled=true;return value;});
const observer=[...listeners].at(-1);
const validReply={source:'chatgpt-browser-bridge-composer-main-v1',type:'composer.set.result',requestId:pendingMessage.requestId,result:{ok:true}};
for (const event of [
  {source:{},data:validReply},
  {source:windowFixture,data:{...validReply,requestId:'other-request'}},
  {source:windowFixture,data:{...validReply,source:'chatgpt-bridge-composer-main-v1'}},
  {source:windowFixture,data:{...validReply,type:'other-result'}},
]) observer(event);
await Promise.resolve(); assert.equal(settled,false);
windowFixture.postMessage=savedPost;releaseReply();assert.equal((await guarded).ok,true);
assert.equal(timers.size,0);
console.log('PASS: actual composer content setter + MAIN-world listener agree; exact text/request roundtrip and invalid sender/type/request rejection.');

// Installer integration writes only disposable local fixtures, never the vendor.
const fixtureRoot=await mkdtemp(path.join(os.tmpdir(),'aoci-image-background-fixture-'));
try {
  const fixtureHome=path.join(fixtureRoot,'bridge'), backupRoot=path.join(fixtureRoot,'backups');
  // Keep this verification useful after the real installation: the disposable
  // installer fixture always starts with the SHA-pinned upstream preimages.
  let composerOriginal=sources.get('content/composerCommands.js').after;
  const composerSpec=backgroundTransferSpecs[1];
  if(composerSpec.afterHashes.includes(sha256(composerOriginal))) {
    for(const namespace of ['main','content']) {
      const after="'chatgpt-browser-bridge-composer-"+namespace+"-v1'";
      assert.equal(composerOriginal.split(after).length,2);
      composerOriginal=composerOriginal.replace(after,"'chatgpt-bridge-composer-"+namespace+"-v1'");
    }
  }
  assert.equal(sha256(composerOriginal),composerSpec.beforeHashes[0]);
  for(const base of ['extension','tools/chrome-bridge-extension']) {
    await mkdir(path.join(fixtureHome,base,'content'),{recursive:true});
    await writeFile(path.join(fixtureHome,base,'artifactCaptureMain.js'),mainSource);
    for(const spec of backgroundTransferSpecs) await writeFile(path.join(fixtureHome,base,spec.relative),spec === transferSpec ? originalTransfer : composerOriginal);
  }
  const receipt=await installImageBackgroundTransferFix(fixtureHome,{backupRoot});
  assert.ok(receipt.files.every(file=>file.changed),'all four upstream preimages are actually patched');
  for(const file of receipt.files.filter(file=>file.changed)) assert.equal(sha256(await readFile(file.backup)),file.beforeHash);
  const second=await installImageBackgroundTransferFix(fixtureHome,{backupRoot});assert.ok(second.files.every(file=>!file.changed));
  for(const file of second.files.filter(file=>file.backup)) assert.equal(sha256(await readFile(file.backup)),file.backupSha256,'idempotent receipt retains original backups');
  const keptFile=path.join(fixtureHome,'tools/chrome-bridge-extension',transferSpec.relative);
  const unchanged=await readFile(keptFile,'utf8');
  await writeFile(path.join(fixtureHome,'extension/content/composerCommands.js'),'// unexpected drift');
  await assert.rejects(()=>installImageBackgroundTransferFix(fixtureHome,{backupRoot}),/drift/);
  assert.equal(await readFile(keptFile,'utf8'),unchanged,'preflight drift rejection prevents partial writes');
} finally {await rm(fixtureRoot,{recursive:true,force:true});}
console.log('PASS: pinned original/proof composition, both-copy install, verified backups/receipt, idempotent restart and drift rejection; zero vendor/browser/network writes.');
