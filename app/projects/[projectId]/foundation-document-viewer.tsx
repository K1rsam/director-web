import type { FoundationDeliveryState } from "@/lib/foundation-delivery-types";
import type { FoundationDocument } from "@/lib/foundation-document";
import { unresolvedOwner } from "@/lib/foundation-production-contracts";
import { FoundationAssetCatalog } from "./foundation-asset-catalog";
import { AssetIndexTabs, type AssetIndexRow } from "./asset-index-tabs";
import styles from "./foundation-delivery.module.css";

function DocumentBody({ document, codes = {}, requiredChoices = [], contextPending = false, historical = false }: {
  document: FoundationDocument; codes?: Record<string, string>; requiredChoices?: FoundationDeliveryState["requiredChoices"]; contextPending?: boolean; historical?: boolean;
}) {
  const { f1, f2 } = document;
  const todos = document.editorialTodos ?? [];
  const scopes = [...requiredChoices.map(choice => choice.episodes), ...todos.filter(item => !item.key).map(item => item.episodes ?? [])];
  const keyedTodos = new Set(todos.flatMap(item => item.key ? [item.key] : []));
  const affected = (episodes: number[]) => contextPending || !episodes.length
    || episodes.some(episode => !document.editorialCoverage.includes(episode) || !f1?.coverage.includes(episode))
    || scopes.some(scope => !scope.length || episodes.some(episode => scope.includes(episode)));
  const pendingKeys = f2?.assets.flatMap(asset => [
    ...(affected(asset.usageEpisodes) || keyedTodos.has(asset.key) ? [asset.key] : []),
    ...asset.variants.filter(variant => affected(variant.episodes) || keyedTodos.has(variant.key) || keyedTodos.has(asset.key)).map(variant => variant.key)
  ]) ?? [];
  return <>
    <article className={styles.documentSection}>
      <h3>分集导航</h3>
      {f1 ? <>
        <div className={styles.overview}>{f1.overview}</div>
        <div className={styles.episodes}>{f1.episodes.map(episode => <details key={episode.number} className={styles.episode}>
          <summary><b>第{episode.number}集</b><span>{episode.summary}</span></summary>
          {episode.context ? <p className={styles.prose}>{episode.context}</p> : null}
          {episode.sourceSelections.length ? <details className={styles.processing}><summary>原文定位</summary><ul>{episode.sourceSelections.map((source, index) => <li key={index}>第{source.episode}集 · 第{source.startLine}–{source.endLine}行 · {source.purpose}</li>)}</ul></details> : null}
        </details>)}</div>
      </> : <p className={styles.empty}>分集导航尚未生成。开始整理后，已保存的内容会陆续出现在这里。</p>}
    </article>
    <article className={styles.documentSection} id="foundation-assets">
      <h3>资产目录与必要变体</h3>
      <p className={styles.note}>完整目录持续保留基础对象与子形象。{historical ? "此处仅供历史阅读，不列入当前制图队列。" : "记录数不是图片张数；需要备图时可切换“制图队列”。"}</p>
      {f2 ? <FoundationAssetCatalog catalog={f2} codes={codes} pendingKeys={pendingKeys} historical={historical} plainLanguage /> : <p className={styles.empty}>资产目录尚未生成；已有的分集导航仍可阅读。</p>}
    </article>
    {document.notes.length || todos.length ? <article className={styles.documentSection}>
      <h3>制作说明与待续事项</h3>
      {document.notes.length ? <ul className={styles.prose}>{document.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
      {todos.length ? <><p className={styles.note}>以下内容将继续处理，不等于需要你逐项确认。需要你取舍的事项只在上方确认区出现。</p><ul className={styles.prose}>{todos.map(item => <li key={item.id}>{item.episodes?.length ? `第${item.episodes.join("、")}集：` : ""}{item.note}</li>)}</ul></> : null}
    </article> : null}
  </>;
}

/** Always read the persistent working document; legacy approval never gates its visibility. */
export function FoundationDocumentViewer({ state }: { state: Pick<FoundationDeliveryState, "document" | "previousDocument" | "sourceContext" | "codes" | "issues" | "requiredChoices" | "confirmedChoices" | "needsContextEdit"> }) {
  const { sourceContext } = state;
  const contextPending = state.needsContextEdit || Boolean(sourceContext.issues.length || sourceContext.unresolved.length)
    || sourceContext.notices.some(notice => notice.code === "CURRENT_SOURCE_IMPORT_METADATA_UNREADABLE");
  // Keep original scopes: a removed episode must never become an empty/global decision.
  const requiredChoices = [...state.requiredChoices, ...state.confirmedChoices.filter(choice => state.document.appliedDecisions[choice.id] !== choice.revision)];
  return <div className={styles.document} id="foundation-document">
    <DocumentBody document={state.document} codes={state.codes} requiredChoices={requiredChoices} contextPending={contextPending} />
    {sourceContext.issues.length || sourceContext.background.length || sourceContext.unresolved.length || sourceContext.notices.length ? <details className={styles.source}>
      <summary>原文读取与背景资料{sourceContext.issues.length || sourceContext.unresolved.length ? " · 含待处理内容" : ""}</summary>
      {sourceContext.issues.length ? <ul>{sourceContext.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul> : null}
      {sourceContext.background.map(item => <details key={item.key}><summary>保留的背景资料</summary><p className={styles.prose}>{item.text}</p></details>)}
      {sourceContext.unresolved.map(item => <details key={item.key}><summary>保留的未决原文</summary><p className={styles.prose}>{item.text}</p></details>)}
      {sourceContext.notices.map((notice, index) => <p key={index}>{notice.message}</p>)}
      {!sourceContext.complete && (sourceContext.issues.length || sourceContext.unresolved.length) ? <p>待定原文仍保留，不计入整剧已完成范围。</p> : null}
    </details> : null}
    {state.issues.length ? <details className={styles.source}><summary>资料检查记录（{state.issues.length}）</summary><ul>{state.issues.map((issue, index) => <li key={index}><b>{issue.coordinate}</b> · {issue.problem}</li>)}</ul></details> : null}
    {state.previousDocument ? <details className={styles.history}>
      <summary>历史资料 · 上一份保留修订</summary>
      <p className={styles.warning}>仅供历史阅读，不计入当前完成范围；不是当前资料的替代稿。</p>
      <DocumentBody document={state.previousDocument} historical />
    </details> : null}
  </div>;
}

type SourceEpisode = { id: string; number: number; title: string | null; content: string; sceneCount: number };
type LightViewerState = Pick<FoundationDeliveryState, "document" | "sourceContext" | "codes" | "issues" | "requiredChoices" | "confirmedChoices" | "needsContextEdit"> & { needsAssetRefresh?: boolean };

/** The light workflow reads numbered source directly; old AI navigation remains in history. */
export function LightFoundationDocumentViewer({ state, sourceEpisodes }: { state: LightViewerState; sourceEpisodes: SourceEpisode[] }) {
  const { document, sourceContext } = state;
  const choices = [...state.requiredChoices, ...state.confirmedChoices.filter(choice => document.appliedDecisions[choice.id] !== choice.revision)];
  const activeTodos = document.editorialTodos.filter(todo => unresolvedOwner(todo) !== "STAGE2");
  const scopes = [...choices.map(choice => choice.episodes), ...activeTodos.filter(todo => !todo.key).map(todo => todo.episodes ?? []),
    ...state.issues.filter(issue => issue.severity !== "MINOR").map(issue => issue.sourceRefs.map(ref => ref.episode))];
  const contextPending = state.needsAssetRefresh || state.needsContextEdit || sourceContext.issues.length > 0 || sourceContext.unresolved.length > 0
    || sourceContext.notices.some(notice => notice.code === "CURRENT_SOURCE_IMPORT_METADATA_UNREADABLE");
  const keyedTodos = new Set(activeTodos.flatMap(todo => todo.key ? [todo.key] : []));
  const entries = document.f2?.assets.flatMap(asset => [
    { item: asset, parentKey: undefined, episodes: asset.usageEpisodes, role: asset.role },
    ...asset.variants.map(variant => ({ item: { ...variant, type: asset.type }, parentKey: asset.key, episodes: variant.episodes, role: asset.role }))
  ]) ?? [];
  const pending = new Set(entries.filter(({ item, parentKey, episodes }) => contextPending || !episodes.length || episodes.some(number => !document.editorialCoverage.includes(number))
    || scopes.some(scope => !scope.length || episodes.some(number => scope.includes(number))) || keyedTodos.has(item.key) || (parentKey && keyedTodos.has(parentKey))
    || !item.preparation || item.preparation.mode === "UNRESOLVED"
    || document.f2?.repairItems?.some(repair => repair.assetKey === item.key || repair.variantKey === item.key)).map(({ item }) => item.key));
  let changed = true;
  while (changed) {
    changed = false;
    for (const { item, parentKey } of entries) {
      const fromKey = item.preparation?.fromKey ?? parentKey;
      if (!pending.has(item.key) && item.preparation?.mode === "DERIVE" && (!fromKey || !entries.some(entry => entry.item.key === fromKey) || pending.has(fromKey))) {
        pending.add(item.key); changed = true;
      }
    }
  }
  const assets: AssetIndexRow[] = entries.map(({ item, parentKey, role }) => ({ id: item.key, code: state.codes[item.key] ?? "未核编号", type: item.type,
    name: item.name, parentId: parentKey, role, status: "working", statusLabel: pending.has(item.key) ? "待完善" : "已整理" }));
  return <div className="studioGrid twoColumns" id="foundation-document">
    <article className="studioCard">
      <div className="cardHeader"><div><span>SOURCE INDEX</span><h3>原文与分集索引</h3></div><em>{sourceEpisodes.length} 集</em></div>
      <div className="bibleViewer studioTableScroll compactTable">
        {sourceEpisodes.map(episode => <details className="bibleSection" key={episode.id}>
          <summary className="bibleSectionHead"><b>第{episode.number}集</b>{episode.title ? <span>{episode.title}</span> : null}<em>{episode.sceneCount} 场 · 查看原文</em></summary>
          <p className="bibleBody" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{episode.content}</p>
        </details>)}
        {!sourceEpisodes.length ? <p className="biblePlaceholder">尚无分集原文，请先检查导入内容。</p> : null}
      </div>
      {sourceContext.issues.length || sourceContext.background.length || sourceContext.unresolved.length || sourceContext.notices.length ? <details className="bibleSection">
        <summary className="bibleSectionHead">原文读取说明</summary>
        <div className="bibleBody">
          {sourceContext.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}
          {[...sourceContext.background, ...sourceContext.unresolved].map(section => <p key={section.key} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{section.text}</p>)}
          {sourceContext.notices.map((notice, index) => <p key={index}>{notice.message}</p>)}
        </div>
      </details> : null}
    </article>
    <article className="studioCard" id="foundation-assets">
      <div className="cardHeader"><div><span>ASSET INDEX</span><h3>资产名称简表</h3></div><em>{assets.length} 项</em></div>
      {state.needsAssetRefresh && assets.length ? <p className="biblePlaceholder">旧资产稿，待按当前方法整理</p> : null}
      <AssetIndexTabs assets={assets} />
    </article>
  </div>;
}
