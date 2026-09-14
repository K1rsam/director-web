import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { assessFoundationWorkerHealth as health } from '../lib/foundation-worker-health';
import { matchesFoundationWorker, foundationWorkerCommand } from '../lib/foundation-worker-process';

async function main() {
  const task = { projectId: 'health-project', id: 'health-task', workerToken: 'health-token', status: 'QUEUED', workerPid: null as number | null, updatedAt: new Date(10_000).toISOString() };
  assert.equal(await health(task, { now: 20_000 }), 'STARTING');
  assert.equal(await health(task, { now: 40_000 }), 'GONE');
  assert.equal(await health({ ...task, status: 'RUNNING' }, { now: 100_000 }), 'UNKNOWN');
  assert.equal(await health({ ...task, updatedAt: 'invalid' }), 'UNKNOWN');
  const running = { ...task, workerPid: 123456, status: 'RUNNING' };
  const script = path.resolve('scripts/run-foundation-delivery.ts');
  const command = `node --import tsx "${script}" ${task.projectId} ${task.id} ${task.workerToken}`;
  const probe = (command: string | null, exists: 'YES' | 'NO' | 'UNKNOWN' = 'YES') => async () => ({ command, exists });
  assert.equal(await health(running, { probe: probe(command) }), 'ALIVE');
  assert.equal(await health(running, { probe: probe(command.replace('health-token', 'other-token')) }), 'GONE');
  assert.equal(await health(running, { probe: probe(null) }), 'UNKNOWN');
  assert.equal(await health(running, { probe: probe(null, 'NO') }), 'GONE');
  assert.equal(await health(running, { probe: probe(null, 'UNKNOWN') }), 'UNKNOWN');
  assert.equal(await health({ ...running, workerToken: null }, { probe: probe(command) }), 'UNKNOWN');
  assert.equal(await health({ ...running, workerPid: process.pid }), 'ALIVE');
  const spacedScript = '/Users/test/My Project/scripts/run-foundation-delivery.ts';
  assert.equal(await health(running, { platform: 'darwin', script: spacedScript, probe: probe(`node ${spacedScript} health-project health-task health-token`) }), 'UNKNOWN');
  assert.equal(matchesFoundationWorker(`${command} extra`, task, script), false);
  assert.equal(matchesFoundationWorker(command.replace('health-project', 'wrong-project'), task, script), false);
  assert.equal(matchesFoundationWorker(command.replace('health-task', 'wrong-task'), task, script), false);

  // Real local process; the fixture never imports the delivery runner or calls AI.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'foundation worker health '));
  const fixture = path.join(directory, 'idle-worker.cjs');
  await writeFile(fixture, 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [fixture, task.projectId, task.id, task.workerToken!], { stdio: 'ignore', windowsHide: true });
  try {
    await once(child, 'spawn');
    const real = { ...running, workerPid: child.pid! };
    const observed = await foundationWorkerCommand(child.pid!);
    assert.ok(observed, 'real process command must be observable');
    assert.equal(await health(real, { script: fixture }), process.platform === 'win32' ? 'ALIVE' : 'UNKNOWN');
    assert.equal(await health({ ...real, workerToken: 'wrong-token' }, { script: fixture }), process.platform === 'win32' ? 'GONE' : 'UNKNOWN');
    const exited = once(child, 'exit'); child.kill(); await exited;
    assert.equal(await health(real, { script: fixture }), 'GONE');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('foundation worker health '));
    await rm(directory, { recursive: true, force: true });
  }
  console.log('PASS foundation worker health: queue grace, reused PID identity, unknown observability, Mac spaces, real idle child and exit; no AI or database');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
