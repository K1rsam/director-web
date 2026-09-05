import Link from "next/link";
import { notFound } from "next/navigation";
import { confirmAllAssetsAction, startProjectFoundationAction } from "@/app/actions";
import { getD1 } from "@/db";
import { getProjectStudio } from "@/lib/studio";
import { listPresentationContracts } from "@/lib/repositories/project-studio";
import { deriveProjectGuidance } from "@/lib/ui-guidance";
import { AppChrome } from "@/app/ui/app-chrome";
import { WorkflowGuidance } from "@/app/ui/workflow-guidance";
import { AssetExportButton, AssetIndexTabs } from "./asset-index-tabs";
import { FoundationActions } from "./foundation-actions";
import { ProjectBibleViewer } from "./project-bible-viewer";
import { SceneStructureTable } from "./scene-structure-table";
import { PresentationContracts } from "./presentation-contracts";
import { ModeSwitch } from "../../mode-switch";
import { requireSessionUser } from "@/lib/auth";
import { resolvePresentationContractScope } from "@/lib/presentation-contracts";
import { FoundationReferenceGrid } from "./foundation-reference-grid";
import "@/app/page-surfaces.css";
import "@/app/workbench-refinement.css";

export const dynamic = "force-dynamic";

export default async function ProjectStudioPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const currentUser = await requireSessionUser(`/projects/${projectId}`);
  const studio = await getProjectStudio(projectId, currentUser.id);
  if (!studio) notFound();

  const foundationRuns = studio.projectRuns
    .filter((run) => run.stageCode === "P1" || run.stageCode === "P2")
    .map((run) => ({ stageCode: run.stageCode, status: run.status, model: run.model, duration: run.duration, error: run.error }));
  const activeFoundationRun = foundationRuns.find((run) => run.status === "进行中" || run.status === "排队中");
  const foundationActive = Boolean(activeFoundationRun);
  const foundationReady = (["P1", "P2"] as const).every((stageCode) => foundationRuns.some((run) => run.stageCode === stageCode && run.status === "已完成"));
  const activeFoundationStage = activeFoundationRun?.stageCode;
  const foundationStatusLabel = activeFoundationRun?.status === "排队中"
    ? `${activeFoundationStage ?? "P1"} 排队中`
    : activeFoundationStage
      ? `正在运行 ${activeFoundationStage}`
      : "正在整理 P1–P2";

  const { pending: contracts, confirmed: confirmedContracts } = await listPresentationContracts(getD1(), projectId);

  const productionEpisodes = studio.episodes.filter((episode) => episode.number >= 1);
  const formalEpisodeNumbers = productionEpisodes.map((episode) => episode.number);
  const contractRow = (contract: (typeof contracts)[number]) => {
    const scope = resolvePresentationContractScope({
      scope_mode: contract.scopeMode,
      target_episode_numbers: contract.targetEpisodeNumbers,
      source_episode_number: contract.sourceEpisodeNumber
    }, formalEpisodeNumbers);
    return {
      id: contract.id,
      category: contract.category,
      question: contract.question,
      options: contract.options,
      evidence: contract.evidence,
      userAnswer: contract.userAnswer,
      sourceEpisodeNumber: contract.sourceEpisodeNumber,
      episodeNumbers: scope.episodeNumbers,
      scopeMode: scope.mode,
      round: contract.round,
      decidedAt: contract.decidedAt
    };
  };

  const episodeStates = productionEpisodes.map((episode) => {
    const running = episode.roles.some((role) => role.status === "进行中");
    const failed = episode.roles.some((role) => role.status === "失败");
    const finished = episode.roles.length === 6 && episode.roles.every((role) => role.status === "已完成");
    return {
      id: episode.id,
      number: episode.number,
      title: episode.title,
      shotCount: episode.shotCount,
      running,
      failed,
      finished,
      state: failed ? "需处理" : running ? "生成中" : finished ? "已完成" : episode.shotCount ? "待继续" : "未开始"
    };
  });
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
  episodeGroups.sort((left, right) => left.start - right.start);
  const guidance = deriveProjectGuidance({
    pendingContracts: contracts.length,
    planningReady: studio.firstPhase.planningReady,
    assetsReady: studio.firstPhase.assetsReady,
    foundationActive,
    foundationReady,
    episodes: episodeStates
  });
  const guidanceHref = guidance.kind === "contracts"
    ? "#presentation-contracts"
    : guidance.kind === "foundation"
      ? "#foundation-actions"
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

  return (
    <AppChrome
      title={studio.project.title}
      eyebrow="全剧工作台"
      projectId={projectId}
      activeSection="project"
      episodes={episodeStates.map(({ id, number, title, state }) => ({ id, number, title, state }))}
      primaryAction={guidance.kind === "foundation" ? (
        <form action={startProjectFoundationAction}>
          <input name="projectId" type="hidden" value={projectId} />
          <button type="submit" className="studioButton" data-variant="primary" disabled={foundationActive} aria-busy={foundationActive}>{foundationActive ? foundationStatusLabel : guidance.actionLabel}</button>
        </form>
      ) : topbarNextStep ? (
        <span className="topbarNextStep" aria-label={topbarNextStep}>{topbarNextStep}</span>
      ) : (
        <Link href={guidanceHref} className="topbarPrimary">{guidance.actionLabel}</Link>
      )}
      utility={<><div className="projectTopbarMeta" aria-label={`视觉风格 ${studio.project.style}，画幅 ${studio.project.aspectRatio}，${productionEpisodes.length} 集`}><span>{studio.project.style}</span><span>{studio.project.aspectRatio}</span><span>{productionEpisodes.length} 集</span></div><ModeSwitch projectId={studio.project.id} current={studio.project.executionMode} compact /><span className="topbarStatus"><i className={foundationActive ? "live" : ""} />{foundationActive ? foundationStatusLabel : "工作台已就绪"}</span></>}
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
          foundationReady={foundationReady}
          runs={foundationRuns}
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
                <AssetExportButton projectTitle={studio.project.title} assets={studio.assets.map((asset) => ({
                  id: asset.id,
                  code: asset.code,
                  type: asset.type,
                  name: asset.name,
                  status: asset.status,
                  parentId: asset.parentId,
                  role: asset.role,
                  episodeNumber: asset.episodeNumber,
                  sourceText: asset.sourceText,
                  notes: asset.notes
                }))} />
                <form action={confirmAllAssetsAction}>
                  <input name="projectId" type="hidden" value={studio.project.id} />
                  <button type="submit" className="quietButton">全部确认</button>
                </form>
              </div>
            </div>
            <AssetIndexTabs assets={studio.assets.map((asset) => ({
              id: asset.id,
              code: asset.code,
              type: asset.type,
              name: asset.name,
              status: asset.status,
              parentId: asset.parentId,
              role: asset.role,
              episodeNumber: asset.episodeNumber,
              sourceText: asset.sourceText,
              notes: asset.notes
            }))} />
          </article>
        </FoundationReferenceGrid>

        <SceneStructureTable scenes={studio.episodes.flatMap((episode) => episode.scenes.map((scene) => ({
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

        <div className="episodeStudioGroups">
          {episodeGroups.map((group, groupIndex) => (
            <details className="episodeStudioGroup" key={group.start} open={groupIndex === 0}>
              <summary>
                <span>第{group.start}–{group.episodes.at(-1)?.number}集</span>
                <em>{group.episodes.filter((episode) => episode.shotCount > 0).length}/{group.episodes.length} 集已开始</em>
              </summary>
              <div className="episodeStudioList">
                {group.episodes.map((episode) => {
                  const episodeState = episodeStates.find((item) => item.id === episode.id)!;
                  const { running, failed, finished, state: status } = episodeState;
                  const statusClass = finished ? "ok" : failed ? "bad" : running ? "live" : "";
                  return (
                    <article key={episode.id}>
                      <div className="episodeNumber">{String(episode.number).padStart(2, "0")}</div>
                      <div className="episodeSummary">
                        <div><h3>{episode.title}</h3><span className={"stateDot " + statusClass}>{status}</span></div>
                        <p>{episode.contentPreview}</p>
                      </div>
                      <div className="episodeCounts" aria-label={episode.scenes.length + " 场，" + episode.shotCount + " 镜号，" + (episode.unitCount ? episode.unitCount + " 单元" : "尚未生成")}>
                        <span><b>{episode.scenes.length}</b><small>场</small></span>
                        <span><b>{episode.shotCount}</b><small>镜号</small></span>
                        <span>{episode.unitCount ? <><b>{episode.unitCount}</b><small>单元</small></> : <b className="countMuted">尚未生成</b>}</span>
                      </div>
                      <Link href={"/projects/" + studio.project.id + "/episodes/" + episode.id} className="primaryLink">{episode.shotCount ? "继续制作" : "进入本集"}<span>→</span></Link>
                    </article>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      </section>
      </div>
    </AppChrome>
  );
}
