import Link from "next/link";
import { notFound } from "next/navigation";
import { confirmAllAssetsAction, startProjectFoundationAction, stopProjectFoundationAction } from "@/app/actions";
import { deriveEpisodeProductionStatus, formatEpisodeGroupProgress, getProjectStudio } from "@/lib/studio";
import { prisma } from "@/lib/prisma";
import { deriveProjectGuidance } from "@/lib/ui-guidance";
import { AppChrome } from "@/app/ui/app-chrome";
import { WorkflowGuidance } from "@/app/ui/workflow-guidance";
import { AssetExportButton, AssetIndexTabs } from "./asset-index-tabs";
import { FoundationActions } from "./foundation-actions";
import { ProjectBibleViewer } from "./project-bible-viewer";
import { SceneStructureTable } from "./scene-structure-table";
import { PresentationContracts } from "./presentation-contracts";
import { ModeSwitch } from "../../mode-switch";
import { StopFoundationButton } from "./stop-foundation-button";
import { BatchMonitorControl } from "./batch-monitor-control";
import { FoundationReferenceGrid } from "./foundation-reference-grid";
import { requireSessionUser } from "@/lib/auth";
import { resolvePresentationContractScope } from "@/lib/presentation-contracts";
import "@/app/page-surfaces.css";
import "@/app/workbench-refinement.css";

export const dynamic = "force-dynamic";

