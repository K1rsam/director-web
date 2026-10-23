import {createHash} from 'node:crypto';
import type {Prisma,PrismaClient} from '@prisma/client';
import {prisma} from './prisma';
import {assertNoActiveFoundationDelivery} from './foundation-choice-store';

const SCHEMA='SOURCE_READING_CONFIRMATION_V1';
export const REVISION_READING_ISSUE='DOCX_REVISION_VIEW_UNRESOLVED';
type Db=Pick<Prisma.TransactionClient,'sceneSnapshot'>;
type Source={id:string;content:string;metadata:string|null};
export type SourceReadingBinding={sourceImportId:string;readingHash:string;originalHash:string;readerFingerprint:string};
export type SourceReadingState={required:boolean;binding:SourceReadingBinding|null;confirmed:boolean;confirmationId:string|null;confirmedAt:string|null};
export type SourceReadingConfirmationRequest=SourceReadingBinding&{projectId:string;userId:string;choice:'USE_CURRENT_READING';confirmed:boolean};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const record=(value:string|null):Record<string,unknown>=>{try{const v:unknown=JSON.parse(value??'null');return v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};}catch{return {};}};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** The form must describe the same source as the text actually rendered. A
 * separately loaded newer import is not permission to confirm unseen text. */
export function bindSourceReadingToDisplayedReceipt(state:SourceReadingState,receipt:{sourceImportId?:string;readingHash:string;originalHash:string;reader:unknown;result:{source:{text:string}}}):SourceReadingState{
 if(!state.binding)return state;
 const b=state.binding;
 return receipt.sourceImportId===b.sourceImportId&&receipt.readingHash===b.readingHash&&hash(receipt.result.source.text)===b.readingHash
  &&receipt.originalHash===b.originalHash&&hash(JSON.stringify(receipt.reader))===b.readerFingerprint?state
  :{...state,binding:null,confirmed:false,confirmationId:null,confirmedAt:null};
}

/** A separate human receipt projects one reading warning only. Raw import,
 * tracked revisions, source decisions and paid-work fingerprints never change. */
export async function readSourceReadingState(projectId:string,db:Db=prisma,source?:Source):Promise<SourceReadingState>{
 const current=source??await db.sceneSnapshot.findFirst({where:{projectId,sceneKey:'SOURCE_IMPORT'},orderBy:[{createdAt:'desc'},{id:'desc'}]});
 const empty:SourceReadingState={required:false,binding:null,confirmed:false,confirmationId:null,confirmedAt:null};
 if(!current)return empty;
 const body=record(current.content),structure=body.sourceStructure,reader=body.readingView,original=body.originalFile;
 if(!object(structure)||!Array.isArray(structure.issues)||!structure.issues.some(i=>object(i)&&i.code===REVISION_READING_ISSUE))return empty;
 empty.required=true;
 if(record(current.metadata).schema!=='IMPORTED_SOURCE_TEXT_V2'||typeof body.sourceText!=='string'||!object(reader)||reader.kind!=='DOCX'
  ||typeof reader.view!=='string'||!Array.isArray(reader.warnings)||!reader.warnings.every(w=>typeof w==='string')
  ||!object(original)||original.encoding!=='base64'||typeof original.base64!=='string'||!original.base64
  ||!/^[A-Za-z0-9+/]*={0,2}$/.test(original.base64))return empty;
 const bytes=Buffer.from(original.base64,'base64');if(bytes.toString('base64')!==original.base64)return empty;
 const binding={sourceImportId:current.id,readingHash:hash(body.sourceText),originalHash:hash(bytes),readerFingerprint:hash(JSON.stringify(reader))};
 const saved=await db.sceneSnapshot.findFirst({where:{projectId,sceneKey:'SOURCE_READING_CONFIRMATION'},orderBy:[{createdAt:'desc'},{id:'desc'}]});
 const proof=record(saved?.content??null);
 const confirmed=proof.schema===SCHEMA&&proof.authority==='USER_EXPLICIT'&&proof.choice==='USE_CURRENT_READING'
  &&typeof proof.userId==='string'&&!!proof.userId&&typeof proof.confirmedAt==='string'&&Number.isFinite(Date.parse(proof.confirmedAt))
  &&Object.entries(binding).every(([key,value])=>proof[key]===value);
 return {required:true,binding,confirmed,confirmationId:confirmed?saved!.id:null,confirmedAt:confirmed?proof.confirmedAt as string:null};
}

export function projectSourceReadingIssues<T extends {code:string}>(issues:readonly T[],state:SourceReadingState):T[]{
 return issues.filter(issue=>!state.confirmed||issue.code!==REVISION_READING_ISSUE);
}

/** No queue/worker/model capability. Authentication is rechecked transactionally. */
export async function confirmSourceReading(request:SourceReadingConfirmationRequest,db:PrismaClient=prisma){
 if(request.confirmed!==true||request.choice!=='USE_CURRENT_READING')throw new Error('请明确确认采用当前读取文本；此操作不接受或拒绝 Word 修订。');
 return db.$transaction(async tx=>{
  if(typeof request.userId!=='string'||!request.userId||!await tx.projectRole.count({where:{projectId:request.projectId,userId:request.userId,role:{in:['ADMIN','REVIEWER']}}}))throw new Error('需要本项目管理员或审阅者确认读取版本。');
  const current=await readSourceReadingState(request.projectId,tx);
  if(!current.required||!current.binding||!Object.entries(current.binding).every(([key,value])=>request[key as keyof SourceReadingBinding]===value))throw new Error('来源或读取版本已变化，请核对最新读取文本后再确认。');
  await assertNoActiveFoundationDelivery(tx,request.projectId);
  if(await tx.pipelineRun.findFirst({where:{projectId:request.projectId,status:{in:['RUNNING','QUEUED']}}}))throw new Error('项目仍有正在执行或在途任务，未改变读取确认。');
  if(current.confirmed)return {id:current.confirmationId!,changed:false};
  const proof={schema:SCHEMA,...current.binding,choice:'USE_CURRENT_READING',authority:'USER_EXPLICIT',userId:request.userId,confirmedAt:new Date().toISOString(),scope:[REVISION_READING_ISSUE]};
  const saved=await tx.sceneSnapshot.create({data:{projectId:request.projectId,sceneKey:'SOURCE_READING_CONFIRMATION',title:'用户确认当前读取文本（原件及修订保留）',content:JSON.stringify(proof),metadata:JSON.stringify({schema:SCHEMA,sourceImportId:current.binding.sourceImportId})}});
  return {id:saved.id,changed:true};
 });
}
