import { FidelityReviewSummary } from "./fidelity-review-summary";
import { ImportIssueSummary } from "@/app/ui/import-issue-summary";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireProjectAccess } from "@/lib/auth";
import { AppChrome } from "@/app/ui/app-chrome";
import { readFidelityReceipt, applyFidelityDecision } from "@/lib/fidelity-store";
import { prisma } from "@/lib/prisma";
export const dynamic="force-dynamic";
async function decide(form:FormData){"use server";const projectId=String(form.get("projectId"));await requireProjectAccess(projectId);let error="";try{
 await applyFidelityDecision({projectId,revision:String(form.get('revision')),sourceRevision:String(form.get('sourceRevision')),sourceVersion:String(form.get('sourceVersion')),decisionVersion:String(form.get('decisionVersion')),firstLine:Number(form.get('firstLine')),lastLine:Number(form.get('lastLine')),kind:form.get('kind')==='context'?'context':'body',episodeNumber:Number(form.get('episodeNumber')),sceneNumber:Number(form.get('sceneNumber'))});
 revalidatePath('/projects/'+projectId);
}catch(e){error=e instanceof Error?e.message:'保存失败';}redirect('/projects/'+projectId+'/source'+(error?'?error='+encodeURIComponent(error):''));}
export default async function SourcePage({params,searchParams}:{params:Promise<{projectId:string}>;searchParams:Promise<{error?:string}>}){
 const {projectId}=await params;await requireProjectAccess(projectId);
 const current=await readFidelityReceipt(projectId);const {error}=await searchParams;
 const project=await prisma.project.findUniqueOrThrow({where:{id:projectId}});
 if(!current)return <AppChrome eyebrow="来源与清洗" title="来源资料" projectId={projectId} activeSection="project"><p>历史项目未生成本版保真证明；请从新建项目导入原稿。</p><Link href={'/projects/'+projectId}>返回工作台</Link></AppChrome>;
 const {receipt,snapshot}=current;const productionCount=await prisma.episode.count({where:{projectId}});
 const rows=[...receipt.result.source.text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)].map((match,index)=>({line:index+1,text:match[0]}));
 const readingRows=rows.filter(row=>row.text.trim().length>0);
 const download='/projects/'+projectId+'/source/download?revision='+snapshot.id;
 return <AppChrome eyebrow="来源与清洗" title={project.title+' · 接收与清洗'} projectId={projectId} activeSection="project" primaryAction={<Link href={'/projects/'+projectId}>返回全剧工作台</Link>}>
  <section className="studioSection"><h2>P1 · 原文与清洗记录</h2>
   {error?<p role="alert">{error}</p>:null}<p>{receipt.guarantee}</p>
   <p>格式版本 {receipt.result.contractVersion} · {productionCount} 个正文集 · 作者资料 {receipt.result.contextText.length} 字符</p>
   <p><a href={download+'&format=md'}>下载清洗稿</a> · <a href={download+'&format=original'}>下载原件</a> · <a href={download}>下载备份 JSON</a></p>
   {receipt.reader.warnings.map((w,i)=><p key={i}>{w}</p>)}
   <details><summary>来源证明与当前版本</summary><p>原件 SHA256：{receipt.originalHash}</p><p>读取文本 SHA256：{receipt.readingHash}</p><p>修订：{snapshot.id}</p><p>正文覆盖、来源顺序、标签绑定：{receipt.result.validation.ok?'通过':'未通过'}。语义分类仍按下方待处理事项核对。</p></details>
   <details><summary>作者资料（不进入生产正文）</summary><pre style={{whiteSpace:'pre-wrap'}}>{receipt.result.contextText||'未识别到作者资料'}</pre></details>
   <FidelityReviewSummary receipt={receipt}/>
   <h3>待处理边界</h3>{receipt.result.validation.issues.length?<ImportIssueSummary issues={receipt.result.validation.issues}/>:<p>当前程序解析无待处理边界。</p>}
   <details><summary>修正指定范围的用途或无标题稿所属集</summary><p>仅在归属确有问题时使用，不改原文字词。按下方保留的原行号选择完整行；作者资料不会进入正文集。</p>
    <form action={decide}><input type="hidden" name="projectId" value={projectId}/><input type="hidden" name="revision" value={snapshot.id}/><input type="hidden" name="sourceRevision" value={current.sourceSnapshot?.id??""}/><input type="hidden" name="sourceVersion" value={receipt.readingHash}/><input type="hidden" name="decisionVersion" value={String(receipt.result.plan.decisionVersion??"")}/><label>起始行<input name="firstLine" type="number" min={1} max={rows.length} required/></label><label>结束行<input name="lastLine" type="number" min={1} max={rows.length} required/></label><label>用途<select name="kind"><option value="body">正文</option><option value="context">作者资料</option></select></label><label>正文展示集号<input name="episodeNumber" type="number" min={0}/></label><label>正文场号<input name="sceneNumber" type="number" min={1} defaultValue={1}/></label><button type="submit">确认范围并保存新版本</button></form>
   </details>
   <details open id="source-reading-view"><summary>清洗阅读视图（隐藏空白行，保留原行号）</summary><div style={{maxHeight:540,overflow:'auto'}}>{readingRows.map(row=><div key={row.line} style={{display:'grid',gridTemplateColumns:'4em 1fr'}}><span style={{opacity:.65}}>{row.line}</span><pre style={{whiteSpace:'pre-wrap',margin:0}}>{row.text}</pre></div>)}</div></details>
   <details id="source-original-audit"><summary>原件读取文本（审计，含全部空行）</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:540,overflow:'auto'}}>{receipt.result.source.text}</pre></details>
   <details><summary>规范化全文（审计）</summary><pre style={{whiteSpace:'pre-wrap'}}>{receipt.result.normalizedText}</pre></details>
  </section>
 </AppChrome>;
}
