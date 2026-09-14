import type { FidelityReceipt } from './fidelity-import';
import type { P1ReviewState } from './fidelity-p1-review';
import { createFidelityExternalMaterial } from './fidelity-external';

export type SourceReviewCandidate={kind:'ALIAS'|'QUESTION';sourceVersion:string;ranges:Array<{start:number;end:number}>;episodes:number[];detail:Record<string,unknown>};
export function fidelityReviewCandidates(receipt:FidelityReceipt):SourceReviewCandidate[]{
 const result:SourceReviewCandidate[]=[];
 const add=(kind:SourceReviewCandidate['kind'],ranges:Array<{start:number;end:number}>,detail:Record<string,unknown>)=>{
  if(!ranges.length||ranges.some(({start,end})=>!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>receipt.result.source.text.length))return;
  const unique=[...new Map(ranges.map(r=>[`${r.start}:${r.end}`,{start:r.start,end:r.end}])).values()].sort((a,b)=>a.start-b.start);
  result.push({kind,sourceVersion:receipt.readingHash,ranges:unique,episodes:receipt.result.episodes.filter(e=>e.productionEligible&&unique.some(r=>e.start<r.end&&e.end>r.start)).map(e=>e.number),detail});
 };
 const review=receipt.p1Review as P1ReviewState|undefined;
 if(review?.status==='COMPLETE'&&review.reviewedSourceVersion===receipt.readingHash){
  for(const a of review.aliases??[])add('ALIAS',[a],{names:[a.alias,a.canonicalCandidate],note:a.note});
  for(const q of review.unresolved??[])add('QUESTION',[q],{question:q.note,...(q.routing?.kind==='QUESTION'&&q.routing.sourceVersion===receipt.readingHash?{structureStatus:'EXPLICIT_SOURCE_OWNERSHIP_VERIFIED',questionStatus:'OPEN',originalKind:q.kind}: {})});
 }
 const external=receipt.externalReview;
 if(external?.sourceVersion===receipt.readingHash){
  const blocks=new Map(createFidelityExternalMaterial(receipt.result.source.text).blocks.map(b=>[b.id,b]));
  for(const [kind,rows] of [['ALIAS',external.aliases],['QUESTION',external.questions]] as const)for(const row of rows){
   const evidence=Array.isArray(row.evidence)?row.evidence.map(id=>blocks.get(String(id))).filter(b=>!!b):[];
   if(evidence.length)add(kind,evidence,row);
  }
 }
 return result;
}
export function selectSourceReviewCandidates(rows:SourceReviewCandidate[],scope:number[],sourceText:string){
 return rows.filter(row=>row.episodes.some(n=>scope.includes(n))||row.kind==='ALIAS'&&Array.isArray(row.detail.names)&&row.detail.names.some(name=>typeof name==='string'&&sourceText.includes(name)));
}