export default async function ProjectStudioPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const currentUser = await requireSessionUser(`/projects/${projectId}`);
  const studio = await getProjectStudio(projectId, currentUser.id);
  if (!studio) notFound();

  const foundationRuns = studio.foundationRuns;
  const foundationActive = studio.foundationActive;
  const foundationReady = studio.foundationReady;
  const activeFoundationRun = foundationRuns.find((run) => run.status === "进行中" || run.status === "排队中");
  const activeFoundationStage = activeFoundationRun?.stageCode;
  const foundationStatusLabel = activeFoundationRun?.status === "排队中"
    ? `${activeFoundationStage ?? "P1"} 排队中`
    : activeFoundationStage
      ? `正在运行 ${activeFoundationStage}`
      : "正在整理 P1–P2";

  const contracts = await prisma.presentationContract.findMany({
    where: { projectId, status: "PENDING" },
    orderBy: { createdAt: "asc" }
  });
  const confirmedContracts = await prisma.presentationContract.findMany({
    where: { projectId, status: "CONFIRMED" },
    orderBy: { decidedAt: "asc" }
  });

  const productionEpisodes = studio.episodes.filter((episode) => episode.number >= 1);
  const formalEpisodeNumbers = productionEpisodes.map((episode) => episode.number);
  const episodeNumberById = new Map(studio.episodes.map((episode) => [episode.id, episode.number]));
  const contractRow = (contract: (typeof contracts)[number] | (typeof confirmedContracts)[number]) => {
    let options: string[] = [];
    try {
      const parsed: unknown = JSON.parse(contract.options);
      options = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      options = [];
    }
    const sourceEpisodeNumber = contract.episodeId ? episodeNumberById.get(contract.episodeId) ?? null : null;
    const scope = resolvePresentationContractScope({
      scope_mode: contract.scopeMode,
      target_episode_numbers: contract.targetEpisodeNumbers,
      source_episode_number: sourceEpisodeNumber
    }, formalEpisodeNumbers);
    return {
      id: contract.id,
      category: contract.category,
      question: contract.question,
      options,
      evidence: contract.evidence,
      userAnswer: contract.userAnswer,
      sourceEpisodeNumber,
      episodeNumbers: scope.episodeNumbers,
      scopeMode: scope.mode,
      round: contract.round,
      decidedAt: contract.decidedAt
    };
  };
  const auxiliaryEpisodeCount = studio.episodes.filter((episode) => episode.number < 1).length;
  const episodeStates = productionEpisodes.map((episode) => {
    const state = deriveEpisodeProductionStatus(episode.roles, episode.shotCount > 0 || episode.unitCount > 0);
    const running = state === "生成中";
    const failed = state === "需处理";
    const finished = state === "已完成";
    return {
      id: episode.id,
      number: episode.number,
      title: episode.title,
      shotCount: episode.shotCount,
      running,
      failed,
      finished,
      state
    };
  });
  const episodeStateById = new Map(episodeStates.map((episode) => [episode.id, episode]));
  const assetRows = studio.assets.map((asset) => ({
    id: asset.id,
    code: asset.code,
    type: asset.type,
    name: asset.name,
    status: asset.status,
    parentId: asset.parentId,
    role: asset.role,
    episodeNumber: asset.episodeId ? episodeNumberById.get(asset.episodeId) ?? null : null,
    sourceText: asset.sourceText,
    notes: asset.notes
  }));
  const episodeGroups: Array<{ start: number; episodes: typeof productionEpisodes }> = [];
  for (const episode of productionEpisodes) {
    const start = Math.floor((episode.number - 1) / 10) * 10 + 1;
    let group = episodeGroups.find((item) => item.start === start);
    if (!group) {
      group = { start, episodes: [] };
      episodeGroups.push(group);
    }
    group.episodes.push(episode);
  }
  episodeGroups.sort((a, b) => a.start - b.start);
  const firstActionableEpisode = episodeStates.find((episode) => !episode.finished)?.number ?? productionEpisodes[0]?.number ?? 1;
  const defaultEpisodeGroupStart = Math.floor((firstActionableEpisode - 1) / 10) * 10 + 1;
  const guidance = deriveProjectGuidance({
    pendingContracts: contracts.length,
    planningReady: studio.firstPhase.planningReady,
    assetsReady: studio.firstPhase.assetsReady,
    foundationActive,
    foundationReady,
    batchMonitor: studio.batchMonitor ? {
      status: studio.batchMonitor.status,
      message: studio.batchMonitor.message,
      error: studio.batchMonitor.error,
      processed: studio.batchMonitor.processed,
      total: studio.batchMonitor.total
    } : null,
    episodes: episodeStates
  });
  const guidanceHref = guidance.kind === "contracts"
    ? "#presentation-contracts"
    : guidance.kind === "foundation"
      ? "#foundation-actions"
      : guidance.kind === "batch-running" || guidance.kind === "batch-paused"
        ? "#batch-episode-monitor"
      : guidance.episodeId
        ? `/projects/${projectId}/episodes/${guidance.episodeId}`
        : "#phase-two";
  const guidanceAction = guidance.kind === "foundation" ? (
    <form action={startProjectFoundationAction}>
      <input name="projectId" type="hidden" value={projectId} />
      <button type="submit" className="glassPrimary" disabled={foundationActive}>
        {foundationActive ? foundationStatusLabel : guidance.actionLabel}
      </button>
    </form>
  ) : null;
  const guidedEpisodeNumber = guidance.episodeId
    ? studio.episodes.find((episode) => episode.id === guidance.episodeId)?.number
    : null;
  const topbarNextStep = guidance.kind === "continue" && guidedEpisodeNumber
    ? `下一步：第${guidedEpisodeNumber}集`
    : null;
  const topbarStatusLabel = topbarNextStep
    ?? (guidance.kind === "batch-paused" ? guidance.batchPauseReason === "quota" ? "额度不足：批量已暂停" : "批量已暂停" : null)
    ?? (guidance.kind === "batch-running" ? "自动推进中" : null)
    ?? (guidance.kind === "repair" && guidedEpisodeNumber ? `需处理：第${guidedEpisodeNumber}集` : null)
    ?? (guidance.kind === "running" && guidedEpisodeNumber ? `进行中：第${guidedEpisodeNumber}集` : null)
    ?? (guidance.kind === "contracts" ? `待确认：${contracts.length}项规范` : null)
    ?? (guidance.kind === "foundation" ? "下一步：全剧基础工程" : null)
    ?? (guidance.kind === "complete" ? "全剧初稿已完成" : null);
  const topbarNeedsAttention = guidance.kind === "repair" || guidance.kind === "contracts" || guidance.kind === "batch-paused";
  const batchMonitorActive = studio.batchMonitor?.status === "QUEUED" || studio.batchMonitor?.status === "RUNNING";
  const topbarStatusText = foundationActive
    ? foundationStatusLabel
    : batchMonitorActive
      ? "自动推进中"
      : guidance.kind === "batch-paused"
        ? guidance.batchPauseReason === "quota" ? "额度不足，已暂停" : "批量已暂停"
        : guidance.kind === "repair" ? "有待处理项"
          : guidance.kind === "contracts" ? "待确认"
            : "工作台已就绪";

  return (
    <AppChrome
      title={studio.project.title}
      eyebrow="全剧工作台"
      projectId={projectId}
      activeSection="project"
      episodes={episodeStates.map(({ id, number, title, state }) => ({ id, number, title, state }))}
      primaryAction={topbarStatusLabel ? (
        <span className="topbarNextStep" aria-label={topbarStatusLabel}>{topbarStatusLabel}</span>
      ) : null}
      utility={<><div className="projectTopbarMeta" aria-label={`视觉风格 ${studio.project.style}，画幅 ${studio.project.aspectRatio}，${productionEpisodes.length} 集`}><span>{studio.project.style}</span><span>{studio.project.aspectRatio}</span><span>{productionEpisodes.length} 集</span></div><ModeSwitch projectId={studio.project.id} current={studio.project.executionMode} compact /><span className="topbarStatus"><i className={foundationActive || batchMonitorActive ? "live" : topbarNeedsAttention ? "attention" : ""} />{topbarStatusText}</span><form action={stopProjectFoundationAction} className="topbarStopForm"><input name="projectId" type="hidden" value={projectId} /><StopFoundationButton active={foundationActive} /></form></>}
    >
      <div className="projectDashboard pageSurface workbenchSurface workbenchRefinement">
        <WorkflowGuidance
          eyebrow={guidance.eyebrow}
          title={guidance.title}
          description={guidance.description}
          href={guidanceAction ? undefined : guidanceHref}
          actionLabel={guidance.actionLabel}
          action={guidanceAction}
          meta={<><span>{productionEpisodes.filter((episode) => episode.shotCount > 0).length}/{productionEpisodes.length} 集已开始</span><span>{studio.assets.length} 项资产</span></>}
        />

      <section className="studioSection workbenchFoundation" id="phase-one" aria-labelledby="foundation-section-title">
        <div className="sectionHeading">
          <div><span className="sectionIndex">01</span><h2 id="foundation-section-title">全剧基础工程</h2></div>
          <p>只建立服务全集的固定资料；图片资产由外部导入，当前系统只管理名称与状态。</p>
        </div>
        <PresentationContracts
          projectId={projectId}
          pending={contracts.map(contractRow)}
          confirmed={confirmedContracts.map(contractRow)}
          formalEpisodeNumbers={formalEpisodeNumbers}
        />

        <FoundationActions
          projectId={studio.project.id}
          active={foundationActive}
          runs={foundationRuns}
          foundationReady={foundationReady}
          preprocessReady={productionEpisodes.length > 0}
          validationReady={studio.firstPhase.sceneCount > 0}
        />

        <FoundationReferenceGrid>
          <article className="studioCard surfaceReferenceCard" data-reference-card="bible">
            <div className="cardHeader"><div><span>PROJECT BIBLE</span><h3>项目策划与全剧索引</h3></div><em>{studio.firstPhase.planningReady ? "已生成" : "未生成"}</em></div>
            <ProjectBibleViewer content={studio.firstPhase.memory} />
          </article>

          <article className="studioCard surfaceReferenceCard" data-reference-card="assets">
            <div className="cardHeader">
              <div><span>ASSET INDEX</span><h3>资产名称简表</h3></div>
              <div className="cardHeaderActions">
                <em>{studio.assets.length}项</em>
                <AssetExportButton projectTitle={studio.project.title} assets={assetRows} />
                <form action={confirmAllAssetsAction}>
                  <input name="projectId" type="hidden" value={studio.project.id} />
                  <button type="submit" className="quietButton">全部确认</button>
                </form>
              </div>
            </div>
            <AssetIndexTabs assets={assetRows} />
          </article>
        </FoundationReferenceGrid>

        <SceneStructureTable scenes={productionEpisodes.flatMap((episode) => episode.scenes.map((scene) => ({
          episodeNumber: episode.number,
          sceneKey: scene.sceneKey,
          heading: scene.heading ?? scene.location ?? scene.sceneKey,
          location: scene.location ?? "待补充",
          timeOfDay: scene.timeOfDay ?? "待补充",
          interiorExterior: scene.interiorExterior ?? "待补充",
          weather: scene.weather ?? "默认",
          timeLayer: scene.timeLayer,
          sourceText: scene.sourceText
        })))} />
      </section>

      <section className="studioSection workbenchProduction" id="phase-two" aria-labelledby="production-section-title">
        <div className="sectionHeading">
          <div><span className="sectionIndex">02</span><h2 id="production-section-title">单集分镜生产</h2></div>
          <p>每集独立经过 E0–E5；最终由 Python 编译为一个个可单独发送给 Seedance 的分镜单元。</p>
        </div>
        {auxiliaryEpisodeCount ? <p className="episodePreludeNote">已保留 {auxiliaryEpisodeCount} 份前置资料（第0集/第1集以前内容），仅用于 P1/P2 理解编剧意图，不参与单集分镜生产，正式集号不会顺延。</p> : null}

        <BatchMonitorControl
          projectId={projectId}
          foundationReady={foundationReady}
          foundationActive={foundationActive}
          executionMode={studio.project.executionMode}
          monitor={studio.batchMonitor ? {
            status: studio.batchMonitor.status,
            message: studio.batchMonitor.message,
            error: studio.batchMonitor.error,
            processed: studio.batchMonitor.processed,
            total: studio.batchMonitor.total,
            legacyAutoRepair: studio.batchMonitor.legacyAutoRepair,
            skippedEpisodes: studio.batchMonitor.skippedEpisodes
          } : null}
        />

        <div className="episodeStudioGroups">
          {episodeGroups.map((group) => {
            const completedCount = group.episodes.filter((episode) => episodeStateById.get(episode.id)?.finished).length;
            const attentionCount = group.episodes.filter((episode) => episodeStateById.get(episode.id)?.failed).length;
            const startedCount = group.episodes.filter((episode) => episodeStateById.get(episode.id)?.state !== "未开始").length;
            const generatingCount = group.episodes.filter((episode) => episodeStateById.get(episode.id)?.running).length;
            const resumableCount = group.episodes.filter((episode) => episodeStateById.get(episode.id)?.state === "待继续").length;
            const end = group.episodes[group.episodes.length - 1]?.number ?? group.start;
            const groupProgressLabel = formatEpisodeGroupProgress({
              total: group.episodes.length,
              completed: completedCount,
              started: startedCount,
              generating: generatingCount,
              needsRepair: attentionCount,
              resumable: resumableCount
            });
            return (
              <details className="episodeStudioGroup" key={group.start} open={group.start === defaultEpisodeGroupStart}>
                <summary>
                  <span className="episodeStudioGroupTitle">第{group.start}–{end}集</span>
                  <span className="episodeStudioGroupMeta">{groupProgressLabel}</span>
                </summary>
                <div className="episodeStudioList">
                  {group.episodes.map((episode) => {
                    const episodeState = episodeStateById.get(episode.id)!;
                    const { running, failed, finished, state: status } = episodeState;
                    return (
                      <article key={episode.id}>
                        <div className="episodeNumber">{String(episode.number).padStart(2, "0")}</div>
                        <div className="episodeSummary">
                          <div><h3>{episode.title}</h3><span className={`stateDot ${finished ? "ok" : failed ? "bad" : running ? "live" : ""}`}>{status}</span></div>
                          <p>{episode.contentPreview}</p>
                        </div>
                        <div className="episodeCounts" aria-label={`${episode.scenes.length} 场，${episode.shotCount} 镜号，${episode.unitCount ? `${episode.unitCount} 单元` : "尚未生成"}`}>
                          <span><b>{episode.scenes.length}</b><small>场</small></span>
                          <span><b>{episode.shotCount}</b><small>镜号</small></span>
                          <span>{episode.unitCount ? <><b>{episode.unitCount}</b><small>单元</small></> : <b className="countMuted">尚未生成</b>}</span>
                        </div>
                        <Link href={`/projects/${studio.project.id}/episodes/${episode.id}`} className="primaryLink">{episode.shotCount ? "继续制作" : "进入本集"}<span>→</span></Link>
                      </article>
                    );
                  })}
                </div>
              </details>
            );
          })}
        </div>
      </section>
      </div>
    </AppChrome>
  );
}
