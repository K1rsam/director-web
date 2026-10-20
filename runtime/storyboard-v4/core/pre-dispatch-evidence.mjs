import {digest,fail} from './shared.mjs';
export const PRE_DISPATCH_EVIDENCE_VERSION='budgeted-pre-dispatch-absence-v1';
const loadFailure=x=>['ERR_REQUIRE_ESM_RACE_CONDITION','ERR_REQUIRE_ASYNC_MODULE','ERR_MODULE_NOT_FOUND','RUNTIME_RELOAD_REQUIRED'].includes(x?.error?.code);
const unsentFailure=(x,e)=>loadFailure(x)||e?.scope==='UNBOUND_STORYBOARD_CREATE'&&x?.error?.code==='RUNTIME_MAINTENANCE'&&x.error.requestOutcome==='NOT_SENT';
const positiveUsage=x=>Object.values(x?.receipt?.usage??{}).some(n=>typeof n==='number'&&n>0);
const basis=x=>({id:x.attemptId??x.id,fingerprint:x.fingerprint??null,error:x.error??null,receipt:x.receipt??null});
export function sealUnsentProof(operation,evidence){
 if(!unsentFailure(operation,evidence)||positiveUsage(operation)||evidence.nativeDirectoryAbsent!==true||evidence.ledgerAttemptAbsent!==true||evidence.candidateAbsent!==true||!['BOUND_MODEL_ADAPTER','UNBOUND_STORYBOARD_CREATE'].includes(evidence.scope))fail('PRE_DISPATCH_UNPROVEN','缺少模型适配器之前的确定零派发证据；保留原UNKNOWN。');
 const payload={version:PRE_DISPATCH_EVIDENCE_VERSION,outcome:'NOT_SENT',basisHash:digest(basis(operation)),evidence,verifiedAt:new Date().toISOString()};
 return {...payload,identity:digest(payload)};
}
export function isVerifiedUnsent(operation){
 const p=operation?.localDispatchProof;if(!p||!unsentFailure(operation,p.evidence)||positiveUsage(operation))return false;
 const {identity,...payload}=p;
 return p.version===PRE_DISPATCH_EVIDENCE_VERSION&&p.outcome==='NOT_SENT'&&p.basisHash===digest(basis(operation))&&digest(payload)===identity
  &&p.evidence?.nativeDirectoryAbsent===true&&p.evidence.ledgerAttemptAbsent===true&&p.evidence.candidateAbsent===true;
}
const preparationBasis=r=>({id:r.id,status:r.status,error:r.web?.error,binding:r.web?.binding,plan:r.plan,operations:r.operations});
export function sealPreparationProof(run,evidence){
 if(!loadFailure({error:run.web?.error})||run.web?.progress!=='failed'||!run.operations?.length||run.operations.some(o=>o.status!=='completed'||o.error)||evidence.allNativeFinal!==true)fail('PRE_DISPATCH_UNPROVEN','下一个作业尚未创建的准备失败缺少既有FINAL证明');
 const payload={version:'preparation-before-next-operation-v1',basisHash:digest(preparationBasis(run)),evidence,verifiedAt:new Date().toISOString()};return {...payload,identity:digest(payload)};
}
export function isVerifiedPreparationFailure(run){
 const p=run?.web?.localPreparationProof;if(!p||run.web.progress!=='failed'||!loadFailure({error:run.web.error}))return false;
 const {identity,...payload}=p;return p.version==='preparation-before-next-operation-v1'&&p.evidence?.allNativeFinal===true&&p.basisHash===digest(preparationBasis(run))&&identity===digest(payload);
}
