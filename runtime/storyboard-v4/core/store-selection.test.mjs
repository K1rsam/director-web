import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStore} from './store.mjs';

test('a short locked read and a selection mutation share the durable exclusive gate',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'store-selection-lock-'));
 let release;const gate=new Promise(resolve=>release=resolve);
 try{
  const store=createStore(directory);await store.create('chain',{selected:'old'});
  let entered;const observed=new Promise(resolve=>entered=resolve),order=[];
  const read=store.withLockedRead('chain',async d=>{order.push(d.selected);entered();await gate;order.push('agreement-saved');d.selected='reader-mutation';return 'accepted';});
  await observed;
  const write=store.update('chain',d=>{order.push('selection-changed');return {...d,selected:'new'};});
  release();assert.equal(await read,'accepted');await write;
  assert.deepEqual(order,['old','agreement-saved','selection-changed']);assert.equal((await store.read('chain')).selected,'new');
  await assert.rejects(store.withLockedRead('chain',async()=>{throw new Error('rejected');}),/rejected/);
  assert.equal((await store.update('chain',d=>d)).selected,'new','failed observations release their lock');
 }finally{release();await rm(directory,{recursive:true,force:true});}
});
