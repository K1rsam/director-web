import {createHash} from 'node:crypto';
import {createEmptyDocument,type FoundationDocument} from './foundation-document';
import type {loadFoundationInputs} from './foundation-state';
import type {SourceRegroupApproval} from '../runtime/source-regroup.mjs';

type Input=Awaited<ReturnType<typeof loadFoundationInputs>>;
export type SourceInterpretationAdoption={
 schema:'SOURCE_INTERPRETATION_ADOPTION_V1';version:'source-interpretation-adoption-v1';id:string;status:'ACTIVE'|'REVOKED';episodes:number[];sourceVersion:string;
 sourceVersions:Record<string,string>;sourceHashes:Record<string,string>;oldInterpretationHashes:Record<string,string|null>;newInterpretationHashes:Record<string,string|null>;
 beforeDocument:{revision:string;digest:string;catalogDigest:string};catalogDigest:string;settingsFingerprint:string;conditionsFingerprint:string;originsDigest:string;
 originalOrigins:FoundationDocument['origins'];approval:SourceRegroupApproval;proofDigest:string;revokedAt?:string;revokedBy?:string;
};
const record=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):record(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
export const sourceInterpretationDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value)),'utf8').digest('hex');
export const sourceInterpretationConditions=(input:Pick<Input,'presentationConditions'|'choiceRegistry'>)=>sourceInterpretationDigest({presentationConditions:input.presentationConditions,choiceRegistry:input.choiceRegistry});
/** Q1 history and free source review remain distinct. No call origin is manufactured. */
export function effectiveEditorialCoverage(document:unknown,expected?:Input|Partial<FoundationDocument>):number[]{
 if(!record(document))return [];
 const original=Array.isArray(document.editorialCoverage)?document.editorialCoverage.filter((n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0):[];
 const result=new Set<number>(original),basis=expected&&'sourceIndex' in expected?createEmptyDocument(expected as Input):expected;
 const conditions=expected&&'choiceRegistry' in expected?sourceInterpretationConditions(expected as Input):undefined;
 if(!record(document.f2)||!Array.isArray(document.sourceInterpretationAdoptions))return [...result].sort((a,b)=>a-b);
 for(const raw of document.sourceInterpretationAdoptions){
  if(!record(raw)||raw.schema!=='SOURCE_INTERPRETATION_ADOPTION_V1'||raw.version!=='source-interpretation-adoption-v1'||raw.status!=='ACTIVE'||!Array.isArray(raw.episodes)||!raw.episodes.length||new Set(raw.episodes).size!==raw.episodes.length)continue;
  const {proofDigest,...proof}=raw;
  if(proofDigest!==sourceInterpretationDigest(proof)||raw.sourceVersion!==document.sourceVersion||raw.catalogDigest!==sourceInterpretationDigest(document.f2)||raw.settingsFingerprint!==document.settingsFingerprint||raw.conditionsFingerprint!==document.sourceInterpretationConditionsFingerprint||raw.originsDigest!==sourceInterpretationDigest(document.origins)||raw.originsDigest!==sourceInterpretationDigest(raw.originalOrigins))continue;
  if(basis&&(basis.sourceVersion!==document.sourceVersion||basis.settingsFingerprint!==raw.settingsFingerprint)||conditions!==undefined&&conditions!==raw.conditionsFingerprint)continue;
  const approval=raw.approval;
  if(!record(approval)||!['SESSION','AUTHORIZED_MAINTENANCE'].includes(approval.origin)||['actorId','ref','explanation'].some(key=>typeof approval[key]!=='string'||!approval[key].trim())||!Number.isFinite(Date.parse(approval.approvedAt)))continue;
  if(!record(raw.beforeDocument)||!raw.beforeDocument.revision||!raw.beforeDocument.digest||raw.beforeDocument.catalogDigest!==raw.catalogDigest||!record(raw.sourceVersions)||!record(raw.sourceHashes)||!record(raw.oldInterpretationHashes)||!record(raw.newInterpretationHashes)||!Array.isArray(raw.originalOrigins))continue;
  if(!raw.episodes.every((number:unknown)=>Number.isSafeInteger(number)&&Number(number)>=0&&document.f2.coverage?.includes(number)&&typeof raw.sourceVersions[String(number)]==='string'&&Object.hasOwn(raw.oldInterpretationHashes,String(number))&&Object.hasOwn(raw.newInterpretationHashes,String(number))&&raw.newInterpretationHashes[String(number)]!==raw.oldInterpretationHashes[String(number)]&&raw.sourceHashes[String(number)]===document.sourceHashes?.[String(number)]&&(!basis||raw.sourceHashes[String(number)]===basis.sourceHashes?.[String(number)])&&['F2','Q1'].every(stage=>raw.originalOrigins.some((origin:any)=>origin.stage===stage&&typeof origin.runId==='string'&&origin.runId&&Array.isArray(origin.scope)&&origin.scope.includes(number)))))continue;
  for(const number of raw.episodes)result.add(number);
 }
 return [...result].sort((a,b)=>a-b);
}
