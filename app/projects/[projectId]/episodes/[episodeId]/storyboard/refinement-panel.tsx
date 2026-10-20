"use client";

import { useState } from "react";
import { WorkflowGlassCard, workflowGlassStyles as glass } from "@/app/ui/workflow-glass";
import { messageOf, statusLabel, type RefinementEventScope, type RefinementScope, type RefinementSourceAnchor, type Run, type Unit } from "./types";
import styles from "./refinement-panel.module.css";

const isRefinement = (value: { purpose?: string }) => value.purpose === "director_refinement";

/** The optional paid call has its own activity; the completed production cards keep their state. */
export function productionViewRun(run: Run): Run {
  if (!run.operations.some(isRefinement) && !run.candidates.some(isRefinement)) return run;
  const operations = run.operations.filter(operation => !isRefinement(operation));
  const candidates = run.candidates.filter(candidate => !isRefinement(candidate));
  const active = run.active && operations.some(operation => operation.status === "running");
  const ordinaryUnresolved = operations.some(operation => operation.status === "running" || operation.status === "unknown" && !operation.cancelAcknowledgement?.acceptUnknownUsage);
  const ready = Boolean(run.assembly?.text) && !run.assembly?.errors?.length && !ordinaryUnresolved && !run.production?.blocking && !run.production?.pendingRepair;
  return { ...run, operations, candidates, active, status: ready ? "text_ready_for_review" : run.status };
}

export function refinementActivityLabel(run: Run): string | null {
  const operation = [...run.operations].reverse().find(isRefinement);
  if (!operation) return run.active && run.phase === "refining" ? "导演精修正在准备" : null;
  if (operation.status === "unknown" || !run.active && operation.status === "running") return "导演精修回包待核对";
  if (operation.status !== "running" || !run.active) return null;
  if (operation.localPhase === "queued") return "导演精修等待执行";
  if (operation.execution?.phase === "generating") return "导演精修正在生成";
  if (operation.execution?.phase === "receiving") return "导演精修正在接收";
  if (operation.localPhase === "executing") return "导演精修等待本机回包";
  return "导演精修正在准备";
}

type Props = {
  run: Run;
  endpoint: string;
  disabled: boolean;
  pending: string;
  canExecute?: boolean;
  act: (action: string, payload?: Record<string, unknown>) => Promise<Run | null>;
};

function SourceAnchor({ label, anchor }: { label: string; anchor?: RefinementSourceAnchor | null }) {
  return <span className={styles.anchor}>{label} · {anchor ? <>{anchor.id}{anchor.lineNo !== undefined ? `（第${anchor.lineNo}行）` : ""}「{anchor.text}」</> : "待核对"}</span>;
}

function EventRange({ event }: { event: RefinementEventScope }) {
  return <span className={styles.eventRange}>
    <span className={styles.scopeMeta}>{event.unitCount}个完整单元 · {event.shotCount}镜{event.wholeEpisode ? " · 全集" : ""}</span>
    <SourceAnchor label="原文起点" anchor={event.sourceStart} /><SourceAnchor label="原文终点" anchor={event.sourceEnd} />
  </span>;
}

function selectedScope(scope: RefinementScope | undefined, eventIds: string[], unitIds: string[], units: Unit[]) {
  const chosen = new Set(unitIds), all = scope?.events.flatMap(event => event.unitIds) || [];
  const wholeEpisode = Boolean(scope?.wholeEpisode && all.length && all.every(id => chosen.has(id)) && chosen.size === scope?.unitCount);
  const shotCount = scope?.units ? scope.units.filter(unit => chosen.has(unit.id)).reduce((total, unit) => total + unit.shotCount, 0) : units.filter(unit => chosen.has(unit.id)).reduce((total, unit) => total + unit.shots.length, 0);
  return `${eventIds.length}个事件 · ${chosen.size}个完整单元 · ${shotCount}镜 · ${wholeEpisode ? "全集" : "局部"}`;
}

export function RefinementPanel(props: Props) {
  return <RefinementPanelContent key={props.run.id} {...props} />;
}

