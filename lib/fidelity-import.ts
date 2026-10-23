import { createHash } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import { parseEpisodeNumber, parseScriptBuffer, type ImportedScript, type SourceSection } from "@/lib/import-script";
import { CONTRACT_VERSION, createSource, normalize } from "../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs";
import { validatePlan as validateLegacyPlan } from './fidelity-legacy.mjs';
import { validatePlan as validateV2Plan } from './fidelity-v2.mjs';
import { validatePlan as validateV3Plan } from './fidelity-v3.mjs';
import { validatePlan as validateV4Plan } from './fidelity-v4.mjs';
import { validatePlan as validateV5Plan } from './fidelity-v5.mjs';
import { readFidelityArchive } from './fidelity-package';
import { isFidelityExternalText, parseFidelityExternalResult, type ExternalReviewMetadata } from './fidelity-external';
import { coalesceFidelityDecisions } from './fidelity-decision-ranges';
import { cleanupScriptText, removeBlankScriptLines } from './source-cleaning';
export type FidelityDecision = { start:number; end:number; kind:"body"|"context"; note:string; episodeNumber?:number; sceneNumber?:number };
export type FidelitySegment = {id:string; start:number; end:number; kind:string; episodeId:string|null; sceneId:string|null; sourceNumber:string|null; productionEligible:boolean; reason:string; speakerLabels:string[]; text:string};
export type FidelitySourceEpisodeBranch={reason:'SOURCE_EPISODE_BRANCH_UNRESOLVED';episodeNumber:number;sourceVersion:string;candidates:Array<{episodeId:string;start:number;end:number;firstLine:number;lastLine:number;sourceRefs:string[]}>};
export type FidelityIssue={code:string;message:string;start:number;end:number;owner?:'USER';reason?:FidelitySourceEpisodeBranch['reason'];episodeNumber?:number;sourceRefs?:string[]};
export const isFidelitySourceBranchIssue=(issue:{code:string;reason?:string})=>issue.code==='DUPLICATE_EPISODE_NUMBER'&&issue.reason==='SOURCE_EPISODE_BRANCH_UNRESOLVED';
export type FidelityResult = {contractVersion:string; source:{text:string;sourceVersion:string;length:number;coordinateSystem:string};plan:Record<string,unknown>;validation:{ok:boolean;errors:{code:string;message:string}[];issues:FidelityIssue[]};normalizedText:string;segments:FidelitySegment[];episodes:{id:string;number:number;sourceNumber:string;title:string;content:string;start:number;end:number;productionEligible:boolean;scenes:unknown[]}[];contextText:string};
export type FidelityReceipt = {schema:"FIDELITY_RECEIPT_V1";episodeNumbering?:'SOURCE_NUMBER_V1'|'PRODUCTION_ORDER_V1';sourceEpisodeBranches?:FidelitySourceEpisodeBranch[];sourceBranchDecisions?:FidelityDecision[];sourceImportId?:string;externalPackage?:{sourceName:string;hash:string};externalReview?:ExternalReviewMetadata;p1Review?:import('./fidelity-p1-review').P1ReviewState;mode:"fidelity"|"direct";originalHash:string;readingHash:string;reader:ImportedScript["readingView"];guarantee:string;result:FidelityResult;decisions:FidelityDecision[]};
const PRODUCTION_NUMBER_WARNING='部分源集号不明确、超出安全整数范围或重复；本次整份保留生产顺序编号，未猜测非数字标题的集号，原文与原标题完整保留。';
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
  if (['fidelity/1','fidelity/2','fidelity/3','fidelity/4','fidelity/5'].includes(external.plan.contractVersion) && external.plan.contractVersion !== CONTRACT_VERSION) {
   const validation=(external.plan.contractVersion === 'fidelity/1' ? validateLegacyPlan : external.plan.contractVersion === 'fidelity/2' ? validateV2Plan : external.plan.contractVersion === 'fidelity/3' ? validateV3Plan : external.plan.contractVersion === 'fidelity/4' ? validateV4Plan : validateV5Plan)(external.source,external.plan,{decisions});
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
 // New uploads (including external JSON) receive a working-text projection. Old
 // pinned review/refresh callers do not acquire this policy implicitly.
 if(!imported.readingView.blankLineCleanup)imported={...imported,readingView:{...imported.readingView,blankLineCleanup:{version:'SCRIPT_BLANK_LINES_V1',removedRanges:cleanupScriptText(imported.sourceText).removedRanges}}};
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
export function prepareFidelityReading(imported:ImportedScript,mode:"fidelity"|"direct",decisions:FidelityDecision[],originalHash:string,candidate?:Record<string,unknown>,sourceBranchDecisions:FidelityDecision[]=[]) {
 const result=normalize(createSource(imported.sourceText),{decisions,...(candidate?{plan:candidate}:{})}) as unknown as FidelityResult;
 // Repeated title-only rows are formatting. Two independently retained body
 // episodes with the same source number are a source choice, not permission to
 // choose the first branch, merge their stories, or renumber the entire series.
 // Only the authenticated local source-decision endpoint supplies this separate
 // basis. P1 decisions, uploaded JSON fields and unproven historical decisions
 // cannot promote themselves into permission to choose/merge/renumber branches.
 const branchBasis=normalize(result.source,{decisions:sourceBranchDecisions}) as FidelityResult;
 const grouped=new Map<number,FidelityResult['episodes']>();
 for(const episode of branchBasis.episodes.filter(e=>e.productionEligible)){
  const number=parseEpisodeNumber(episode.sourceNumber);
  if(number!==null&&Number.isSafeInteger(number)&&number>=0)grouped.set(number,[...(grouped.get(number)??[]),episode]);
 }
 const duplicateGroups=[...grouped].filter(([,episodes])=>episodes.length>1);
 const rawBodies=new Set(duplicateGroups.length?(normalize(result.source) as FidelityResult).segments.filter(row=>row.kind==='body'&&row.text.trim()).map(row=>`${row.start}:${row.end}`):[]);
 const sourceEpisodeBranches:FidelitySourceEpisodeBranch[]=duplicateGroups.flatMap(([episodeNumber,episodes])=>{
  const bodies=episodes.filter(episode=>branchBasis.segments.some(row=>row.episodeId===episode.id&&row.kind==='body'&&rawBodies.has(`${row.start}:${row.end}`)));
  if(bodies.length<2)return [];
  const lines=[...imported.sourceText.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)];
  return [{reason:'SOURCE_EPISODE_BRANCH_UNRESOLVED',episodeNumber,sourceVersion:result.source.sourceVersion,candidates:bodies.map(episode=>({episodeId:episode.id,start:episode.start,end:episode.end,
   firstLine:lines.findIndex(line=>line.index!+line[0].length>episode.start)+1,lastLine:lines.filter(line=>line.index!<episode.end).length,
   sourceRefs:[`${result.source.sourceVersion}:${episode.start}:${episode.end}`]}))}];
 });
 const protectedRanges=sourceEpisodeBranches.flatMap(branch=>branch.candidates);
 // P1 can change derived episode ids/numbers, so protection follows raw source
 // intervals rather than relying on identity equality with the baseline.
 const blockedEpisodes=new Set(result.episodes.filter(e=>protectedRanges.some(c=>e.start<c.end&&e.end>c.start)).map(e=>e.id));
 const branchIssues:FidelityIssue[]=sourceEpisodeBranches.map(branch=>({code:'DUPLICATE_EPISODE_NUMBER',reason:branch.reason,owner:'USER',episodeNumber:branch.episodeNumber,
  start:Math.min(...branch.candidates.map(c=>c.start)),end:Math.max(...branch.candidates.map(c=>c.end)),sourceRefs:branch.candidates.flatMap(c=>c.sourceRefs),
  message:`第${branch.episodeNumber}集有${branch.candidates.length===2?'两段':`${branch.candidates.length}段`}不同来源正文（原行 ${branch.candidates.map(c=>`${c.firstLine}–${c.lastLine}`).join('、')}）。尚未决定同集续段或其它源文归属；全部原文保留，这些候选暂不进入生产，未选择首段、合并或重编号。请核对对应原文。`}));
 const effectiveIssues=[...result.validation.issues.filter(issue=>!(issue.code==='DUPLICATE_EPISODE_NUMBER'&&(decisions.some(d=>d.start<=issue.start&&d.end>=issue.end)||sourceEpisodeBranches.some(branch=>branch.candidates.some(c=>issue.start>=c.start&&issue.start<c.end))))),...branchIssues];
 result.validation={...result.validation,issues:effectiveIssues};
 const pendingIssues=effectiveIssues.filter(i=>['ZERO_EPISODE_UNCONFIRMED','DUPLICATE_EPISODE_NUMBER'].includes(i.code));
 const episodes=result.episodes.filter(e=>e.productionEligible&&!blockedEpisodes.has(e.id)&&!pendingIssues.some(issue=>issue.start>=e.start&&issue.start<e.end));
 const sourceNumbers=episodes.map(episode=>typeof episode.sourceNumber==='string'&&episode.sourceNumber.trim()?parseEpisodeNumber(episode.sourceNumber):null);
 const sourceNumbered=sourceNumbers.every(number=>number!==null&&Number.isSafeInteger(number)&&number>=0)&&new Set(sourceNumbers).size===sourceNumbers.length;
 const episodeNumbering=sourceNumbered?'SOURCE_NUMBER_V1':'PRODUCTION_ORDER_V1';
 // Result/plan retain their original production ordinals; only this materialized view uses source numbers.
 const episodeNumbers=new Map(episodes.map((episode,index)=>[episode.id,sourceNumbered?sourceNumbers[index]!:episode.number]));
 const sections:SourceSection[]=[];
 for(const segment of result.segments){const ep=episodes.find(e=>e.id===segment.episodeId),number=ep?episodeNumbers.get(ep.id):undefined;const kind=protectedRanges.some(c=>segment.start<c.end&&segment.end>c.start)?"UNRESOLVED":segment.kind==="context"?"BACKGROUND":ep?"EPISODE":"UNRESOLVED";
 const previous=sections.at(-1);if(previous && previous.kind===kind && previous.episodeNumber===number && previous.end===segment.start)previous.end=segment.end;
 else sections.push({key:ep&&sourceNumbered?`EPISODE-${number}-${segment.start}`:segment.id,kind,start:segment.start,end:segment.end,...(ep?{episodeNumber:number,boundaryBasis:"EXPLICIT_HEADING" as const}:{})});}
 // Whitespace has an owner too; source-only whitespace must not create an unresolved task.
 for(let i=0;i<sections.length;i++)if(sections[i].kind==="UNRESOLVED"&&!imported.sourceText.slice(sections[i].start,sections[i].end).trim()){sections[i].kind="BACKGROUND";}
 const readingIssues=imported.sourceStructure.issues.filter(i=>i.code.startsWith("DOCX_"));
 imported={...imported,episodes:episodes.map(e=>({number:episodeNumbers.get(e.id)!,title:e.title,content:imported.readingView.blankLineCleanup?removeBlankScriptLines(e.content):e.content})),readingView:{...imported.readingView,warnings:[...imported.readingView.warnings.filter(warning=>warning!==PRODUCTION_NUMBER_WARNING),...(sourceNumbered?[]:[PRODUCTION_NUMBER_WARNING])]},sourceStructure:{version:"SOURCE_STRUCTURE_V1",sections,issues:[...readingIssues,...effectiveIssues.map(i=>({code:i.code,message:i.message,sectionKeys:sections.filter(s=>s.start<i.end&&s.end>i.start).map(s=>s.key),...(isFidelitySourceBranchIssue(i)?{reason:i.reason,owner:i.owner,episodeNumber:i.episodeNumber,sourceRefs:i.sourceRefs}:{})}))]}};
 const receipt:FidelityReceipt={schema:"FIDELITY_RECEIPT_V1",episodeNumbering,sourceEpisodeBranches,sourceBranchDecisions:structuredClone(sourceBranchDecisions),mode,originalHash,readingHash:result.source.sourceVersion,reader:imported.readingView,guarantee:mode==="direct"?"已清洗直入：相对于本次读取文本逐字验证；未提供原稿时仅证明本次结构与内部一致性。":"原上传字节独立保存；锁定内容相对于读取视图逐字、按来源位置完整验证。",result,decisions};
 assertFidelityMaterialization(imported,receipt);
 return {imported,receipt};
}

