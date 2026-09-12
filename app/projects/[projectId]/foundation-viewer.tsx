import { type CSSProperties } from "react";
import type { getFoundationState } from "@/lib/foundation-state";
import type { FoundationIssue, SourceRef } from "@/lib/project-foundation-contracts";
import { FoundationDrafts } from "./foundation-drafts";
import { isProductionCatalog } from "@/lib/foundation-production-contracts";
import { FoundationAssetCatalog } from "./foundation-asset-catalog";
import { PRODUCTION_FOUNDATION_VERSION } from "@/lib/foundation-production-prompts";

const prose: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.8 };
const sourceLabel = (refs: SourceRef[] = []) => refs.map((ref) => `第${ref.episode}集 L${ref.startLine}–${ref.endLine}`).join("；");
const catalogScopeLabel = (episodes: number[]) => episodes.length ? `第${episodes.join("、")}集` : "未标注";

function ProductionFoundationView({ state }: { state: Awaited<ReturnType<typeof getFoundationState>> }) {
  const sameAuthors = state.review?.upstreamSnapshotIds.f1 === state.candidates.f1?.id && state.review?.upstreamSnapshotIds.f2 === state.candidates.f2?.id;
  const historical = !state.finalOutput && sameAuthors && state.review?.finalOutput && isProductionCatalog(state.review.finalOutput.f2) ? state.review.finalOutput : null;
  const f1 = state.finalOutput?.f1 ?? historical?.f1 ?? state.candidates.f1?.output;
  const f2 = state.finalOutput?.f2 ?? historical?.f2 ?? (isProductionCatalog(state.candidates.f2?.output) ? state.candidates.f2.output : null);
  const repairItems = f2?.repairItems ?? [];
  const final = Boolean(state.finalOutput);
  const review = state.review?.output;
  const notes = (final || historical) && review && "notes" in review && Array.isArray(review.notes) ? review.notes.filter((note): note is string => typeof note === "string") : [];
  const unresolved = (final || historical) && review && "unresolved" in review && Array.isArray(review.unresolved)
    ? review.unresolved.filter((item): item is { note: string; key?: string } => typeof item === "object" && item !== null && "note" in item && typeof item.note === "string") : [];
  const pendingKeys = unresolved.flatMap(item => typeof item.key === "string" ? [item.key] : []);
  const sourceContext = state.sourceContext;
  const approvalMatches = (final || historical) && state.approved && state.review && state.approved.q1SnapshotId === state.review.id
    && state.approved.f1SnapshotId === state.review.upstreamSnapshotIds.f1 && state.approved.f2SnapshotId === state.review.upstreamSnapshotIds.f2
    && state.approved.sourceVersion === state.review.sourceVersion && state.approved.inputVersion === state.review.inputVersion;
  const codes = Object.fromEntries(approvalMatches ? state.approved!.assets.map(asset => [asset.key, asset.code]) : []);
  return <div className="foundationViewer">
    <FoundationDrafts state={state} />
    {historical ? <p role="status" className="biblePlaceholder">历史整理结果：原成果仍保留，不代表当前版本已完成。</p> : f2 && !state.assetsReady && !final ? <p role="status">下面目录属于历史候选，不代表当前版本已完成。</p> : null}
    {sourceContext && (sourceContext.issues.length || sourceContext.background.length || sourceContext.unresolved?.length || sourceContext.notices?.length) ? <article className="studioCard">
      <h3>原文读取与背景资料</h3>
      {sourceContext.issues.length ? <ul>{sourceContext.issues.map((issue, index) => <li key={index} style={prose}>{issue.message}</li>)}</ul> : null}
      {sourceContext.notices?.length ? <details><summary>读取说明</summary><ul>{sourceContext.notices.map((notice, index) => <li key={index} style={prose}>{notice.message}</li>)}</ul></details> : null}
      {sourceContext.background.map(item => <details key={item.key}><summary>保留的背景资料</summary><p style={prose}>{item.text}</p></details>)}
      {sourceContext.unresolved?.map(item => <details key={item.key}><summary>保留的未决原文</summary><p style={prose}>{item.text}</p></details>)}
      {!sourceContext.complete && (sourceContext.issues.length || sourceContext.unresolved?.length) ? <p>只整理已明确归属的内容；以上待定内容仍保留，不计入整剧已完成范围。</p> : sourceContext.coverage === "UNKNOWN" ? <p>现有分集按已保存内容读取；未宣称原上传文件的结构已经重新验证。</p> : null}
    </article> : null}
    <article className="studioCard" id="foundation-assets" style={{ scrollMarginTop: 96 }}>
      <div className="cardHeader"><div><span>P2 · F2</span><h3>资产目录与必要变体</h3></div><em>{historical ? repairItems.length ? "历史目录 · 待Q1核对" : "历史整理结果" : repairItems.length ? "可读候选 · 待Q1核对" : final ? state.ready ? "Q1优化后的最终目录" : "已整理 · 含待定项" : f2 ? "目录初稿 · 待Q1优化" : "尚未整理"}</em></div>
      <p>默认展示完整资产表：基础对象与子形象分层，保留剧情定位、适用集和必要说明。子形象／状态记录不等于图片订单；只需查看备图任务时切换“制图队列”。具体外观与图片由你制作。</p>
      {repairItems.length ? <section className="bibleSection" aria-label="接收范围待核">
        <h4>待Q1核对（{repairItems.length}项）</h4>
        <p style={prose}>接收时发现基础对象与子形象的范围不一致，这是程序发现的问题，不是Q1审查结论。合并范围的包络仅为保留待核，不代表已批准或新增已核入镜；相关对象、版本及依赖它们的派生项暂不进入制图队列。由Q1核对原文与版本范围，不需你逐项确认。</p>
        <ul>{repairItems.map(item => {
          const asset = f2?.assets.find(asset => asset.key === item.assetKey);
          const variant = asset?.variants.find(variant => variant.key === item.variantKey);
          return <li key={item.id} style={prose}>
            <b>对象：{asset?.name ?? `未定位对象（${item.assetKey}）`} · 版本：{variant?.name ?? `未定位版本（${item.variantKey}）`}</b>
            <p>父原范围：{catalogScopeLabel(item.assetEpisodes)}；子原范围：{catalogScopeLabel(item.variantEpisodes)}</p>
            <p>范围冲突涉及：{catalogScopeLabel(item.episodes)}</p>
          </li>;
        })}</ul>
      </section> : null}
      {f2 ? <FoundationAssetCatalog catalog={f2} codes={codes} pendingKeys={pendingKeys} /> : <p className="biblePlaceholder">F2完成后在这里查看基础资产、必要变体和适用集场。</p>}
    </article>
    <article className="studioCard">
      <div className="cardHeader"><div><span>P1 · F1</span><h3>分集创作导航</h3></div><em>{historical ? "历史最终资料" : final ? "最终资料" : "导航初稿"}</em></div>
      {f1 ? <div className="bibleViewer"><details className="bibleSection" open><summary className="bibleSectionHead">全剧导航</summary><div className="bibleBody" style={prose}>{f1.overview}</div></details>
        <div className="bibleBody">{f1.episodes.map((episode) => episode.context ? <details className="bibleEpisode" key={episode.number}>
          <summary>第{episode.number}集 · {episode.summary}</summary><p style={prose}>{episode.context}</p>
        </details> : <p key={episode.number} style={prose}><b>第{episode.number}集</b> · {episode.summary}</p>)}</div>
      </div> : <p className="biblePlaceholder">F1完成后查看逐集变化与必要承接。</p>}
    </article>
    <article className="studioCard" id="foundation-review">
      <div className="cardHeader"><div><span>P3 · Q1</span><h3>{repairItems.length ? "待Q1核对范围" : final ? state.ready ? "Q1已完成最终优化" : "Q1已完成资料整理 · 有待定项" : "Q1最后一轮优化"}</h3></div><em>{repairItems.length ? "仍有范围待核项" : final ? state.ready ? "完整结果" : "可读整理稿" : "待完成"}</em></div>
      <p role="status">{state.message}</p>
      {historical ? <p>历史 Q1 整理说明（不代表当前批准）</p> : null}
      {(final || historical) && review?.summary ? <p style={prose}>{review.summary}</p> : null}
      {notes.length ? <div><h4>制作时需留意</h4><ul>{notes.map((note, index) => <li key={index} style={prose}>{note}</li>)}</ul></div> : null}
      {unresolved.length ? <div><h4>仍待处理的资料问题</h4><p>资料缺口不等于需要你逐项确认；确须你选择的事项只放在页面上方“需要你确认”中处理。</p><ul>{unresolved.map((item, index) => <li key={index} style={prose}>{item.note}</li>)}</ul></div> : null}
      <details className="bibleSection"><summary className="bibleSectionHead">原稿与版本</summary><div className="bibleBody">
        <p>原剧本、F1/F2作者稿和每次原始响应未覆盖，完整历史保留在JSON导出中。</p>
        <p>F1：{state.candidates.f1?.id}；F2：{state.candidates.f2?.id}；Q1：{state.review?.id}</p>
      </div></details>
      <p className="biblePlaceholder">此处完成的是制作资料；图片和后续分镜尚未制作。</p>
    </article>
  </div>;
}

