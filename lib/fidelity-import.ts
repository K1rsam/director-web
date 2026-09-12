import { createHash } from "node:crypto";
import { parseScriptBuffer, type ImportedScript, type SourceSection } from "@/lib/import-script";
import { CONTRACT_VERSION, createSource, normalize } from "../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs";
import { validatePlan as validateLegacyPlan } from './fidelity-legacy.mjs';
import { readFidelityArchive } from './fidelity-package';
import { isFidelityExternalText, parseFidelityExternalResult, type ExternalReviewMetadata } from './fidelity-external';
import { coalesceFidelityDecisions } from './fidelity-decision-ranges';
export type FidelityDecision = { start:number; end:number; kind:"body"|"context"; note:string; episodeNumber?:number; sceneNumber?:number };
export type FidelitySegment = {id:string; start:number; end:number; kind:string; episodeId:string|null; sceneId:string|null; sourceNumber:string|null; productionEligible:boolean; reason:string; speakerLabels:string[]; text:string};
export type FidelityResult = {contractVersion:string; source:{text:string;sourceVersion:string;length:number;coordinateSystem:string};plan:Record<string,unknown>;validation:{ok:boolean;errors:{code:string;message:string}[];issues:{code:string;message:string;start:number;end:number}[]};normalizedText:string;segments:FidelitySegment[];episodes:{id:string;number:number;sourceNumber:string;title:string;content:string;start:number;end:number;productionEligible:boolean;scenes:unknown[]}[];contextText:string};
export type FidelityReceipt = {schema:"FIDELITY_RECEIPT_V1";sourceImportId?:string;externalPackage?:{sourceName:string;hash:string};externalReview?:ExternalReviewMetadata;p1Review?:{status:'PENDING'|'COMPLETE';reviewedSourceVersion?:string;completedRanges?:Array<{start:number;end:number}>;runIds?:string[];pendingDecisions?:FidelityDecision[];unresolved?:Array<{start:number;end:number;note:string}>};mode:"fidelity"|"direct";originalHash:string;readingHash:string;reader:ImportedScript["readingView"];guarantee:string;result:FidelityResult;decisions:FidelityDecision[]};
export async function prepareFidelityImport(name:string,bytes:Buffer,mode:"fidelity"|"direct",decisions:FidelityDecision[]=[],trustedExternalDecisions=false,original?:{name:string;bytes:Buffer}) {
 let imported:ImportedScript; let candidate:Record<string,unknown>|undefined;let externalReview:ExternalReviewMetadata|undefined;
 const uploadName=name,uploadBytes=bytes;
 if (/\.zip$/i.test(name)) {
  const unpacked=await readFidelityArchive(bytes);name=unpacked.name;bytes=unpacked.bytes;original??=unpacked.original;mode='direct';
 }
 if(original&&mode!=="direct")throw new Error("配对原稿仅用于已清洗直接导入。");
 if (/\.json$/i.test(name)) {
  const external=JSON.parse(bytes.toString("utf8"));
  if(!external.source || typeof external.source.text!=="string" || !external.plan)throw new Error("回导包需要 source.text 与 plan；请使用当前 Skill 导出。");
  const actualSource=createSource(external.source.text);
  if(external.source.sourceVersion!==actualSource.sourceVersion||external.source.length!==actualSource.length||external.source.coordinateSystem!=='utf16')throw new Error('回导包的来源文本与版本信息不一致，请使用完整清洗结果。');
  imported={sourceName:name,sourceText:external.source.text,episodes:[],sourceStructure:{version:"SOURCE_STRUCTURE_V1",sections:[],issues:[]},readingView:{kind:"TEXT",encoding:"utf-8",view:"EXTERNAL_FIDELITY_PACKAGE",warnings:["外部包中的读取文本是本次比对基线；未另附原件时，不证明外部处理前的原稿保真。"]},originalFile:{encoding:"base64",mediaType:"text/plain",base64:bytes.toString("base64")}};candidate=external.plan;
  if (Array.isArray(external.plan.decisions) && external.plan.decisions.length) {
   if (!trustedExternalDecisions) throw new Error("回导包包含外部边界决定；尚未获得采用权限。请先核对这些范围并明确采用，或导入原稿后在来源页面重新确认。");
   if (!decisions.length) decisions=external.plan.decisions;
  }
  if(original){imported=await readPairedOriginal(original,external.source.text);}
  if (external.plan.contractVersion === 'fidelity/1' && CONTRACT_VERSION !== 'fidelity/1') {
   const validation=validateLegacyPlan(external.source,external.plan,{decisions});
   if(!validation.ok)throw new Error('旧清洗包的来源或计划被修改，无法升级：'+validation.errors[0]?.message);
   candidate=undefined;
   imported.readingView.warnings.push('已核验旧清洗包，按新版规则重新识别集场；原文和已采用决定保留。');
  }
 } else {
  imported=await parseScriptBuffer(name,bytes);
  if(isFidelityExternalText(imported.sourceText)) {
   if(!original)throw new Error('这份文件是结构归属计划，请同时上传生成材料时使用的原稿；计划不包含正文。');
   const response=/\.docx$/i.test(name)?await parseScriptBuffer(name,bytes,{docxParagraphSeparator:'\n'}):imported;
   let baseline=await parseScriptBuffer(original.name,original.bytes);
   if(!response.sourceText.includes(`SOURCE ${createSource(baseline.sourceText).sourceVersion}`)&&/\.docx$/i.test(original.name))baseline=await parseScriptBuffer(original.name,original.bytes,{docxParagraphSeparator:'\n'});
   const parsed=await parseFidelityExternalResult(baseline.sourceText,response.sourceText);
   if(decisions.length)throw new Error('外部结构计划与另附决定不能混用，请先导入后按来源版本修改。');
   decisions=coalesceFidelityDecisions(baseline.sourceText,parsed.decisions);externalReview=parsed.metadata;imported=baseline;
  } else {
  if (/<!-- source-range:\d+:\d+;kind=/.test(imported.sourceText)) throw new Error('这份MD是带来源标记的阅读预览。请直接上传清洗ZIP包，或上传其中的回导JSON；无需挑选其它文件。');
  if(original)imported=await readPairedOriginal(original,imported.sourceText);
  }
 }
 const prepared=prepareFidelityReading(imported,mode,decisions,createHash("sha256").update(original?.bytes??bytes).digest("hex"),candidate);
 if(externalReview)prepared.receipt.externalReview=externalReview;
 if(/\.(json|zip)$/i.test(uploadName)||original){prepared.receipt.externalPackage={sourceName:uploadName,hash:createHash('sha256').update(uploadBytes).digest('hex')};prepared.receipt.guarantee=original?'已与配对原稿的读取文本逐字验证；原稿原字节及读取警告保留，保证范围以读取视图为准。':'未配对原稿：仅证明当前清洗稿的结构与内部一致性，不证明外部处理前的原稿保真。';}
 return prepared;
}
async function readPairedOriginal(original:{name:string;bytes:Buffer},expected:string) {
 let actual=await parseScriptBuffer(original.name,original.bytes);
 if(actual.sourceText!==expected && /\.docx$/i.test(original.name))actual=await parseScriptBuffer(original.name,original.bytes,{docxParagraphSeparator:'\n'});
 if(actual.sourceText!==expected)throw new Error('原稿与清洗结果的读取文本不一致，不能证明原稿保真。可先不配对原稿，将清洗文件作为新工作稿导入；原件请保留。');
 return actual;
}
export function prepareFidelityReading(imported:ImportedScript,mode:"fidelity"|"direct",decisions:FidelityDecision[],originalHash:string,candidate?:Record<string,unknown>) {
 const result=normalize(createSource(imported.sourceText),{decisions,...(candidate?{plan:candidate}:{})}) as unknown as FidelityResult;
 const effectiveIssues=result.validation.issues.filter(issue=>!(issue.code==='DUPLICATE_EPISODE_NUMBER'&&decisions.some(d=>d.start<=issue.start&&d.end>=issue.end)));
 result.validation={...result.validation,issues:effectiveIssues};
 const pendingIssues=effectiveIssues.filter(i=>['ZERO_EPISODE_UNCONFIRMED','DUPLICATE_EPISODE_NUMBER'].includes(i.code));
 const episodes=result.episodes.filter(e=>e.productionEligible&&!pendingIssues.some(issue=>issue.start>=e.start&&issue.start<e.end));
 const sections:SourceSection[]=[];
 for(const segment of result.segments){const ep=episodes.find(e=>e.id===segment.episodeId);const kind=segment.kind==="context"?"BACKGROUND":ep?"EPISODE":"UNRESOLVED";
 const previous=sections.at(-1);if(previous && previous.kind===kind && previous.episodeNumber===ep?.number && previous.end===segment.start)previous.end=segment.end;
 else sections.push({key:segment.id,kind,start:segment.start,end:segment.end,...(ep?{episodeNumber:ep.number,boundaryBasis:"EXPLICIT_HEADING" as const}:{})});}
 // Whitespace has an owner too; source-only whitespace must not create an unresolved task.
 for(let i=0;i<sections.length;i++)if(sections[i].kind==="UNRESOLVED"&&!imported.sourceText.slice(sections[i].start,sections[i].end).trim()){sections[i].kind="BACKGROUND";}
 const readingIssues=imported.sourceStructure.issues.filter(i=>i.code.startsWith("DOCX_"));
 imported={...imported,episodes:episodes.map(e=>({number:e.number,title:e.title,content:e.content})),sourceStructure:{version:"SOURCE_STRUCTURE_V1",sections,issues:[...readingIssues,...effectiveIssues.map(i=>({code:i.code,message:i.message,sectionKeys:sections.filter(s=>s.start<i.end&&s.end>i.start).map(s=>s.key)}))]}};
 const receipt:FidelityReceipt={schema:"FIDELITY_RECEIPT_V1",mode,originalHash,readingHash:result.source.sourceVersion,reader:imported.readingView,guarantee:mode==="direct"?"已清洗直入：相对于本次读取文本逐字验证；未提供原稿时仅证明本次结构与内部一致性。":"原上传字节独立保存；锁定内容相对于读取视图逐字、按来源位置完整验证。",result,decisions};
 assertFidelityMaterialization(imported,receipt);
 return {imported,receipt};
}