function RefinementPanelContent({ run, endpoint, disabled, pending, canExecute = true, act }: Props) {
  const scope = run.refinement?.scope;
  const targeted = run.refinement?.targeted === true;
  const improving = run.refinementVersion === "director-refinement-v3";
  const events = (scope?.events || []).filter(event => !run.refinement || run.refinement.eventIds.includes(event.id));
  const units = run.assembly?.draft?.units || [];
  const scopedUnits = scope?.units || [];
  // The panel mounts before generation has supplied a scope. Keep the default
  // derived until the first user edit, rather than freezing that initial [] or
  // overwriting a manual selection on every polling response.
  const [manualScope, setManualScope] = useState<{ eventIds: string[]; unitIds: string[] } | null>(null);
  const selected = manualScope?.eventIds ?? (improving ? events.map(event => event.id) : events[0] ? [events[0].id] : []);
  const selectedUnits = manualScope?.unitIds ?? (improving ? events.flatMap(event => event.unitIds) : events[0]?.unitIds || []);
  const [reviewNotes, setReviewNotes] = useState("");
  const [preserveNotes, setPreserveNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [groupSelection, setGroupSelection] = useState<Record<string, string[]>>({});
  const [sourceReviews, setSourceReviews] = useState<Record<string, { checked: boolean; reason: string }>>({});
  const refinementHistory = run.candidates.filter(isRefinement);
  // A successful free recovery is the same paid response, not a second round.
  // Keep the original failure in execution history without presenting it as a
  // current unresolved candidate (also covers saved pre-resolvedBy recoveries).
  const recoveredIds = new Set(refinementHistory.filter(candidate => ["refinement_ready", "refinement_no_change", "adopted"].includes(candidate.status)).map(candidate => candidate.derivedFrom).filter(Boolean));
  const candidates = refinementHistory.filter(candidate => !candidate.resolvedBy && !recoveredIds.has(candidate.id));
  const hasRound = run.operations.some(isRefinement) || candidates.length > 0;
  const activity = refinementActivityLabel(run);
  const live = Boolean(activity && run.active);
  const selectedEvents = events.filter(event => selected.includes(event.id));
  const availableUnitIds = selectedEvents.flatMap(event => event.unitIds);
  const unitPositions = selectedUnits.map(id => units.findIndex(unit => unit.id === id));
  const contiguousUnits = unitPositions.every((position, index) => position >= 0 && (!index || position === unitPositions[index - 1] + 1));
  const partialFantasy = (run.assembly?.draft?.fantasyRealization || []).some(value => {
    const links = value && typeof value === "object" ? (value as { unitIds?: unknown }).unitIds : null;
    return Array.isArray(links) && links.some(id => selectedUnits.includes(id)) && links.some(id => !selectedUnits.includes(id));
  });
  const validSelection = selected.length > 0 && selected.length <= (improving ? 500 : 2) && selected.every((id, index) => events.findIndex(event => event.id === id) >= 0 && (!index || events.findIndex(event => event.id === id) === events.findIndex(event => event.id === selected[index - 1]) + 1)) && (!targeted || selectedUnits.length > 0 && contiguousUnits && !partialFantasy && selectedUnits.every(id => availableUnitIds.includes(id) && scopedUnits.some(unit => unit.id === id)));
  const blocked = disabled || run.active || run.sourceStale || run.blocked || run.sourceCheckPending || run.legacyReadOnly;
  if (!run.assembly?.text || !run.refinementVersion && !hasRound) return null;
  const canAdd = (id: string) => selected.includes(id) || selected.length < (improving ? 500 : 2) && (!selected.length || selected.some(value => Math.abs(events.findIndex(event => event.id === id) - events.findIndex(event => event.id === value)) === 1));
  const toggle = (id: string) => {
    const included = selected.includes(id), eventUnits = events.find(event => event.id === id)?.unitIds || [];
    setManualScope({
      eventIds: included ? selected.filter(value => value !== id) : events.filter(event => selected.includes(event.id) || event.id === id).map(event => event.id),
      unitIds: included ? selectedUnits.filter(value => !eventUnits.includes(value)) : scopedUnits.filter(unit => selectedUnits.includes(unit.id) || eventUnits.includes(unit.id)).map(unit => unit.id),
    });
  };
  const toggleUnit = (id: string) => setManualScope({ eventIds: selected, unitIds: selectedUnits.includes(id) ? selectedUnits.filter(value => value !== id) : scopedUnits.filter(unit => selectedUnits.includes(unit.id) || unit.id === id).map(unit => unit.id) });

  return <WorkflowGlassCard index={0} state={live ? "running" : candidates.some(candidate => candidate.status === "refinement_invalid") ? "attention" : "idle"} className={styles.panel} aria-label="可选导演精修">
    <header className={styles.heading}><div><h3 className={glass.title}>导演精修 <span className={styles.optional}>可选</span></h3><p>{improving ? "默认检查整集，主动找薄弱点并局部改稿，再复查原文与已有强项。不必先填写问题。" : targeted ? "在1至2个连续事件中选择完整单元，按观看问题生成一次精修候选。" : "选定1至2个连续完整事件，生成一次精修候选。"}</p></div><span className={glass.status}>{activity || (candidates.at(-1)?.status === "refinement_no_change" ? "未产生改善" : hasRound ? "本次精修已记录" : "完整稿后按需使用")}</span></header>
    {run.seriesDirectionStatus === "not_adopted" ? <p className={styles.direction}>未读取已采用全剧方向</p> : run.seriesDirectionStatus !== "adopted" ? <p className={styles.note}>本任务未记录全剧方向读取状态。</p> : null}
    {activity ? <p role="status" className={styles.activity}>{activity}。已有完整稿仍可审看。</p> : null}
    <div className={styles.actions}><a className="quietButton" href={`${endpoint}?${new URLSearchParams({runId:run.id,format:"review"})}`} download>下载本稿审阅材料</a></div>
    {run.refinement?.available && events.length ? <div className={styles.scope}>
      <fieldset disabled={Boolean(blocked || submitted)}><legend>{improving ? "精修范围 · 默认全集，可缩到连续完整单元" : "精修范围 · 1至2个连续事件"}</legend><div className={styles.events}>{events.map((event, index) => <label key={event.id}><input type="checkbox" aria-label={`选择${event.title || `事件${index + 1}`}`} checked={selected.includes(event.id)} disabled={!canAdd(event.id)} onChange={() => toggle(event.id)} /><span><strong>{event.title || `事件${index + 1}`}</strong><EventRange event={event} /></span></label>)}</div></fieldset>
      {targeted ? <fieldset disabled={Boolean(blocked || submitted)}><legend>细化到完整单元 · 至少选择1个</legend><div className={styles.units}>{scopedUnits.filter(unit => availableUnitIds.includes(unit.id)).map(unit => <label key={unit.id}><input type="checkbox" aria-label={`选择完整单元 ${unit.id}`} checked={selectedUnits.includes(unit.id)} onChange={() => toggleUnit(unit.id)} /><span>{unit.id} · {unit.title}<small>{unit.shotCount}镜</small><SourceAnchor label="原文起点" anchor={unit.sourceStart} /><SourceAnchor label="原文终点" anchor={unit.sourceEnd} /></span></label>)}</div></fieldset> : null}
      <p className={styles.selection}>本次范围：{selectedScope(scope, selected, targeted ? selectedUnits : availableUnitIds, units)}</p>
      {targeted && selectedUnits.length > 1 && !contiguousUnits ? <p className={styles.direction}>单元范围须连续，请选择相邻完整单元。</p> : null}
      {targeted && partialFantasy ? <p className={styles.direction}>所选范围包含跨单元幻想，请选入全部关联单元。</p> : null}
      {targeted ? <fieldset className={styles.workOrder} disabled={Boolean(blocked || submitted)}><legend>精修工作单 · 可选</legend><label>具体观看问题<textarea aria-label="具体观看问题" value={reviewNotes} maxLength={1200} rows={3} placeholder="例如：反应重音重复，揭示太早。" onChange={event => setReviewNotes(event.target.value.slice(0, 1200))} /></label><label>必须保留的功能<textarea aria-label="必须保留的功能" value={preserveNotes} maxLength={1200} rows={3} placeholder="例如：保留人物慢说、停顿和现实回接。" onChange={event => setPreserveNotes(event.target.value.slice(0, 1200))} /></label></fieldset> : null}
      <button type="button" className="studioButton" data-variant="secondary" disabled={Boolean(blocked || submitted || !canExecute || !validSelection || !run.refinement.basisHash)} onClick={() => { setSubmitted(true); void act("refine", { eventIds: selected, ...(targeted ? { unitIds: selectedUnits, reviewNotes, preserveNotes } : {}), expectedBaseHash: run.refinement?.basisHash }).finally(() => setSubmitted(false)); }}>{pending === "refine" || submitted ? "精修请求已提交" : "生成一次导演精修候选"}</button>
    </div> : run.refinement?.available ? <p className={styles.note}>当前任务未提供可核对的精修范围；请下载本稿复核。</p>
    : !hasRound ? <p className={styles.note}>当前稿件或执行状态尚不支持精修；可继续审看已有完整稿。</p> : null}
    {candidates.map(candidate => {
      const validation = candidate.validation as { errors?: unknown[] } | undefined;
      const errors = [...(candidate.errors || []), ...(validation?.errors || [])];
      const stale = !candidate.refinement?.baseAssemblyHash || candidate.refinement.baseAssemblyHash !== run.refinement?.basisHash;
      const comparison = candidate.refinement?.comparison;
      const changed = comparison?.status === "changed";
      const candidateScope = candidate.refinement?.scope || scope;
      const candidateEvents = candidateScope?.events.filter(event => candidate.refinement?.eventIds.includes(event.id)) || [];
      const candidateUnits = candidate.refinement?.unitIds || candidateEvents.flatMap(event => event.unitIds);
      const chain = run.production?.chainMode === "CHAIN";
      const adopted = candidate.adoptedRefinement;
      const groups = candidate.refinement?.acceptanceGroups || [];
      const selectedGroups = groups.filter(group => (groupSelection[candidate.id] || []).includes(group.id));
      const partialBlock = selectedGroups.length > 0 && selectedGroups.length < groups.length ? candidate.refinement?.partialAdoptionBlocked : null;
      const conflictReview = candidate.refinement?.conflictReview;
      const sourceReview = sourceReviews[candidate.id] || { checked: false, reason: "" };
      const sourceReviewed = Boolean(conflictReview && sourceReview.checked && sourceReview.reason.trim());
      const adoptionReason = adopted ? "" : candidate.adoptionBlocked?.message || (chain ? "跨集任务保留基稿，精修候选可审看和导出。" : stale ? "基稿已变化，保留此候选供对照。" : "");
      const canAdopt = changed && candidate.status === "refinement_ready" && Boolean(candidate.previewText) && !blocked && !stale && !chain && (!candidate.adoptionBlocked || sourceReviewed);
      const reviewQuery = new URLSearchParams({ runId: run.id, format: "review", candidateId: candidate.id });
      return <section key={candidate.id} className={styles.candidate} aria-label="导演精修候选">
        <div className={styles.candidateHeading}><strong>{adopted ? "精修采用记录" : "精修候选"}</strong><span>{adopted?.partial ? "已采用部分修改组" : candidate.status === "refinement_no_change" ? "未产生改善，保留原稿" : comparison?.status === "unchanged" ? "无改动，保留原稿" : !changed ? "改动尚无法核对，保留原稿" : statusLabel(candidate.status)}</span></div>
        {changed ? <p className={styles.selection}>已核对改动：{comparison.changedUnitIds.length}个单元 · {comparison.changedShotIds.length}镜</p> : null}
        {candidateEvents.length ? <details className={styles.recordedScope}><summary>本轮精修范围 · {selectedScope(candidateScope, candidate.refinement?.eventIds || [], candidateUnits, units)}</summary>{candidateEvents.map(event => <div key={event.id}><strong>{event.title}</strong><EventRange event={event} /></div>)}</details> : null}
        {candidate.refinement?.reviewDecisions?.length ? <details className={styles.recordedScope}><summary>{candidate.refinement.version === "director-refinement-v3" ? "发现的问题与实际改稿" : "工作单处理说明"}</summary>{adopted?.partial ? <p className={styles.note}>这是原完整候选的处理说明，不表示这些改动都已采用；采用范围以下方记录为准。</p> : null}<ul className={styles.decisions}>{candidate.refinement.reviewDecisions.map((decision, index) => <li key={index}><span>{decision.unitIds.join("、")} · {decision.disposition === "retained" ? "保留" : decision.disposition === "unresolved" ? "待核对" : "实际改稿"}</span><p>{decision.reason}</p>{decision.preservedFunction ? <p>保留功能：{decision.preservedFunction}</p> : null}</li>)}</ul></details> : null}
        {adopted ? <p className={styles.selection}>实际采用 {adopted.groupIds.length} 个修改组，保留 {adopted.retainedUnitIds.length} 个基稿单元。原始候选和回包仍在历史中；下方及导出展示实际采用稿。</p> : null}
        {candidate.previewText ? <details open><summary>{adopted ? "查看实际采用稿" : "查看完整精修候选"}</summary><pre className={styles.preview}>{candidate.previewText}</pre></details> : <p className={styles.note}>已保存回包，尚无可用的完整候选。</p>}
        {conflictReview && !adopted ? <fieldset className={styles.workOrder} disabled={Boolean(blocked || stale || chain)}><legend>原文冲突核对 · 免费</legend>
          <p className={styles.note}>仅适用于工作单笔误，且候选已经遵守原文。不能用此项放行违背原文的候选或缺失材料；原冲突和核对理由会保留。</p>
          {conflictReview.items.map(item => <div key={item.key}><p>{item.problem}</p>{item.sources.map(row => <p key={row.id}><SourceAnchor label="原文依据" anchor={row} /></p>)}</div>)}
          <label><input type="checkbox" aria-label="已核对候选遵守原文，冲突仅为工作单笔误" checked={sourceReview.checked} onChange={event => setSourceReviews(previous => ({...previous, [candidate.id]: {...sourceReview, checked: event.target.checked}}))} />已核对候选遵守原文，冲突仅为工作单笔误</label>
          <label>原文核对理由<textarea aria-label="原文核对理由" maxLength={1200} rows={2} value={sourceReview.reason} onChange={event => setSourceReviews(previous => ({...previous, [candidate.id]: {...sourceReview, reason: event.target.value}}))} /></label>
        </fieldset> : null}
        {candidate.sourceResolution ? <p className={styles.note}>已按原文核对工作单笔误：{candidate.sourceResolution.reason}。原始冲突仍保留在执行回执中。</p> : null}
        {groups.length && candidate.status === "refinement_ready" && changed ? <fieldset className={styles.adoptionGroups} disabled={!canAdopt}>
          <legend>按完整修改组择优采用</legend><p className={styles.note}>不默认采用任何组。勾选你审看认可的改动，未选部分保持基稿；勾选不是创作品质验证。</p>
          {groups.map((group, index) => <label key={group.id}><input type="checkbox" aria-label={`采用修改组 ${index + 1}`} checked={selectedGroups.includes(group)} onChange={event => setGroupSelection(previous => ({...previous, [candidate.id]: event.target.checked ? [...(previous[candidate.id] || []).filter(id => id !== group.id), group.id] : (previous[candidate.id] || []).filter(id => id !== group.id)}))} /><span><strong>修改组 {index + 1}</strong><small>基稿 {group.replacedUnitIds.join("、")} → 候选 {group.proposedUnitIds.join("、")}</small>{group.reasons.map(reason => <small key={reason}>{reason}</small>)}</span></label>)}
          {candidate.refinement?.partialAdoptionBlocked ? <p className={styles.direction}>{candidate.refinement.partialAdoptionBlocked.message}</p> : null}
        </fieldset> : null}
        {errors.length ? <ul className={styles.errors}>{errors.slice(0, 4).map((error, index) => <li key={index}>{messageOf(error)}</li>)}</ul> : null}
        {adoptionReason ? <p className={styles.note}>{adoptionReason}</p> : null}
        <div className={styles.actions}>{changed && candidate.status === "refinement_ready" ? <button type="button" className="studioButton" data-variant="secondary" disabled={!canAdopt || Boolean(groups.length && !selectedGroups.length) || Boolean(partialBlock)} onClick={() => void act("accept_refinement", { candidateId: candidate.id, expectedBaseHash: candidate.refinement?.baseAssemblyHash, ...(groups.length ? {groupIds: selectedGroups.map(group => group.id)} : {}), ...(sourceReviewed ? {sourceResolution: {conflictHash: conflictReview!.conflictHash, reason: sourceReview.reason}} : {}) })}>{groups.length ? "采用选中修改组 · 免费" : "采用此精修候选 · 免费"}</button> : null}
          {candidate.previewText ? <a className="quietButton" href={`${endpoint}?${reviewQuery}`} download>{changed ? "下载盲审材料" : "下载单稿复核"}</a> : null}</div>
      </section>;
    })}
  </WorkflowGlassCard>;
}
