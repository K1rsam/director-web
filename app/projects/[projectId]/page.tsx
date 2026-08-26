import Link from "next/link";
import { notFound } from "next/navigation";
import { confirmAllAssetsAction } from "@/app/actions";
import { getD1 } from "@/db";
import { getProjectStudio } from "@/lib/studio";
import { listPresentationContracts } from "@/lib/repositories/project-studio";
import { deriveProjectGuidance } from "@/lib/ui-guidance";
import { AppChrome } from "@/app/ui/app-chrome";
import { WorkflowGuidance } from "@/app/ui/workflow-guidance";
import { AssetIndexTabs } from "./asset-index-tabs";
import { FoundationActions } from "./foundation-actions";
import { ProjectBibleViewer } from "./project-bible-viewer";
import { SceneStructureTable } from "./scene-structure-table";
import { PresentationContracts } from "./presentation-contracts";
import { ModeSwitch } from "../../mode-switch";
import { requireSessionUser } from "@/lib/auth";

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

  const episodeStates = studio.episodes.map((episode) => {
    const running = episode.roles.some((role) => role.status === "进行中");
    const failed = episode.roles.some((role) => role.status === "失败");
    const finished = episode.roles.at(-1)?.status === "已完成";
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
    <button type="button" className="glassPrimary" disabled title="本地 Runner 执行将在下一阶段接通">
      {foundationActive ? foundationStatusLabel : guidance.actionLabel}
    </button>
  ) : null;

  return (
    <AppChrome
      title={studio.project.title}
      eyebrow="全剧工作台"
      projectId={projectId}
      activeSection="project"
      episodes={episodeStates.map(({ id, number, title, state }) => ({ id, number, title, state }))}
      primaryAction={guidance.kind === "foundation" ? (
        <button type="button" disabled title="线上展示版需要连接个人 Runner 后执行">{foundationActive ? foundationStatusLabel : guidance.actionLabel}</button>
      ) : (
        <Link href={guidanceHref} className="topbarPrimary">{guidance.actionLabel}</Link>
      )}
      utility={<><div className="projectTopbarMeta" aria-label={`视觉风格 ${studio.project.style}，画幅 ${studio.project.aspectRatio}，${studio.episodes.length} 集`}><span>{studio.project.style}</span><span>{studio.project.aspectRatio}</span><span>{studio.episodes.length} 集</span></div><ModeSwitch projectId={studio.project.id} current={studio.project.executionMode} compact /><span className="topbarStatus"><i className={foundationActive ? "live" : ""} />{foundationActive ? foundationStatusLabel : "工作台已就绪"}</span></>}
    >
      <div className="projectDashboard">
        <WorkflowGuidance
          eyebrow={guidance.eyebrow}
          title={guidance.title}
          description={guidance.description}
          href={guidanceAction ? undefined : guidanceHref}
          actionLabel={guidance.actionLabel}
          action={guidanceAction}
          meta={<><span>{studio.episodes.filter((episode) => episode.shotCount > 0).length}/{studio.episodes.length} 集已开始</span><span>{studio.assets.length} 项资产</span></>}
        />

      <section className="studioSection" id="phase-one">
        <PresentationContracts
          projectId={projectId}
          pending={contracts.map((c) => ({ id: c.id, category: c.category, question: c.question, options: c.options, evidence: c.evidence, userAnswer: c.userAnswer, episodeNumber: null, round: c.round, decidedAt: c.decidedAt }))}
          confirmed={confirmedContracts.map((c) => ({ id: c.id, category: c.category, question: c.question, options: c.options, evidence: c.evidence, userAnswer: c.userAnswer, episodeNumber: null, round: c.round, decidedAt: c.decidedAt }))}
        />
        <div className="sectionHeading">
          <div><span className="sectionIndex">01</span><h2>全剧基础工程</h2></div>
          <p>只建立服务全集的固定资料；图片资产由外部导入，当前系统只管理名称与状态。</p>
        </div>

        <FoundationActions
          projectId={studio.project.id}
          active={foundationActive}
          runs={foundationRuns}
          preprocessReady={studio.episodes.length > 0}
          validationReady={studio.firstPhase.sceneCount > 0}
        />

        <div className="studioGrid twoColumns">
          <article className="studioCard">
            <div className="cardHeader"><div><span>PROJECT BIBLE</span><h3>项目策划与全剧索引</h3></div><em>{studio.firstPhase.planningReady ? "已生成" : "未生成"}</em></div>
            <ProjectBibleViewer content={studio.firstPhase.memory} />
          </article>

          <article className="studioCard">
            <div className="cardHeader">
              <div><span>ASSET INDEX</span><h3>资产名称简表</h3></div>
              <div className="cardHeaderActions">
                <em>{studio.assets.length}项</em>
                <form action={confirmAllAssetsAction}>
                  <input name="projectId" type="hidden" value={studio.project.id} />
                  <button type="submit" className="quietButton">全部确认</button>
                </form>
              </div>
            </div>
            <AssetIndexTabs assets={studio.assets.map((asset) => ({ id: asset.id, code: asset.code, type: asset.type, name: asset.name, status: asset.status, parentId: asset.parentId, role: asset.role }))} />
          </article>
        </div>

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

      <section className="studioSection" id="phase-two">
        <div className="sectionHeading">
          <div><span className="sectionIndex">02</span><h2>单集分镜生产</h2></div>
          <p>每集独立经过 E0–E5；最终由 Python 编译为一个个可单独发送给 Seedance 的分镜单元。</p>
        </div>

        <div className="episodeStudioList">
          {studio.episodes.map((episode) => {
            const episodeState = episodeStates.find((item) => item.id === episode.id)!;
            const { running, failed, finished, state: status } = episodeState;
            return (
              <article key={episode.id}>
                <div className="episodeNumber">{String(episode.number).padStart(2, "0")}</div>
                <div className="episodeSummary">
                  <div><h3>{episode.title}</h3><span className={`stateDot ${finished ? "ok" : failed ? "bad" : running ? "live" : ""}`}>{status}</span></div>
                  <p>{episode.contentPreview}</p>
                </div>
                <div className="episodeCounts"><span><b>{episode.scenes.length}</b> 场</span><span><b>{episode.shotCount}</b> 镜号</span><span>{episode.unitCount ? <><b>{episode.unitCount}</b> 单元</> : <b className="countMuted">尚未生成</b>}</span></div>
                <Link href={`/projects/${studio.project.id}/episodes/${episode.id}`} className="primaryLink">{episode.shotCount ? "继续制作" : "进入本集"}<span>→</span></Link>
              </article>
            );
          })}
        </div>
      </section>
      </div>
    </AppChrome>
  );
}
