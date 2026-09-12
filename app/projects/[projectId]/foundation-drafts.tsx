import type { CSSProperties } from "react";
import { readFoundationDrafts, type FoundationDraftChunk } from "@/lib/foundation-draft";

const prose: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.8 };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const labels: Record<string, string> = {
  coverage: "作者记录范围", overview: "全剧理解", assets: "身份定义与描述", episodes: "逐集草稿正文", number: "集号", episode: "来源集号",
  summary: "摘要", context: "本集上下文", f2Notes: "给F2的后台核对线索", sourceSelections: "原文选材定位", uses: "逐集身份使用",
  key: "身份 key", name: "名称", type: "类型", aliases: "别名", description: "身份描述", descriptionVariants: "分别保留的有据描述", text: "正文",
  sourceRefs: "来源", startLine: "起始行", endLine: "结束行", presence: "使用方式", state: "源状态", purpose: "用途", sourceName: "当集标签", sourceNameMatch: "词面标记",
  appearances: "逐集状态记录", assetKeys: "当集身份 key", backgroundRefs: "背景参考", issues: "作者自报问题", dataIssues: "资料缺口",
  severity: "严重程度", owner: "归属", coordinate: "位置", problem: "问题", verdict: "原始结论"
};
const presence: Record<string, string> = { ONSTAGE: "入场", MENTIONED: "被提及", PROFILE: "资料信息", BACKGROUND: "背景参考（不表示出现）" };
const runStatus: Record<string, string> = { FAILED: "运行失败", CANCELED: "运行已停止", RUNNING: "运行中", QUEUED: "排队中" };
const chunkStatus: Record<string, string> = { SUCCEEDED: "分片已返回 · 未验收", FAILED: "分片处理失败", RUNNING: "分片处理中", UNKNOWN: "分片状态未记录" };
const fieldLabel = (key: string) => Object.hasOwn(labels, key) ? labels[key] : key;

function registeredKeys(chunks: FoundationDraftChunk[]) {
  const keys = new Set<string>();
  for (const { data } of chunks) {
    if (!record(data)) continue;
    for (const episode of Array.isArray(data.episodes) ? data.episodes : []) {
      if (!record(episode)) continue;
      for (const item of [...(Array.isArray(episode.uses) ? episode.uses : []), ...(Array.isArray(episode.backgroundRefs) ? episode.backgroundRefs : [])]) {
        if (record(item) && typeof item.key === "string") keys.add(item.key);
      }
      for (const key of Array.isArray(episode.assetKeys) ? episode.assetKeys : []) if (typeof key === "string") keys.add(key);
    }
    for (const asset of Array.isArray(data.assets) ? data.assets : []) {
      if (record(asset) && typeof asset.key === "string" && Array.isArray(asset.appearances) && asset.appearances.some(record)) keys.add(asset.key);
    }
  }
  return keys;
}

function scopeLabel(scope: number[]) {
  if (!scope.length) return "范围未记录";
  const numbers = [...new Set(scope)].sort((a, b) => a - b);
  return numbers.length > 1 && numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1)
    ? `第${numbers[0]}–${numbers[numbers.length - 1]}集` : `第${numbers.join("、")}集`;
}

