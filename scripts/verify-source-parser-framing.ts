/** Offline IPC regression: complete framed JSON must not wait for stdin EOF. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseSceneBatch } from '@/lib/source-parser';

const payload = { operation: 'parse_scenes', episodes: [1, 2, 3, 4].map(number => ({ number,
  content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n${'甲：沉默。\n'.repeat(3100)}` })), sceneParserVersions: { 1: 'SCENE_PARSER_V2', 2: 'SCENE_PARSER_V2', 3: 'SCENE_PARSER_V2', 4: 'SCENE_PARSER_V2' } };
function invoke(keepInputOpen: boolean, pretty = false) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.env.PYTHON ?? 'python3', [path.join(process.cwd(), 'scripts/source_parser.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('完整JSON消息仍在等待输入流结束，来源解析不能无限阻塞。')); }, 5000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); child.stdin.destroy(); code === 0 ? resolve(stdout) : reject(new Error(`来源解析失败(${code}): ${stderr.slice(0, 200)}`)); });
    child.stdin.on('error', () => { /* Parser may exit before the deliberately open pipe is closed. */ });
    const wire = JSON.stringify(payload, null, pretty ? 2 : undefined);
    if (keepInputOpen) child.stdin.write(wire + '\n');
    else child.stdin.end(wire); // Existing workers without framing remain compatible.
  });
}

async function main() {
  const framed = JSON.parse(await invoke(true)), legacy = JSON.parse(await invoke(false));
  assert.equal(framed.ok, true); assert.deepEqual(framed, legacy);
  assert.deepEqual(JSON.parse(await invoke(false, true)), framed, 'Legacy multiline JSON remains compatible.');
  assert.deepEqual(framed.value.map((item: { scenes: { sourceText: string }[] }) => item.scenes.map(scene => scene.sourceText).join('')), payload.episodes.map(item => item.content));
  for (let i = 0; i < 5; i++) assert.deepEqual(parseSceneBatch(payload.episodes), framed.value, 'Actual TS→Python path must preserve source and scene metadata.');
  console.log('PASS source-parser framed IPC: open stdin returns, compact/pretty EOF compatibility, 5 long actual TS→Python calls preserved; no model calls');
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