function SourceNameNote({ sourceName, sourceNameMatch }: { sourceName?: string; sourceNameMatch?: "LITERAL" | "NON_LITERAL" }) {
  return sourceName ? <small style={prose}>当集标签：{sourceName} · {sourceNameMatch === "NON_LITERAL" ? "非逐字表述" : sourceNameMatch === "LITERAL" ? "逐字命中（仅词面）" : "未作词面标记"}</small> : null;
}

function Issues({ title, issues = [] }: { title: string; issues?: FoundationIssue[] }) {
  return <details className="bibleSection" open={issues.length > 0}>
    <summary className="bibleSectionHead">{title}（{issues.length}）</summary>
    <div className="bibleBody">
      {issues.length ? issues.map((issue, index) => <article className="bibleLine" key={index}>
        <b>{issue.severity} · {issue.owner} · {issue.coordinate}</b>
        <span style={prose}>{issue.problem}</span><small>{sourceLabel(issue.sourceRefs)}</small>
      </article>) : <p>无已记录问题；不替代独立审查。</p>}
    </div>
  </details>;
}

/** Backend-wide understanding/identity descriptions remain separate from the episode consumer context. */
export function FoundationViewer({ state }: { state: Awaited<ReturnType<typeof getFoundationState>> }) {
  if (state.finalOutput || (state.sourceContext && !state.candidates.f1) || isProductionCatalog(state.candidates.f2?.output) || isProductionCatalog(state.review?.finalOutput?.f2) || (state.planningReady && state.candidates.f1?.workflow === PRODUCTION_FOUNDATION_VERSION)) return <ProductionFoundationView state={state} />;
  const { f1, f2 } = state.candidates;
  const backendNotes = f1?.output.episodes?.filter((episode) => episode.f2Notes) ?? [];
  const review = state.review;
  const currentReview = state.assetsReady && state.latestRuns.q1?.status === "SUCCEEDED" && review?.runId === state.latestRuns.q1.id
    && review?.sourceVersion === state.sourceVersion && review?.inputVersion === state.inputVersion
    && review?.upstreamSnapshotIds.f1 === f1?.id && review?.upstreamSnapshotIds.f2 === f2?.id;
  const candidateLabel = (current: boolean) => current ? state.ready ? "当前批准所用候选" : "当前候选 · 尚未批准" : "历史候选 · 不供当前生产";

  return <div className="foundationViewer">
    <FoundationDrafts state={state} />
    <div className="studioGrid twoColumns">
      <article className="studioCard">
        <div className="cardHeader"><div><span>P1 · F1</span><h3>全剧理解与按集供给</h3></div><em>{f1 ? candidateLabel(state.planningReady) : "尚无候选"}</em></div>
        {f1 ? <div className="bibleViewer">
          <details className="bibleSection" open><summary className="bibleSectionHead">全剧理解（后台资料）</summary><div className="bibleBody" style={prose}>{f1.output.overview}</div></details>
          {backendNotes.length ? <details className="bibleSection"><summary className="bibleSectionHead">给F2的后台核对线索（不进入消费者包）</summary><div className="bibleBody">
            {backendNotes.map((episode) => <article className="bibleLine" key={episode.number}><b>第{episode.number}集</b><span style={prose}>{episode.f2Notes}</span></article>)}
          </div></details> : null}
          <details className="bibleSection" open><summary className="bibleSectionHead">按集供给（消费者上下文）</summary><div className="bibleBody">
            {f1.output.episodes?.map((episode) => <details className="bibleEpisode" key={episode.number}>
              <summary>第{episode.number}集 · {episode.summary}</summary>
              <p style={prose}>{episode.context}</p>
              <h4>原文选材定位</h4>
              {episode.sourceSelections.map((selection, index) => <p key={index}>{sourceLabel([selection])} · {selection.purpose}</p>)}
            </details>)}
          </div></details>
          <Issues title="F1 自报问题" issues={f1.output.issues} /><Issues title="机械问题" issues={f1.mechanicalIssues} />
        </div> : <p className="biblePlaceholder">运行 F1 后，在此查看全剧理解和逐集消费者上下文。</p>}
      </article>

      <article className="studioCard">
        <div className="cardHeader"><div><span>P2 · F2</span><h3>身份与源状态</h3></div><em>{f2 ? candidateLabel(state.assetsReady) : "尚无候选"}</em></div>
        {f2 ? <div className="bibleViewer">
          <p>当集标签保留作者记录；词面匹配不等于身份确认，非逐字表述也不自动判错，仍由Q1核对原文与身份关系。</p>
          <details className="bibleSection"><summary className="bibleSectionHead">身份说明（后台资料） · {f2.output.assets?.length ?? 0} 项</summary><div className="bibleBody">
            {f2.output.assets?.map((asset) => <details className="bibleEpisode" key={asset.key}>
              <summary>{asset.name} · {asset.type} · {asset.key}</summary>
              {!asset.appearances.length && !f2.output.episodes?.some((episode) => episode.assetKeys.includes(asset.key) || episode.backgroundRefs?.some((ref) => ref.key === asset.key)) ? <p>后台定义／未登记逐集使用</p> : null}
              {asset.descriptionVariants?.length ? <div>
                <p>分批描述与来源分别保留，尚需结合原文核对，不表示全部表述同时有效。</p>
                {asset.descriptionVariants.map((variant, index) => <article className="bibleLine" key={index}>
                  <span style={prose}>{variant.text}</span><small>{sourceLabel(variant.sourceRefs)}</small>
                </article>)}
              </div> : <p style={prose}>{asset.description}</p>}
              <p>别名：{asset.aliases.join("、") || "无"}</p><small>{sourceLabel(asset.sourceRefs)}</small>
              {asset.appearances.map((appearance, index) => <article className="bibleLine" key={index}>
                <b>第{appearance.episode}集 · {{ ONSTAGE: "入场", MENTIONED: "被提及", PROFILE: "资料信息" }[appearance.presence]}</b>
                <SourceNameNote sourceName={appearance.sourceName} sourceNameMatch={appearance.sourceNameMatch} />
                <span style={prose}>{appearance.state}</span><small>{sourceLabel(appearance.sourceRefs)}</small>
              </article>)}
            </details>)}
          </div></details>
          <details className="bibleSection" open><summary className="bibleSectionHead">按集供给（消费者上下文）</summary><div className="bibleBody">
            {f2.output.episodes?.map((episode) => <details className="bibleEpisode" key={episode.number}>
              <summary>第{episode.number}集 · {episode.assetKeys.length} 项身份</summary>
              <p style={prose}>{episode.context}</p><small>身份 key：{episode.assetKeys.join("、") || "无"}</small>
              {episode.backgroundRefs?.map((background, index) => <p key={index} style={prose}>背景参考 {background.key}：{background.purpose}<br /><SourceNameNote sourceName={background.sourceName} sourceNameMatch={background.sourceNameMatch} /><br /><small>{sourceLabel(background.sourceRefs)}</small></p>)}
            </details>)}
          </div></details>
          <Issues title="F2 自报问题" issues={f2.output.issues} />
          <Issues title="资料缺口（程序检查）" issues={state.assetsReady ? state.dataIssues : f2.output.dataIssues} />
          <Issues title="机械问题" issues={f2.mechanicalIssues} />
        </div> : <p className="biblePlaceholder">运行 F2 后，在此分别查看后台身份说明和逐集供给。</p>}
      </article>
    </div>

    <article className="studioCard" id="foundation-review">
      <div className="cardHeader"><div><span>P3 · Q1</span><h3>资料独立审查</h3></div><em>{state.ready ? "当前版本已批准" : currentReview ? "当前未批准" : review ? "历史审查 · 当前未批准" : "尚未审查"}</em></div>
      <p role="status">{state.message}</p>
      {review ? <div className="bibleViewer">
        <p>Q1 原始结论：<strong>{review.output.verdict}</strong>（{review.output.verdict === "READY" ? "可用" : review.output.verdict === "REPAIR" ? "需返修" : "拒收"}）</p>
        {currentReview && review.output.verdict === "READY" && !state.dataReady ? <p role="status">资料缺口尚未清除，本次未发布；保留Q1原始结论，不将其改写为已批准。</p> : null}
        <p style={prose}>{review.output.summary}</p>
        <Issues title="Q1 独审问题" issues={review.output.issues} /><Issues title="机械问题" issues={review.mechanicalIssues} />
      </div> : <p className="biblePlaceholder">F1、F2 候选齐备后，Q1 独立判断资料是否可供下游使用。</p>}
      <details className="bibleSection"><summary className="bibleSectionHead">版本信息</summary><div className="bibleBody" style={prose}>
        <p>当前源版本：{state.sourceVersion || "尚无"}</p><p>当前输入版本：{state.inputVersion || "尚无"}</p>
        {f1 ? <p>F1 候选：{f1.id} · {f1.createdAt}</p> : null}
        {f2 ? <p>F2 候选：{f2.id} · {f2.createdAt}</p> : null}
        {review ? <p>Q1 审查：{review.id} · {review.createdAt}</p> : null}
        {state.approved ? <p>{state.ready ? "当前" : "历史"}批准包：{state.approved.id}</p> : null}
      </div></details>
      <p className="biblePlaceholder">资料独审通过不代表分镜质量、真实生成稳定性或用户认可。完整原文、所有历史版本及调用证据可用页面上的 JSON 导出回传。</p>
    </article>
  </div>;
}
