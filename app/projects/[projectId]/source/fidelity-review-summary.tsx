import type { FidelityReceipt, FidelityResult } from "@/lib/fidelity-import";
import type { P1ReviewState } from "@/lib/fidelity-p1-review";
import { createSource, normalize } from "../../../../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs";

export function FidelityReviewSummary({ receipt }: { receipt: FidelityReceipt }) {
  const review = receipt.p1Review as P1ReviewState | undefined;
  const source = receipt.result.source.text;
  const baseline = receipt.decisions.length ? normalize(createSource(source)) as unknown as FidelityResult : null;
  const previousOwnership = (start:number,end:number) => [...new Set((baseline?.segments ?? []).filter(segment=>segment.start<end&&segment.end>start).map(segment=>{
    const episode=baseline?.episodes.find(item=>item.id===segment.episodeId);
    return segment.kind === "context" ? "作者资料" : episode ? episode.title : "归属待定";
  }))].join("、") || "归属待定";
  return <section aria-label="P1 检查与修改结果">
    <h3>检查进度与正文保全</h3>
    <p>{review?.status === "COMPLETE"
      ? review.method === "PROGRAM"
        ? "程序结构验证已完成，未调用 AI；这不代表 AI 语义检查或成片验收。"
        : review.method === "AI" || review.runIds?.length
          ? `AI 全文结构检查已完成，保留 ${review.runIds?.length ?? 0} 条调用记录。`
          : "结构检查已完成；此旧记录未标明执行方式，不能作为 AI 检查完成证明。"
      : review?.status === "PENDING"
        ? `结构检查待完成，已检查 ${review.completedRanges?.length ?? 0} 个范围。请在全剧工作台查看实际处理方式与运行状态。`
        : receipt.mode === "direct"
          ? "已清洗稿已由程序接收；未安排重复的全文 AI 清洗。"
          : "此记录仅有程序校验，没有本版 AI 全文检查完成证明。"}</p>
    <p>原文 {source.length.toLocaleString("zh-CN")} 字符；程序只调整结构归属，正文改写 0 处。原稿与规范化视图可在下方分别查看。</p>
    <details><summary>查看结构归属调整（{receipt.decisions.length}）</summary>
      {receipt.decisions.length ? <ol>{receipt.decisions.map((decision, index) => <li key={index}>
        <p>程序原识别：{previousOwnership(decision.start,decision.end)} → 整理后：{decision.kind === "context" ? "作者资料" : `第 ${decision.episodeNumber ?? "待定"} 集 · 第 ${decision.sceneNumber ?? "待定"} 场`}。{decision.note}</p>
        <pre style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{source.slice(decision.start, decision.end)}</pre>
      </li>)}</ol> : <p>没有新增结构归属调整。检查后无需修改也属于有效结果。</p>}
    </details>
    {review?.aliases?.length ? <details><summary>称呼对应候选（{review.aliases.length}）</summary><p>以下是有据候选，尚未作为已确认身份；原台词中的称呼不变。</p><ul>{review.aliases.map((item,index)=><li key={index}>{item.alias} → {item.canonicalCandidate}：{item.note}<blockquote>{source.slice(item.start,item.end)}</blockquote></li>)}</ul></details> : null}
    {review?.unresolved?.length ? <details><summary>需要进一步判断的内容（{review.unresolved.length}）</summary><ul>{review.unresolved.map((item,index)=><li key={index}>{item.note}<blockquote>{source.slice(item.start,item.end)}</blockquote></li>)}</ul></details> : null}
    {receipt.externalReview ? <details><summary>外部整理附带的分类与候选</summary><p>候选供后续判断，未自动当成用户确认的决定。</p>
      <ul>{receipt.externalReview.contextTypes.map((item,index)=><li key={index}>{({AUTHOR:"作者资料",OUTLINE:"剧情梗概",CHARACTERS:"人物资料",WORLD:"世界观",OTHER:"其他资料"} as Record<string,string>)[item.type] ?? "资料"}<blockquote>{source.slice(item.start,item.end)}</blockquote></li>)}</ul>
      <ul>{receipt.externalReview.aliases.map((item,index)=><li key={index}>{Array.isArray(item.names)?item.names.join(" / "):"称呼候选"}：{String(item.note ?? "")}</li>)}</ul>
      <ul>{receipt.externalReview.questions.map((item,index)=><li key={index}><p>{String(item.question ?? "")}</p><p>推荐：{String(item.recommended ?? "待判断")}；{String(item.reason ?? "")}</p>{Array.isArray(item.options)?<p>备选：{item.options.join(" / ")}</p>:null}</li>)}</ul>
    </details> : null}
  </section>;
}