/** All author fields stay readable; unknown/incorrect shapes remain text, never JSX values. */
function DraftValue({ value, field = "", usedKeys }: { value: unknown; field?: string; usedKeys?: ReadonlySet<string> }) {
  if (value === null || value === undefined) return <span>未填写</span>;
  if (typeof value !== "object") return <span style={prose}>{field === "presence" && typeof value === "string" && Object.hasOwn(presence, value) ? presence[value] : String(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span>无已记录条目</span>;
    if (value.every((item) => item === null || typeof item !== "object")) return <span style={prose}>{value.map(String).join("、")}</span>;
    return <div>{value.map((item, index) => {
      if (record(item) && (field === "episodes" || field === "assets")) {
        const title = field === "episodes" && typeof item.number === "number" && Number.isSafeInteger(item.number)
          ? `第${item.number}集` : typeof item.name === "string" ? item.name : `${fieldLabel(field)} ${index + 1}`;
        return <details className="bibleEpisode" key={index}><summary>{title}</summary>
          {field === "assets" && usedKeys && typeof item.key === "string" && !usedKeys.has(item.key) ? <p>后台定义／未登记逐集使用</p> : null}
          <DraftValue value={item} usedKeys={usedKeys} />
        </details>;
      }
      return <div style={{ marginBottom: "1rem" }} key={index}><DraftValue value={item} usedKeys={usedKeys} /></div>;
    })}</div>;
  }
  return <dl>{Object.entries(value).map(([key, child]) => <div key={key} style={{ marginBottom: "0.75rem" }}>
    <dt><b>{fieldLabel(key)}</b></dt><dd style={{ margin: 0 }}><DraftValue value={child} field={key} usedKeys={usedKeys} /></dd>
  </div>)}</dl>;
}

function DraftData({ data, usedKeys }: { data: Record<string, unknown>; usedKeys?: ReadonlySet<string> }) {
  const otherFields = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "episodes" && key !== "assets"));
  return <>
    {Object.hasOwn(data, "episodes") ? <div data-draft-section="episodes"><h4>逐集草稿正文</h4><DraftValue value={data.episodes} field="episodes" usedKeys={usedKeys} /></div> : null}
    {Object.hasOwn(data, "assets") ? <details className="bibleSection" data-draft-section="assets">
      <summary className="bibleSectionHead">身份定义与描述{Array.isArray(data.assets) ? `（${data.assets.length}项）` : "（格式待核对）"}</summary>
      <div className="bibleBody"><DraftValue value={data.assets} field="assets" usedKeys={usedKeys} /></div>
    </details> : null}
    <DraftValue value={otherFields} usedKeys={usedKeys} />
  </>;
}

export function FoundationDrafts({ state }: { state: Parameters<typeof readFoundationDrafts>[0] }) {
  const drafts = readFoundationDrafts(state);
  if (!drafts.length) return null;
  return <section id="foundation-drafts" aria-label="已保存的运行草稿">
    {drafts.map((draft) => {
      const usedKeys = draft.stageCode === "F2" ? registeredKeys(draft.chunks) : undefined;
      return <article className="studioCard" key={draft.runId} data-run-id={draft.runId} data-stage-code={draft.stageCode}>
      <div className="cardHeader"><div><span>{draft.stageCode} · 已保存响应</span><h3>{draft.current ? "本次已生成草稿（未验收/不完整）" : "历史运行草稿（未验收/不完整）"}</h3></div><em>{runStatus[draft.status]}</em></div>
      <small style={prose}>运行记录：{draft.runId}</small>
      <p>以下是本次运行逐片已保存的原始正文，不是完整候选，也不代表已完成这些集、可复用或已批准。旧候选单独保留，不拼入这份草稿。</p>
      {!draft.current ? <p>原文、输入或上游版本已变化／无法确认匹配；仅供历史阅读，不作为当前新稿。</p> : null}
      {draft.chunks.map((chunk, index) => <details className="bibleSection" key={index} open>
        <summary className="bibleSectionHead">分片 {chunk.sequence} · {scopeLabel(chunk.scope)} · {chunkStatus[chunk.status]}</summary>
        <div className="bibleBody">
          {record(chunk.data) ? <DraftData data={chunk.data} usedKeys={usedKeys} /> : <p>仅原始文本／未识别为结构化正文；不能据此确认集数或恢复资格。</p>}
          {chunk.data !== undefined ? <details className="bibleSection"><summary>完整原始 data（保留所有字段）</summary><pre style={prose}>{JSON.stringify(chunk.data, null, 2)}</pre></details> : null}
          {chunk.rawOutput !== undefined ? <details className="bibleSection"><summary>完整原始 rawOutput</summary><pre style={prose}>{chunk.rawOutput}</pre></details> : null}
        </div>
      </details>)}
    </article>;
    })}
  </section>;
}
