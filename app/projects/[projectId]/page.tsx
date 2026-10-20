import { notFound } from "next/navigation";
import { getProjectStudio } from "@/lib/studio";
import { getFoundationDeliveryState } from "@/lib/foundation-delivery";
import { prisma } from "@/lib/prisma";
import { AppChrome } from "@/app/ui/app-chrome";
import { FoundationUsage } from "./foundation-actions";
import { FoundationDeliveryPanel, FoundationWorkflowStatus } from "./foundation-delivery-panel";
import { LightFoundationDocumentViewer } from "./foundation-document-viewer";
import { SceneStructureTable } from "./scene-structure-table";
import { PresentationContracts } from "./presentation-contracts";
import { ModeSwitch } from "../../mode-switch";
import { requireSessionUser } from "@/lib/auth";
import { resolvePresentationContractScope } from "@/lib/presentation-contracts";
import "@/app/page-surfaces.css";
import "@/app/workbench-refinement.css";
import { episodePresentation } from "@/lib/episode-presentation";
import { isProductionEpisodeNumber, readProductionScope } from "@/lib/production-episodes";

export const dynamic = "force-dynamic";

export default async function ProjectStudioPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<{ foundationNotice?: string | string[] }> }) {
  const { projectId } = await params;
  const foundationNotice = (await searchParams)?.foundationNotice;
  const currentUser = await requireSessionUser(`/projects/${projectId}`);
  const studio = await getProjectStudio(projectId, currentUser.id);
  if (!studio) notFound();

  const delivery = await getFoundationDeliveryState(projectId);
  const sourceEpisodes = await prisma.episode.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { id: true, number: true, title: true, content: true } });
  const productionScope = await readProductionScope(projectId);
  const productionEpisodes = sourceEpisodes.filter(episode => isProductionEpisodeNumber(episode.number, productionScope));
  const sceneCounts = new Map(studio.episodes.map(episode => [episode.id, episode.scenes.length]));
  const foundationRuns = studio.firstPhase.stages;
  const deliveryView = { task: delivery.task, totalEpisodes: delivery.totalEpisodes, availableEpisodes: delivery.availableEpisodes, editedEpisodes: delivery.editedEpisodes,
    busy: delivery.busy, complete: delivery.complete, needsContextEdit: delivery.needsContextEdit, action: delivery.action, expectedState: delivery.expectedState,
    suggestionsCount: delivery.suggestionsCount, continuationBlocker: delivery.continuationBlocker, activeCallStartedAt: delivery.activeCallStartedAt, methodUpdateAvailable: delivery.methodUpdateAvailable };
  const unknownOutcome = delivery.action === "UNKNOWN_CONFIRM" || Boolean(delivery.task?.unknownOutcome);
  const decisionNotice = foundationNotice === "decision-changed" ? "问题或资料已更新，本次未保存；请查看当前选项后重新选择。"
    : foundationNotice === "decision-invalid" ? "请选择有效方案，或填写具体的自定义决定；本次尚未保存。"
      : foundationNotice === "decision-running" ? "资料仍在处理中，本次未保存；请等待本轮处理结束。"
        : foundationNotice === "decision-required" ? "还有必要决定未确认，本次未发起新调用；请查看下方选项。"
          : foundationNotice === "decision-collected" ? delivery.busy ? "选择已保存，正在整理资料；页面会自动更新。" : delivery.requiredChoices.length ? `本次选择已保存，仍有 ${delivery.requiredChoices.length} 项待确认；全部完成后会自动整理。` : "选择已保存，请查看当前整理状态。"
          : foundationNotice === "decision-continued" ? delivery.busy ? "必要选择已保存，正在统一应用并整理；页面会自动更新。" : delivery.requiredChoices.length ? `选择已保存，当前还有 ${delivery.requiredChoices.length} 项待确认，请继续查看确认区。` : "选择已保存，请查看当前整理状态。"
            : foundationNotice === "decision-saved" ? "决定已保存；继续完成时会应用这一决定。" : null;
  const notice = foundationNotice === "state-changed" ? "页面状态已更新，本次未发起新调用；请核对当前资料后再继续。"
    : foundationNotice === "call-unknown" ? "上次请求结果尚未确认，本次没有重发。已有资料仍保留；如接受可能重复计费，请明确勾选后继续。"
      : foundationNotice === "worker-unknown" ? "暂时无法确认执行状态，本次未发起新调用；请稍后重新检查。"
        : foundationNotice === "worker-unchanged" ? "尚不能确认后台已退出；未停止任务，也未发起新调用。"
          : foundationNotice === "delivery-unavailable" ? "暂时无法接收这次操作，已保存资料和决定没有丢失；请稍后再试。" : null;

  return <AppChrome title={studio.project.title} eyebrow="全剧资料工作台" projectId={projectId} activeSection="project" projectLabel={studio.project.title} episodes={productionEpisodes.map(episode => ({ id: episode.id, number: episode.number, title: episode.title || "", productionEligible: true }))}
    primaryAction={<FoundationDeliveryPanel projectId={projectId} requiredChoiceCount={delivery.requiredChoices.length} state={deliveryView} compact />}
    utility={<><ModeSwitch projectId={projectId} current={studio.project.executionMode} compact disabled={delivery.busy} /><div className="projectTopbarMeta" aria-label={`视觉风格 ${studio.project.style}，画幅 ${studio.project.aspectRatio}，${productionEpisodes.length} 集`}><span>{studio.project.style}</span><span>{studio.project.aspectRatio}</span><span>{productionEpisodes.length} 集</span></div></>}>
    <div className="projectDashboard">
      {decisionNotice ? <p role="status" className="biblePlaceholder">{decisionNotice} <a href="#presentation-contracts">查看确认区</a></p> : null}
      {notice ? <p role="status" className="biblePlaceholder">{notice}</p> : null}
      <FoundationWorkflowStatus projectId={projectId} state={deliveryView} requiredChoiceCount={delivery.requiredChoices.length} sourceReady={Boolean(studio.firstPhase.preprocessReady)} sceneCount={studio.episodes.reduce((count, episode) => count + episode.scenes.length, 0)}
        remaining={[...new Set([...delivery.document.editorialTodos.filter(todo => todo.owner !== "STAGE2").map(todo => todo.note), ...delivery.issues.map(issue => issue.problem)])]} />
      <section className="studioSection" id="phase-one">
        <PresentationContracts projectId={projectId} pending={delivery.requiredChoices} confirmed={delivery.confirmedChoices}
          active={delivery.busy || unknownOutcome} mode="delivery" expectedTaskId={delivery.task?.id}
          decisionContinued={foundationNotice === "decision-continued"}
          decisionCollected={foundationNotice === "decision-collected"}
          blockedReason={unknownOutcome ? "请先处理上方的请求恢复，再确认这些决定。" : undefined} />
        <div className="sectionHeading">
          <div><span className="sectionIndex">01</span><h2>全剧基础工程</h2></div>
          <p>原文按集查看，资产按名称管理；图片和后续分镜另行制作。</p>
          <a className="studioButton" data-variant="secondary" href={`/projects/${encodeURIComponent(projectId)}/preparation`}>剧本阅读与全剧方向</a>
          <a className="quietButton" href={`/projects/${encodeURIComponent(projectId)}/asset-prompts`}>第二阶段 · 资产形象设计</a>
        </div>
        <LightFoundationDocumentViewer projectId={projectId} state={delivery} sourceEpisodes={sourceEpisodes.map(episode => ({ ...episode, sceneCount: sceneCounts.get(episode.id) ?? 0, productionEligible: isProductionEpisodeNumber(episode.number, productionScope) }))} />
        {delivery.complete ? <p className="mutedSmall">全文资料已整理：要不要更强的情绪、更快的运镜，以及更多、更大胆的幻想表达？<a href={`/projects/${encodeURIComponent(projectId)}/preparation#series-direction`}>查看剧情建议并确认表达选择</a>。候选不自动采用；修改、保存和确认无需额外模型调用，不改变已有制作结果，也不需要重读资料。旧版缺少建议时可手工选择，不冒充已作全文评估。</p> : null}
        {delivery.document.editorialTodos.some(todo => todo.owner === "STAGE2") ? <details className="bibleSection"><summary className="bibleSectionHead">后续分镜提醒（不触发第一阶段重试）</summary>
          <div className="bibleBody">{delivery.document.editorialTodos.filter(todo => todo.owner === "STAGE2").map(todo => <p key={todo.id}>{todo.episodes?.length ? `第${todo.episodes.join("、")}集：` : ""}{todo.note}</p>)}</div>
        </details> : null}
        <details className="bibleSection" id="foundation-history">
          <summary className="bibleSectionHead">处理历史与调用用量</summary>
          <div className="bibleBody">
            <p>以下仅展示已保存的处理记录，不代表当前资料已完成。原文、旧稿和原始响应保留在导出文件中。</p>
            <a className="quietButton" href={`/projects/${encodeURIComponent(projectId)}/foundation/export`}>导出资料与历史 JSON</a>
            {delivery.task ? <details><summary>本次处理记录</summary><p>{delivery.task.message}</p><p>本任务累计请求 {delivery.task.addedCalls} 次 · 自动修正 {delivery.task.repairCalls} 次</p>{delivery.task.error ? <p className="roleRunError">{delivery.task.error}</p> : null}</details> : null}
            {delivery.document.f1 || delivery.previousDocument ? <p>旧版分集导航与历史修订仍保留在导出资料中，不替代左侧原文。</p> : null}
            {delivery.document.notes.length ? <details><summary>整理说明</summary>{delivery.document.notes.map((note, index) => <p key={index}>{note}</p>)}</details> : null}
            {delivery.document.editorialTodos.length || delivery.issues.length ? <details><summary>待完善事项</summary>{delivery.document.editorialTodos.map(todo => <p key={todo.id}>{todo.note}</p>)}{delivery.issues.map((issue, index) => <p key={index}>{issue.problem}</p>)}</details> : null}
            <div style={{ overflowX: "auto" }}><table style={{ width: "100%", minWidth: 560, textAlign: "left" }}>
              <thead><tr><th scope="col">处理环节</th><th scope="col">记录状态</th><th scope="col">模型</th><th scope="col">耗时</th></tr></thead>
              <tbody>{foundationRuns.map(run => <tr key={run.stageCode}><th scope="row">{run.name}</th><td>{run.status}</td><td>{run.model}</td><td>{run.duration}</td></tr>)}</tbody>
            </table></div>
            <FoundationUsage runs={foundationRuns} />
            {foundationRuns.filter(run => run.error).map(run => <details key={run.stageCode}><summary>{run.name} · {run.errorHistorical ? "历史处理说明" : "处理说明"}</summary><p className="roleRunError">{run.error}</p></details>)}
            {studio.assets.length ? <details><summary>历史资产名称简表（{studio.assets.length} 项）</summary><p>{studio.assets.map(asset => `${asset.code} · ${asset.name}`).join("；")}</p></details> : null}
          </div>
        </details>
        <div id="foundation-scenes"><SceneStructureTable scenes={studio.episodes.flatMap(episode => episode.scenes.map(scene => ({
          episodeNumber: episode.number, sceneKey: scene.sceneKey, heading: scene.heading ?? scene.location ?? scene.sceneKey,
          location: scene.location ?? "未注明", timeOfDay: scene.timeOfDay ?? "未注明", interiorExterior: scene.interiorExterior ?? "未注明",
          weather: scene.weather ?? "未注明", timeLayer: scene.timeLayer, sourceText: scene.sourceText
        })))} /></div>
      </section>
      <section className="studioSection" id="phase-three">
        <div className="sectionHeading"><div><span className="sectionIndex">03</span><h2>分镜创作</h2></div><p>从本集原文开始：情绪统筹、完整主创、统一整编。进入工作台不会自动调用模型。</p></div>
        {productionEpisodes.length?<div className="stageThreeEpisodeEntries"><a className="studioButton" data-variant="primary" href={`/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(productionEpisodes[0].id)}/storyboard`}>进入分镜工作台</a><a className="studioButton" data-variant="secondary" href={`/projects/${encodeURIComponent(projectId)}/production`}>连续制作 · 选集与预算</a></div>:null}
        <details className="bibleSection"><summary className="bibleSectionHead">选择其他剧集 · {productionEpisodes.length} 集</summary><div className="stageThreeEpisodeEntries" aria-label="进入第三阶段">{productionEpisodes.map(episode => <a className="studioButton" data-variant="secondary" href={`/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episode.id)}/storyboard`} key={episode.id}>{episodePresentation(episode.number, episode.title, { sceneCount: sceneCounts.get(episode.id) }).fullTitle}</a>)}</div></details>
        {!productionEpisodes.length ? <p className="biblePlaceholder">先准备可用分集原文，再进入第三阶段。第二阶段为资产形象设计。</p> : null}
      </section>
    </div>
  </AppChrome>;
}
