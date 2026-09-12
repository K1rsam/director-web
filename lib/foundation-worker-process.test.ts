import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { foundationWorkerCommand,matchesFoundationWorker,spawnFoundationWorkerProcess,stopFoundationWorkerProcess } from './foundation-worker-process';

async function main(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'foundation-synthetic-worker-')),script=path.join(dir,'sleep-worker.mjs');
 await writeFile(script,'setInterval(()=>{},1000);');
 const identity={projectId:`synthetic-${randomUUID()}`,id:randomUUID(),workerToken:randomUUID(),workerPid:0};
 const child=spawnFoundationWorkerProcess(identity,script);identity.workerPid=child.pid!;
 try {
  assert.ok(child.pid);let command:string|null=null;
  for(let i=0;i<8&&!command;i++){await delay(150);command=await foundationWorkerCommand(child.pid!);}
  assert.ok(command,'synthetic process readable');assert.ok(matchesFoundationWorker(command,identity,script));
  assert.equal(await stopFoundationWorkerProcess({...identity,id:identity.id+'-wrong'},script),false);
  assert.equal(await stopFoundationWorkerProcess({...identity,workerToken:'wrong'},script),false);
  assert.equal(await stopFoundationWorkerProcess({...identity,projectId:'wrong'},script),false);
  assert.equal(await stopFoundationWorkerProcess(identity,script+'-wrong'),false);
  assert.equal(await stopFoundationWorkerProcess({...identity,workerPid:process.pid},script),false);
  assert.ok(await foundationWorkerCommand(child.pid!),'mismatch did not terminate synthetic worker');
  assert.equal(await stopFoundationWorkerProcess(identity,script),true);
  await delay(200);assert.equal(await foundationWorkerCommand(child.pid!),null,'verified process stopped');
  console.log(JSON.stringify({platform:process.platform,syntheticOnly:true,wrongIdentityRefused:true,verifiedTreeStopped:true,modelCalls:0}));
 }finally{await stopFoundationWorkerProcess(identity,script);await rm(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
