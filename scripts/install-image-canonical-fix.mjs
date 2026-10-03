import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const once = (source,before,after) => {if(source.split(before).length!==2)throw Error('Canonical patch anchor must occur exactly once');return source.replace(before,after);};

export function patchAdapter(source){
  source=once(source,'  return /^WEB:/i.test(normalizedConversationId(value));',`  return /^WEB:/i.test(normalizedConversationId(value))
    || /^local-chatgpt(?::|%3a)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(normalizedConversationId(value));`);
  source=once(source,'  const responseAppliesToRequest = observationAppliesToRequest && responseBoundaryEstablished;','  let responseAppliesToRequest = observationAppliesToRequest && responseBoundaryEstablished;');
  source=once(source,'  const conversationChanged = conversationIdChanged && !conversationCanonicalized;',`  // director3008: defer identity acceptance, not navigation detection, until native
  // user-message proof arrives. This is restricted to a leased UUID image task in
  // one unchanged extension document; no response or artifact is accepted here.
  const pendingIdentity = currentState?.lastObservation?.data?.pendingImageConversation || null;
  const observedEpoch = String(envelope?.source?.contentEpoch || observation.observerId || '');
  const requestBoundaryStartedAt = Number(currentState?.response?.startedAt) > 0
    ? Number(currentState.response.startedAt) : Number(currentState?.timestamps?.createdAt) || 0;
  const sameImageDocument = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
    && /^extension:tab:\\d+$/.test(clientId)
    && currentState?.source?.clientId === clientId
    && Boolean(currentState?.source?.leaseId)
    && observation.activeRequest?.leaseId === currentState.source.leaseId
    && Boolean(currentState?.source?.ownerServerInstanceId)
    && observation.activeRequest?.ownerServerInstanceId === currentState.source.ownerServerInstanceId
    && Boolean(currentState?.source?.observationEpoch)
    && currentState.source.observationEpoch === observedEpoch
    && Number(currentState?.response?.epoch || 0) === 0;
  const identityConflict = Boolean(pendingIdentity && (
    pendingIdentity.conversationId !== observedConversationId
    || pendingIdentity.observationEpoch !== observedEpoch
    || !sameImageDocument
    || Number(at) - Number(pendingIdentity.startedAt) > 20 * 60 * 1000
  ));
  const awaitingImageConversation = Boolean(
    conversationIdChanged && !conversationCanonicalized && !identityConflict
    && isTemporaryConversationId(expectedConversationId)
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(observedConversationId)
    && observation.url === 'https://chatgpt.com/c/' + observedConversationId
    && sameImageDocument && observationAppliesToRequest
    && !canonicalSubmittedUserTurnKey(currentState)
    && !contentSubmittedUserTurnKey && !observedUserTurnKey
    && requestBoundaryStartedAt > 0 && Number(at) >= requestBoundaryStartedAt
    && Number(at) - requestBoundaryStartedAt <= 20 * 60 * 1000
  );
  const conversationChanged = identityConflict || (conversationIdChanged && !conversationCanonicalized && !awaitingImageConversation);`);
  source=once(source,'  const occurredAt = Number(observation.observedAt || payload.observedAt || at) || 0;','  if (identityConflict || awaitingImageConversation) responseAppliesToRequest = false;\n  const occurredAt = Number(observation.observedAt || payload.observedAt || at) || 0;');
  source=once(source,"    conversationId: bindingEstablished ? observation.conversationId || payload.session?.id || '' : '',", "    conversationId: awaitingImageConversation || identityConflict ? expectedConversationId : bindingEstablished ? observation.conversationId || payload.session?.id || '' : '',");
  source=once(source,'    conversationCanonicalized,',`    conversationCanonicalized: conversationCanonicalized && !identityConflict,
    pendingImageConversation: awaitingImageConversation ? {
      conversationId: observedConversationId,
      observationEpoch: observedEpoch,
      startedAt: pendingIdentity?.startedAt || Number(at),
    } : null,`);
  return source;
}
export function patchLifecycle(source){return once(source,'          ...applySourceData(state, { ...data, connection: SourceConnection.CONNECTED }, event),',`          // director3008: heartbeats prove liveness, never conversation identity.
          // Preserve the temporary UUID-task identity until the observation
          // reducer sees the native submitted-user boundary. client.changed
          // can emit this heartbeat before its canonical observation.
          ...applySourceData(state, { ...data,
            ...(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(state.requestId)
              && /^extension:tab:\\d+$/.test(state.source?.clientId || '')
              && /^(?:WEB:|local-chatgpt(?::|%3a)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$)/i.test(state.source?.conversationId || '')
              ? { conversationId: state.source.conversationId } : {}),
            connection: SourceConnection.CONNECTED }, event),`);}

export const canonicalFixSpecs=[
  {relative:'src/bridge/adapters/tabObservationAdapter.js',original:'4671565baa1dc0573c434144ea0021abdfe9338e43c055a2bbb56f0a0b968bcc',legacy:'db75b3894ac3da752fde961f537c1bc1c34bcfaa860c72702ebabe59f655a77e',patch:patchAdapter},
  {relative:'src/bridge/state/requestLifecycleTransitions.js',original:'271ffa7267a0a3539994be52e56a7edf70638a1442b35e5fbaba4115dd84cbcc',legacy:'c53f532c4815af6f4ed513ab9ddda81d6a30e6325ce8a6fbe7191a6ae7ee2324',patch:patchLifecycle},
];
export function acceptsCanonicalPreimage(spec,current,after){return [spec.original,spec.legacy,sha(after)].includes(sha(current));}
export async function install(home){
  if(!home||!path.isAbsolute(home))throw Error('Absolute Bridge home required');
  const specs=canonicalFixSpecs;
  const root=fileURLToPath(new URL('..',import.meta.url));
  const backupDir=path.join(root,'runtime-3008/bridge-image-canonical-fix');
  const changes=[];
  for(const spec of specs){
    const file=path.join(home,spec.relative),current=await readFile(file,'utf8');
    const backup=path.join(backupDir,path.basename(file)+'.original');
    const original=sha(current)===spec.original?current:await readFile(backup,'utf8');
    if(sha(original)!==spec.original)throw Error('Canonical patch preimage hash mismatch');
    const after=spec.patch(original);
    if(!acceptsCanonicalPreimage(spec,current,after))throw Error('Canonical vendor source drift; refused');
    changes.push({file,backup,original,current,after});
  }
  await mkdir(backupDir,{recursive:true});
  for(const change of changes){
    await writeFile(change.backup,change.original,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    if(sha(await readFile(change.backup))!==sha(change.original))throw Error('Canonical backup drift; refused');
  }
  for(const change of changes)if(sha(await readFile(change.file))!==sha(change.current))throw Error('Concurrent canonical source drift; refused');
  for(const change of changes)if(change.current!==change.after)await writeFile(change.file,change.after);
  for(const change of changes)if(sha(await readFile(change.file))!==sha(change.after))throw Error('Canonical installed postimage mismatch');
  await writeFile(path.join(backupDir,'install-receipt.json'),JSON.stringify({version:2,upstream:'671815e1939db9effb556ea7ef67673fc21e4121',home,installedAt:new Date().toISOString(),files:changes.map(change=>({relative:path.relative(home,change.file),originalSha256:sha(change.original),beforeSha256:sha(change.current),afterSha256:sha(change.after),backup:change.backup}))},null,2)+'\n');
  console.log('Installed bounded native image conversation identity guard; proof and artifact requirements unchanged.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await install(process.argv[2]);
