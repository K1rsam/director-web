import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {measureVoiceReference} from './voice.mjs';

async function fixture(t, sayBody = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const say = path.join(root, 'say');
  const info = path.join(root, 'afinfo');
  await fs.writeFile(say, `#!/usr/bin/env node\nimport fs from 'node:fs';\nlet s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{${sayBody || "fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],s);"}});\n`);
  await fs.writeFile(info, "#!/usr/bin/env node\nprocess.stdout.write('estimated duration: 1.25 sec\\n');\n");
  await fs.chmod(say, 0o700);
  await fs.chmod(info, 0o700);
  return {root, say, info, cacheRoot: path.join(root, 'cache')};
}

test('measures only speech, preserves shell text, and reuses quote cache across ids', async t => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'should-not-run');
  const quote = `$(touch ${marker}); \`whoami\` 我还没输！`;
  const source = {dialogue:[{id:'a',quote,kind:'speech'},{id:'r',quote:'吼！',kind:'roar'},{id:'s',quote:'啊！',kind:'scream'}]};
  const first = await measureVoiceReference(source,{cacheRoot:f.cacheRoot,executable:f.say,infoExecutable:f.info});
  assert.deepEqual(first.rows,[{id:'a',quote,seconds:1.25}]);
  assert.deepEqual(first.warnings,[]);
  await fs.chmod(f.say, 0o000);
  const again = await measureVoiceReference({dialogue:[{id:'another',quote,kind:'speech'}]},{cacheRoot:f.cacheRoot,executable:f.say,infoExecutable:f.info});
  assert.deepEqual(again.rows,[{id:'another',quote,seconds:1.25}]);
  await assert.rejects(fs.access(marker));
});

test('failed audio command warns without inventing seconds', async t => {
  const f = await fixture(t, 'process.exitCode=2;');
  const result = await measureVoiceReference({dialogue:[{id:'bad',quote:'你好',kind:'speech'}]},{cacheRoot:f.cacheRoot,executable:f.say,infoExecutable:f.info});
  assert.deepEqual(result.rows,[]);
  assert.ok(result.warnings.some(x=>x.includes('bad') && x.includes('未实测')));
});

test('unavailable duration reader warns without using the generated audio as a guess', async t => {
  const f = await fixture(t);
  const result = await measureVoiceReference({dialogue:[{id:'info',quote:'你好',kind:'speech'}]},{cacheRoot:f.cacheRoot,executable:f.say,infoExecutable:path.join(f.root,'missing-afinfo')});
  assert.deepEqual(result.rows,[]);
  assert.ok(result.warnings.some(x=>x.includes('info') && x.includes('未实测')));
});

test('aborted and timed out commands stop without a measured duration', async t => {
  const f = await fixture(t, 'setTimeout(()=>{},60000);');
  const ac = new AbortController();
  setTimeout(()=>ac.abort(),30);
  const start = Date.now();
  const result = await measureVoiceReference({dialogue:[{id:'slow',quote:'你好',kind:'speech'}]},{cacheRoot:f.cacheRoot,executable:f.say,infoExecutable:f.info,signal:ac.signal});
  assert.ok(Date.now()-start<2000);
  assert.deepEqual(result.rows,[]);
  assert.ok(result.warnings.some(x=>x.includes('slow') && x.includes('未实测')));
});

test('a hanging audio command times out within the per-line limit', async t => {
  const f = await fixture(t, 'setTimeout(()=>{},60000);');
  const start = Date.now();
  const result = await measureVoiceReference({dialogue:[{id:'hang',quote:'你好',kind:'speech'}]},{cacheRoot:f.cacheRoot,executable:f.say,infoExecutable:f.info});
  assert.ok(Date.now()-start < 11000);
  assert.deepEqual(result.rows,[]);
  assert.ok(result.warnings.some(x=>x.includes('hang') && x.includes('超时') && x.includes('未实测')));
});
