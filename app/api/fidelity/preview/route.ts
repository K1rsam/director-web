import { requireSessionUser } from "@/lib/auth";
import { prepareFidelityImport } from "@/lib/fidelity-import";
import { removeBlankScriptLines } from "@/lib/source-cleaning";
import {readLocalFormData,LocalRequestError} from '@/lib/local-json-request';
export const runtime="nodejs";
export async function POST(request:Request){
 await requireSessionUser();
 try{
  // Two allowed 20 MiB files plus form overhead; per-file limits remain below.
  const data=await readLocalFormData(request,41*1024*1024),file=data.get('script');
  const mode=data.get('cleaningMode')==='direct'?'direct':'fidelity';
  const bytes=file instanceof File&&file.size?Buffer.from(await file.arrayBuffer()):Buffer.from(String(data.get('scriptText')??''),'utf8');
  if(!bytes.length)throw new Error('请先提供剧本。');
  if(bytes.length>20*1024*1024)throw new Error('文件超过20MB。');
  const original=data.get('originalScript');
  if(original instanceof File&&original.size>20*1024*1024)throw new Error('配对原稿超过20MB。');
  const {receipt,imported}=await prepareFidelityImport(file instanceof File&&file.size?file.name:'pasted.txt',bytes,mode,[],data.get('trustExternalDecisions')==='1',original instanceof File&&original.size?{name:original.name,bytes:Buffer.from(await original.arrayBuffer())}:undefined);
  const groups=new Map<string,{code:string;message:string;count:number;sectionKeys:string[]}>();
  const preview=removeBlankScriptLines(imported.sourceText);
  for(const issue of imported.sourceStructure.issues){const group=groups.get(issue.code)??{...issue,count:0,sectionKeys:[]};group.count++;group.sectionKeys.push(...issue.sectionKeys.slice(0,3));groups.set(issue.code,group);}
  return Response.json({effectiveMode:receipt.mode,sourceVersion:receipt.readingHash,originalHash:receipt.originalHash,
   productionEpisodeCount:imported.episodes.length,candidateEpisodeCount:receipt.result.episodes.length,
   episodes:imported.episodes.map(e=>({number:e.number,title:e.title,length:e.content.length})),
   sceneCount:receipt.result.episodes.filter(e=>e.productionEligible).reduce((n,e)=>n+e.scenes.length,0),
   contextLength:receipt.result.contextText.length,issues:[...groups.values()].map(g=>({...g,sectionKeys:g.sectionKeys.slice(0,3)})),issueCount:imported.sourceStructure.issues.length,
   warnings:receipt.reader.warnings,guarantee:receipt.guarantee,preview:preview.slice(0,12000),previewTruncated:preview.length>12000});
 }catch(error){return Response.json({error:error instanceof Error?error.message:'预览失败'},{status:error instanceof LocalRequestError?error.status:400});}
}
