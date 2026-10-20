import {createHash} from 'node:crypto';
import {digest} from './shared.mjs';
import {isDirectorRefinement,refinementAssemblyHash} from './director-refinement.mjs';

const textHash=text=>typeof text==='string'?createHash('sha256').update(text).digest('hex'):null;

// Resolve only the baseline frozen for this candidate. A later assembly must not
// silently become the old side of a comparison after adoption or other changes.
export function getRefinementBase(d,candidate){
 const op=d?.operations?.find(o=>o.attemptId===candidate?.attemptId&&isDirectorRefinement(o));
 const expected=op?.refinement?.baseAssemblyHash;
 if(!isDirectorRefinement(candidate)||!expected||candidate.refinement?.baseAssemblyHash!==expected)return null;
 const archive=d.refinementArchives?.find(a=>a.candidateId===candidate.id&&a.baseAssemblyHash===expected);
 if(archive)return refinementAssemblyHash(archive)===expected?archive.assembly:null;
 return refinementAssemblyHash(d)===expected?d.assembly:null;
}

const indexById=rows=>{
 if(!Array.isArray(rows))return null;
 const indexed=new Map();
 for(const row of rows){
  if(!row||typeof row.id!=='string'||!row.id||indexed.has(row.id))return null;
  indexed.set(row.id,row);
 }
 return indexed;
};
const changedIds=(before,after)=>before&&after?[...new Set([...before.keys(),...after.keys()])].filter(id=>!before.has(id)||!after.has(id)||digest(before.get(id))!==digest(after.get(id))):[];
const shotIndex=units=>units&&[...units.values()].every(u=>Array.isArray(u.shots))?indexById([...units.values()].flatMap(u=>u.shots)):null;

export function getRefinementComparison(d,candidate){
 const base=getRefinementBase(d,candidate),candidateText=candidate?.adoptedRefinement?.text??candidate?.previewText;
 const result={status:'unavailable',baseTextHash:textHash(base?.text),candidateTextHash:textHash(candidateText),changedUnitIds:[],changedShotIds:[]};
 if(typeof base?.text!=='string'||!base.text||base.validation?.errors?.length!==0||typeof candidateText!=='string'||!candidateText)return result;
 // Preserve every punctuation mark, timecode and whitespace character.
 result.status=base.text===candidateText?'unchanged':'changed';
 if(result.status==='changed'){
  const before=indexById(base.draft?.units),after=indexById((candidate.adoptedRefinement?.draft??candidate.draft)?.units);
  result.changedUnitIds=changedIds(before,after);
  result.changedShotIds=changedIds(shotIndex(before),shotIndex(after));
 }
 return result;
}
