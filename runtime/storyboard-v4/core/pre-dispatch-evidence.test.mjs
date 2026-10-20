import test from 'node:test';
import assert from 'node:assert/strict';
const m=await import('./pre-dispatch-evidence.mjs').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));
test('local pre-dispatch evidence does not fabricate a native zero receipt and expires with the original failure',()=>{
 assert.equal(typeof m.sealUnsentProof,'function');
 const op={attemptId:'a',fingerprint:'f',status:'completed',error:{code:'ERR_REQUIRE_ESM_RACE_CONDITION',requestOutcome:'UNKNOWN'},receipt:{requestOutcome:'RESPONDED',usage:null}};
 const proof=m.sealUnsentProof(op,{scope:'BOUND_MODEL_ADAPTER',budgetId:'budget',nativeDirectoryAbsent:true,ledgerAttemptAbsent:true,candidateAbsent:true});
 const verified={...op,localDispatchProof:proof};assert.equal(m.isVerifiedUnsent(verified),true);assert.deepEqual(verified.receipt,op.receipt);assert.equal(verified.error.requestOutcome,'UNKNOWN');
 assert.equal(m.isVerifiedUnsent({...verified,fingerprint:'changed'}),false);assert.equal(m.isVerifiedUnsent({...verified,error:{...op.error,code:'TIMEOUT'}}),false);
 assert.throws(()=>m.sealUnsentProof(op,{scope:'BOUND_MODEL_ADAPTER',nativeDirectoryAbsent:false,ledgerAttemptAbsent:true,candidateAbsent:true}),{code:'PRE_DISPATCH_UNPROVEN'});
 assert.throws(()=>m.sealUnsentProof({...op,receipt:{usage:{totalTokens:1}}},{scope:'BOUND_MODEL_ADAPTER',nativeDirectoryAbsent:true,ledgerAttemptAbsent:true,candidateAbsent:true}),{code:'PRE_DISPATCH_UNPROVEN'});
});
test('maintenance NOT_SENT proof is confined to an unbound free CREATE, never a paid UNKNOWN or bound adapter',()=>{
 const op={id:'create',error:{code:'RUNTIME_MAINTENANCE',requestOutcome:'NOT_SENT'}},e={scope:'UNBOUND_STORYBOARD_CREATE',nativeDirectoryAbsent:true,ledgerAttemptAbsent:true,candidateAbsent:true};
 const proof=m.sealUnsentProof(op,e);assert.equal(m.isVerifiedUnsent({...op,localDispatchProof:proof}),true);assert.equal(op.receipt,undefined);
 for(const [o,evidence] of [[{...op,error:{...op.error,requestOutcome:'UNKNOWN'}},e],[op,{...e,scope:'BOUND_MODEL_ADAPTER'}],[op,{...e,nativeDirectoryAbsent:false}],[{...op,receipt:{usage:{totalTokens:1}}},e]])assert.throws(()=>m.sealUnsentProof(o,evidence),{code:'PRE_DISPATCH_UNPROVEN'});
 assert.equal(m.isVerifiedUnsent({...op,error:{...op.error,requestOutcome:'UNKNOWN'},localDispatchProof:proof}),false);
});
test('preparation proof never labels the previous paid plan as unsent and expires when a new operation or failure arrives',()=>{
 const r={id:'r',status:'planned',plan:{id:'plan'},web:{progress:'failed',error:{code:'ERR_REQUIRE_ESM_RACE_CONDITION'},binding:{projectId:'p'}},operations:[{attemptId:'paid',status:'completed',receipt:{requestOutcome:'RESPONDED',usage:{totalTokens:5}}}]};
 assert.equal(m.isVerifiedPreparationFailure(r),false);const proof=m.sealPreparationProof(r,{allNativeFinal:true,native:[{attemptId:'paid',receiptHash:'final'}]});r.web.localPreparationProof=proof;assert.equal(m.isVerifiedPreparationFailure(r),true);assert.equal(m.isVerifiedUnsent(r.operations[0]),false);assert.equal(r.operations[0].receipt.usage.totalTokens,5);
 assert.equal(m.isVerifiedPreparationFailure({...r,operations:[...r.operations,{attemptId:'next',status:'running'}]}),false);assert.equal(m.isVerifiedPreparationFailure({...r,web:{...r.web,error:{code:'TIMEOUT'}}}),false);
});