/** One deterministic boundary contract is shared by imports and decisions. */
export function assertFidelityMaterialization(imported:ImportedScript,receipt:FidelityReceipt) {
 if(receipt.episodeNumbering!==undefined&&!['SOURCE_NUMBER_V1','PRODUCTION_ORDER_V1'].includes(receipt.episodeNumbering))throw new Error('不支持的分集编号策略，未按其它编号模式猜测。');
 if(imported.sourceText!==receipt.result.source.text || createHash('sha256').update(imported.sourceText).digest('hex')!==receipt.readingHash)throw new Error('读取文本与保真凭据版本不一致。');
 const cleanup=imported.readingView.blankLineCleanup;
 if(!isDeepStrictEqual(cleanup,receipt.reader.blankLineCleanup)||cleanup!==undefined&&!isDeepStrictEqual(cleanup,{version:'SCRIPT_BLANK_LINES_V1',removedRanges:cleanupScriptText(imported.sourceText).removedRanges}))throw new Error('空行清洗映射与原读取文本或保真凭据不一致。');
 let end=0;const seen=new Set<number>();
 for(const section of imported.sourceStructure.sections){if(section.start!==end||section.end<section.start||section.end>imported.sourceText.length)throw new Error('来源分区未完整且唯一覆盖原文。');end=section.end;}
 if(end!==imported.sourceText.length)throw new Error('来源尾部未覆盖。');
 for(const episode of imported.episodes){
  if(seen.has(episode.number))throw new Error('展示集号重复。');seen.add(episode.number);
  const expected=imported.sourceStructure.sections.filter(s=>s.kind==='EPISODE'&&s.episodeNumber===episode.number).map(s=>imported.sourceText.slice(s.start,s.end)).join('');
  if((cleanup?removeBlankScriptLines(expected):expected)!==episode.content)throw new Error('来源分区与实际分集正文不一致（仅允许已记录的空行清洗）。');
 }
 if(imported.sourceStructure.sections.some(s=>s.kind==='EPISODE'&&!seen.has(s.episodeNumber!)))throw new Error('来源分集缺少实际正文。');
 if(imported.originalFile && createHash('sha256').update(Buffer.from(imported.originalFile.base64,'base64')).digest('hex')!==receipt.originalHash)throw new Error('原上传字节与hash不一致。');
}
