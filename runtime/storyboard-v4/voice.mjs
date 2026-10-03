import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCOPE = 'Tingting rate200本机平读，仅语言容量参照非演员实配';
const VOICE = 'Tingting', RATE = '200';

function run(command, args, input, deadline, signal) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0 || signal?.aborted) return reject(new Error(signal?.aborted ? '已停止' : '超时'));
    const child = spawn(command, args, {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', done = false;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(output);
    };
    const abort = () => { child.kill('SIGKILL'); finish(new Error('已停止')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('超时')); }, left);
    child.on('error', finish);
    child.on('close', code => finish(code === 0 ? null : new Error(`退出码 ${code}`)));
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) abort(); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
  });
}

async function cachedSeconds(dir) {
  try {
    if (!(await fs.lstat(dir)).isDirectory()) return null;
    const json = path.join(dir, 'measure.json'), audio = path.join(dir, 'voice.aiff');
    if (!(await fs.lstat(json)).isFile() || !(await fs.lstat(audio)).isFile()) return null;
    const data = JSON.parse(await fs.readFile(json, 'utf8'));
    return Number.isFinite(data.seconds) && data.seconds > 0 ? data.seconds : null;
  } catch { return null; }
}

export async function measureVoiceReference(source, {cacheRoot, signal, executable = '/usr/bin/say', infoExecutable = '/usr/bin/afinfo'} = {}) {
  const rows = [], warnings = [];
  const dialogue = Array.isArray(source?.dialogue) ? source.dialogue : [];
  const root = path.resolve(cacheRoot || path.join(os.tmpdir(), 'storyboard-v4-voice-cache'));
  const totalDeadline = Date.now() + 45000;
  try { await fs.mkdir(root, {recursive: true, mode: 0o700}); }
  catch { return {scope:SCOPE, rows, warnings:dialogue.filter(q=>q.kind==='speech').map(q=>`${q.id}: 缓存目录不可用，未实测`)}; }
  for (const q of dialogue) {
    if (q.kind !== 'speech') continue;
    const id = q.id, quote = q.quote;
    if (typeof quote !== 'string' || !quote.trim()) { warnings.push(`${id}: 无可读原句，未实测`); continue; }
    if (signal?.aborted) { warnings.push(`${id}: 已停止，未实测`); continue; }
    if (Date.now() >= totalDeadline) { warnings.push(`${id}: 总时限已到，未实测`); continue; }
    const hash = createHash('sha256').update(JSON.stringify([quote, VOICE, RATE])).digest('hex');
    const target = path.join(root, hash);
    const hit = await cachedSeconds(target);
    if (hit !== null) { rows.push({id, quote, seconds:hit}); continue; }
    const deadline = Math.min(Date.now() + 10000, totalDeadline);
    let temp;
    try {
      if (deadline <= Date.now()) throw new Error('总时限已到');
      temp = await fs.mkdtemp(path.join(root, `${hash}-`));
      await fs.chmod(temp, 0o700);
      const audio = path.join(temp, 'voice.aiff');
      await run(executable, ['-v', VOICE, '-r', RATE, '-o', audio, '-f', '-'], quote, deadline, signal);
      const info = await run(infoExecutable, [audio], '', deadline, signal);
      const match = info.match(/(?:estimated\s+)?duration:\s*([0-9]+(?:\.[0-9]+)?)\s*sec\b/i);
      const seconds = match && Number(match[1]);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('音频时长不可读');
      await fs.writeFile(path.join(temp, 'measure.json'), JSON.stringify({seconds}), {flag:'wx', mode:0o600});
      try { await fs.rename(temp, target); temp = null; } catch { /* Existing cache stays untouched. */ }
      rows.push({id, quote, seconds});
    } catch (error) {
      warnings.push(`${id}: ${error.message || '测读失败'}，未实测`);
    } finally {
      if (temp) await fs.rm(temp, {recursive:true, force:true});
    }
  }
  return {scope:SCOPE, rows, warnings};
}