/** One deterministic boundary contract is shared by imports and decisions. */
export function assertFidelityMaterialization(imported:ImportedScript,receipt:FidelityReceipt) {
 if(imported.sourceText!==receipt.result.source.text || createHash('sha256').update(imported.sourceText).digest('hex')!==receipt.readingHash)throw new Error('读取文本与保真凭据版本不一致。');
 let end=0;const seen=new Set<number>();
 for(const section of imported.sourceStructure.sections){if(section.start!==end||section.end<section.start||section.end>imported.sourceText.length)throw new Error('来源分区未完整且唯一覆盖原文。');end=section.end;}
 if(end!==imported.sourceText.length)throw new Error('来源尾部未覆盖。');
 for(const episode of imported.episodes){
  if(seen.has(episode.number))throw new Error('展示集号重复。');seen.add(episode.number);
  const expected=imported.sourceStructure.sections.filter(s=>s.kind==='EPISODE'&&s.episodeNumber===episode.number).map(s=>imported.sourceText.slice(s.start,s.end)).join('');
  if(expected!==episode.content)throw new Error('来源分区与实际分集正文不一致（包括空白）。');
 }
 if(imported.sourceStructure.sections.some(s=>s.kind==='EPISODE'&&!seen.has(s.episodeNumber!)))throw new Error('来源分集缺少实际正文。');
 if(imported.originalFile && createHash('sha256').update(Buffer.from(imported.originalFile.base64,'base64')).digest('hex')!==receipt.originalHash)throw new Error('原上传字节与hash不一致。');
}
