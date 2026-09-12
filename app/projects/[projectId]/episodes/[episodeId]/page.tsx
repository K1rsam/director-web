import Link from "next/link";
import { notFound } from "next/navigation";
import { prepareEpisodeAction, repairOpenIssuesAction, runSingleStageAction, resetEpisodeShotsAction, stopPipelineAction, acknowledgeIssueAction, acknowledgeAllSuggestionsAction } from "@/app/actions";
import { getEpisodeStudio } from "@/lib/studio";
import { formatDialogueEntry } from "@/lib/shot-cells";
import { AppChrome } from "@/app/ui/app-chrome";
import { EpisodePipelineButton } from "./episode-pipeline-button";
import { ResetEpisodeButton } from "./reset-episode-button";
import { StopPipelineButton } from "./stop-pipeline-button";
import { ModeSwitch } from "../../../../mode-switch";
import { UnitPromptCard } from "./unit-prompt-card";
import { ExportEpisodeButtons } from "./export-episode";
import { WorkspaceGrid } from "./workspace-grid";
import { requireEpisodeAccess, requireSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function EpisodeStudioPage({
  params
}: {
  params: Promise<{ projectId: string; episodeId: string }>;
  searchParams: Promise<{ view?: string; issues?: string }>;
}) {
  const { projectId, episodeId } = await params;
  await requireEpisodeAccess(projectId, episodeId);
  return (
    <AppChrome title="后续阶段未启用" eyebrow="v0.2 第一阶段测试" projectId={projectId} activeSection="project">
      <section className="studioSection">
        <div className="sectionHeading">
          <div><h1>v0.2 后续阶段尚未启用</h1></div>
          <p>当前仅测试 P0 / F1 / F2 / Q1 与资料评审。旧生产代码及历史数据保留，本页不提供旧 E0–E5 生产入口。</p>
        </div>
        <Link href={`/projects/${encodeURIComponent(projectId)}`} className="topbarPrimary">返回第一阶段资料</Link>
      </section>
    </AppChrome>
  );
}

// 保留旧实现与历史数据，但不再映射为当前测试副本的可访问生产页面。
async function LegacyEpisodeStudioPage({
  params,
  searchParams
}: {
  params: Promise<{ projectId: string; episodeId: string }>;
  searchParams: Promise<{ view?: string; issues?: string }>;
}) {
  const { projectId, episodeId } = await params;
  const { view = "units", issues = "open" } = await searchParams;
  const currentUser = await requireSessionUser(`/projects/${projectId}/episodes/${episodeId}`);
  const studio = await getEpisodeStudio(projectId, episodeId, currentUser.id);
  if (!studio) notFound();
  const shotCount = studio.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);

  return (
    <AppChrome
      title={`第${studio.episode.number}集 · ${studio.episode.title}`}
      eyebrow={studio.project.title}
      projectId={projectId}
      activeSection="episode"
      activeEpisodeId={episodeId}
      episodes={studio.episodeNav.map((episode) => ({ id: episode.id, number: episode.number, title: episode.title, state: episode.status }))}
      utility={<>
        <ModeSwitch projectId={projectId} current={studio.project.executionMode} compact />
        <span className="episodeTopbarMeta"><span>{studio.project.style}</span><span>{studio.project.aspectRatio}</span><span>{shotCount} 镜</span><span>{studio.units.length} 单元</span></span>
        <form action={prepareEpisodeAction} className="episodeTopbarAction">
          <input name="projectId" type="hidden" value={projectId} />
          <input name="episodeId" type="hidden" value={episodeId} />
          <button type="submit" className="episodeToolButton" title="用最新项目资料更新本集上下文">更新信息包</button>
        </form>
        <form action={resetEpisodeShotsAction} className="episodeTopbarAction">
          <input name="projectId" type="hidden" value={projectId} />
          <input name="episodeId" type="hidden" value={episodeId} />
          <ResetEpisodeButton active={studio.pipelineActive} />
        </form>
        <span className="topbarStatus"><i className={studio.pipelineActive ? "live" : ""} />{studio.pipelineActive ? "生成中" : "本集已就绪"}</span>
        <form action={stopPipelineAction} className="topbarStopForm">
          <input name="projectId" type="hidden" value={projectId} />
          <input name="episodeId" type="hidden" value={episodeId} />
          <StopPipelineButton active={studio.pipelineActive} />
        </form>
      </>}
      primaryAction={<EpisodePipelineButton
        projectId={projectId}
        episodeId={episodeId}
        active={studio.pipelineActive}
        hasContent={studio.episodeHasContent}
        released={studio.units.length > 0 && studio.units.every((unit) => unit.versions[0]?.syncStatus === "RELEASE_COMPILED")}
        activeLabel={studio.activePipeline?.label}
      />}
    >
      <div className="episodeWorkspace episodeDashboard">
      {studio.otherEpisodesRunning.length > 0 ? (
        <p className="parallelRunningHint">
          ⚠ 第 {studio.otherEpisodesRunning.join("、")} 集正在并行执行流水线（不同集可并行是设计行为，本页按钮不受影响）。
          若这不是你主动发起的，可等它们跑完后再操作。
        </p>
      ) : null}

      <details className="episodeRoleDeck" open>
        <summary><span>E0–E5 制作状态</span><b>{studio.roles.filter((role) => role.status === "已完成").length}/6 完成</b></summary>
      <section className="roleProgressRail" aria-label="岗位进度">
        {studio.roles.map((role) => {
          const errorText = studio.runs.find((run) => run.stageCode === role.code && run.error)?.error;
          const actionLabel = role.status === "已完成" ? "重跑" : role.status === "失败" ? "再试一次" : "运行";
          return (
            <form action={runSingleStageAction} className="roleStageForm" key={role.code}>
              <input name="projectId" type="hidden" value={projectId} />
              <input name="episodeId" type="hidden" value={episodeId} />
              <input name="stageCode" type="hidden" value={role.code} />
              <button
                type="submit"
                className="roleCardHitArea"
                disabled={studio.pipelineActive}
                aria-label={`${actionLabel} ${role.code} ${role.name}`}
                title={`点击整张卡片${actionLabel} ${role.code} · ${role.name}`}
              />
              <article className={`roleProgress ${role.status === "已完成" ? "done" : role.status === "进行中" ? "running" : role.status === "失败" ? "failed" : ""}`}>
                <span>{role.code}</span>
                <div><strong>{role.name}</strong><small>{role.model} · {role.duration}</small></div>
                <em>{role.status}</em>
                {role.status === "失败" && errorText ? <p className="roleRunError" title={errorText}>{errorText}</p> : null}
                <span className="roleCardAction">{role.status === "进行中" ? "执行中" : role.status === "排队中" ? "排队中" : actionLabel}</span>
              </article>
            </form>
          );
        })}
      </section>
      </details>

      <WorkspaceGrid
        canvas={(
          <section className="storyboardCanvas">
          <div className="canvasToolbar">
            <nav className="viewTabs">
              <Link className={view === "shots" ? "active" : ""} href={`?view=shots`}>分镜表 <b>{shotCount}</b></Link>
              <Link className={view === "units" ? "active" : ""} href={`?view=units`}>Seedance单元 <b>{studio.units.length}</b></Link>
              <Link className={view === "logs" ? "active" : ""} href={`?view=logs`}>执行与问题 <b>{studio.issues.filter((issue) => issue.status === "OPEN").length}</b></Link>
            </nav>
          </div>

          {view === "shots" ? (
            <div className="storyboardTableWrap">
              <table className="storyboardTable">
                <colgroup>
                  <col className="shotColKey" />
                  <col className="shotColDuration" />
                  <col className="shotColPicture" />
                  <col className="shotColCamera" />
                  <col className="shotColLighting" />
                  <col className="shotColSound" />
                  <col className="shotColDialogue" />
                  <col className="shotColTransition" />
                  <col className="shotColRevision" />
                </colgroup>
                <thead><tr><th>镜号</th><th>时长</th><th>画面</th><th>机位运镜</th><th>光影</th><th>声音</th><th>台词</th><th>转场</th><th>版本</th></tr></thead>
                <tbody>
                  {studio.scenes.flatMap((scene) => scene.shots.map((shot, index) => (
                    <tr key={shot.id}>
                      <td><strong>{shot.shotKey}</strong><small>{index === 0 ? scene.heading : scene.sceneKey}</small></td>
                      <td><b>{shot.duration.toFixed(1)}s</b></td>
                      <td className="cellClamp" title={shot.picture}><div className="cellText">{shot.picture || "—"}</div></td>
                      <td className="cellClamp" title={shot.cameraMotion}><div className="cellText">{shot.cameraMotion || "—"}</div></td>
                      <td className="cellClamp" title={shot.lighting ?? ""}><div className="cellText">{shot.lighting ?? "—"}</div></td>
                      <td className="cellClamp" title={shot.sound}><div className="cellText">{shot.sound || "—"}</div></td>
                      <td className="cellClamp" title={shot.dialogue.length ? shot.dialogue.map(formatDialogueEntry).join("；") : "—"}><div className="cellText">{shot.dialogue.length ? shot.dialogue.map(formatDialogueEntry).join("；") : "—"}</div></td>
                      <td className="cellClamp" title={shot.transition}><div className="cellText">{shot.transition || "—"}</div></td>
                      <td><span className="revisionTag" title={shot.revision}>{shot.revision.split("_")[0]}</span></td>
                    </tr>
                  )))}
                  {!studio.scenes.some((scene) => scene.shots.length) ? (
                    <tr><td colSpan={8} className="largeEmpty"><span>分镜表尚未生成</span><p>E0 先切出 Beat 骨架；E1 按 Beat 建立小镜号和时长，E2–E4 只补充各自负责的列。</p></td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {view === "units" ? (
            <div className="unitList">
              {studio.units.length ? (
                <ExportEpisodeButtons
                  episodeTitle={`第${studio.episode.number}集 · ${studio.episode.title}`}
                  units={studio.units
                    .map((unit) => ({ unitKey: unit.unitKey, content: unit.versions[0]?.content ?? "" }))
                    .filter((unit) => Boolean(unit.content))}
                />
              ) : null}
              {studio.units.map((unit) => {
                const currentVersion = unit.versions[0];
                return (
                  <article className="unitCard" key={unit.id}>
                    <div className="unitCardHead"><div><span>{unit.unitKey}</span><strong>{unit.duration.toFixed(1)}秒</strong></div><em>{unit.revision}</em></div>
                    {currentVersion ? (
                      <UnitPromptCard
                        key={currentVersion.id}
                        projectId={projectId}
                        episodeId={episodeId}
                        unitId={unit.id}
                        openIssueCount={unit.openIssueCount}
                        versions={unit.versions.map((version) => ({
                          id: version.id,
                          version: version.version,
                          content: version.content,
                          syncStatus: version.syncStatus
                        }))}
                        currentVersionId={currentVersion.id}
                        pipelineActive={studio.pipelineActive}
                      />
                    ) : (
                      <div className="unitGuide">
                        <h3>本单元提示词未编译</h3>
                        <p>E1–E4 填写分镜表后会自动编译草稿；E5 审查通过后标记为已放行。</p>
                      </div>
                    )}
                    <details className="unitInternals">
                      <summary>内部字段（剧情目标 / 镜号 / 起止状态 / 单元光影）</summary>
                      <dl><div><dt>剧情目标</dt><dd>{unit.dominantGoal}</dd></div><div><dt>包含镜号</dt><dd>{unit.shotKeys.join("、") || "待关联"}</dd></div><div><dt>开始状态</dt><dd>{unit.startPremise}</dd></div><div><dt>结束状态</dt><dd>{unit.endState}</dd></div>{unit.unitLighting ? <div><dt>单元光影</dt><dd>{unit.unitLighting}</dd></div> : null}</dl>
                    </details>
                  </article>
                );
              })}
              {!studio.units.length ? (
                <div className="unitGuide">
                  <span className="unitGuideIcon" aria-hidden="true">▶</span>
                  <h3>分镜脚本暂未生成</h3>
                  <p>点击右上角「生成本集分镜」开始 E0–E5 流水线：E0 叙事节奏导演先切出 Beat 骨架与时长预算，E1 按 Beat 拆镜，E2 表演调度，E3 单元视听，E4 摄影光影，E5 审查总控；每轮岗位跑完都会由 Python 自动编译最新提示词草稿。</p>
                  <p className="unitGuideHint">测试阶段也可直接点击上方 E0–E5 岗位卡，单独执行某一个岗位。</p>
                </div>
              ) : null}
            </div>
          ) : null}

          {view === "logs" ? (
            <div className="logView">
              <section><div className="cardHeader"><div><span>PIPELINE RUNS</span><h3>完整执行日志</h3></div><em>{studio.runs.length}条</em></div>
                {studio.runs.length ? studio.runs.map((run) => <article className="logRow" key={run.id}><b>{run.stageCode}</b><div><strong>{run.roleName}</strong><small>{run.provider} · {run.model} · {run.duration}</small></div><span>{run.status}</span><details><summary>查看输入、输出与执行日志</summary><h4>输入摘要</h4><pre>{run.inputSummary ?? "暂无"}</pre><h4>岗位输出</h4><pre>{run.outputSummary ?? "暂无"}</pre><h4>执行日志</h4><pre>{run.error ?? run.log ?? "暂无"}</pre></details></article>) : <div className="largeEmpty"><span>暂无岗位执行日志</span></div>}
              </section>
              <section><div className="cardHeader"><div><span>ISSUES</span><h3>坐标化问题与返修</h3></div><em>{studio.issues.length}条</em></div>
                {studio.issues.length ? (
                  <>
                    <div className="issueFilters">
                      <Link className={issues === "open" ? "active" : ""} href={`?view=logs&issues=open`}>未解决 <b>{studio.issues.filter((issue) => issue.status === "OPEN").length}</b></Link>
                      <Link className={issues === "all" ? "active" : ""} href={`?view=logs&issues=all`}>全部 <b>{studio.issues.length}</b></Link>
                      {studio.issues.some((issue) => issue.status === "OPEN") ? (
                        <div className="issueRerunForms">
                          <form action={repairOpenIssuesAction} className="issueRerunForm">
                            <input name="projectId" type="hidden" value={projectId} />
                            <input name="episodeId" type="hidden" value={episodeId} />
                            <button type="submit" disabled={studio.pipelineActive} title="只跑有 BLOCKER 卡的岗位（每岗一次调用带全部卡），最后 E5 复审统一销卡">修复严重问题</button>
                          </form>
                          <form action={repairOpenIssuesAction} className="issueRerunForm">
                            <input name="projectId" type="hidden" value={projectId} />
                            <input name="episodeId" type="hidden" value={episodeId} />
                            <input name="includeSuggestions" type="hidden" value="1" />
                            <button type="submit" disabled={studio.pipelineActive} title="BLOCKER 与 MAJOR 建议卡的归属岗位一起跑（每岗一次调用带全部卡），最后 E5 复审统一销卡">连建议一起修</button>
                          </form>
                          <form action={repairOpenIssuesAction} className="issueRerunForm">
                            <input name="projectId" type="hidden" value={projectId} />
                            <input name="episodeId" type="hidden" value={episodeId} />
                            <input name="includeSuggestions" type="hidden" value="1" />
                            <input name="force" type="hidden" value="1" />
                            <button type="submit" disabled={studio.pipelineActive} className="dangerQuietButton" title="绕过收敛门禁强制重跑（上一轮 BLOCKER 未减少被拒时，人工确认卡状态后使用）">强制重跑</button>
                          </form>
                        </div>
                      ) : null}
                    </div>
                    {(() => {
                      const visible = studio.issues.filter((issue) => issues === "all" || issue.status === "OPEN");
                      const blockers = visible.filter((issue) => issue.severity === "BLOCKER");
                      const suggestions = visible.filter((issue) => issue.severity !== "BLOCKER");
                      const openSuggestions = suggestions.filter((issue) => issue.status === "OPEN");
                      const renderRow = (issue: (typeof studio.issues)[number]) => (
                        <article className={`issueRow ${issue.status === "OPEN" ? "issueOpen" : issue.status === "EXCEPTED" ? "issueExcepted" : "issueResolved"}`} key={issue.id}>
                          <div><span>{issue.severity}</span><span className={`issueStatus ${issue.status === "OPEN" ? "open" : issue.status === "EXCEPTED" ? "excepted" : "resolved"}`}>{issue.status === "OPEN" ? "OPEN" : issue.status === "EXCEPTED" ? "已豁免" : "已解决"}</span><b>{issue.coordinate}</b><em>归属 {issue.ownerRole}</em>
                            {issue.status === "OPEN" && ["E1", "E2", "E3", "E4"].includes(issue.ownerRole) ? (
                              <em className="issueOwnerBadge">随修复轮处理</em>
                            ) : null}
                          </div>
                          <p>{issue.evidence}</p>
                          <small>要求：{issue.requestedEffect}</small>
                          {issue.status === "OPEN" && issue.severity !== "BLOCKER" ? (
                            <form action={acknowledgeIssueAction} className="issueAckForm">
                              <input name="projectId" type="hidden" value={projectId} />
                              <input name="episodeId" type="hidden" value={episodeId} />
                              <input name="issueId" type="hidden" value={issue.id} />
                              <button type="submit" className="quietButton" disabled={studio.pipelineActive} title="确认这条建议不需要修，豁免后不再显示为待处理">确认保留</button>
                            </form>
                          ) : null}
                        </article>
                      );
                      return (
                        <>
                          {blockers.length > 0 ? (
                            <section className="issueGroup">
                              <h4 className="issueGroupTitle issueGroupBlockers">严重（必须修，阻塞放行）· {blockers.length} 条</h4>
                              {blockers.map(renderRow)}
                            </section>
                          ) : null}
                          {suggestions.length > 0 ? (
                            <section className="issueGroup">
                              <div className="issueGroupHead">
                                <h4 className="issueGroupTitle issueGroupSuggestions">建议（不阻塞放行；可随「连建议一起修」处理，或确认保留）· {suggestions.length} 条</h4>
                                {openSuggestions.length > 0 ? (
                                  <form action={acknowledgeAllSuggestionsAction} className="issueAckForm">
                                    <input name="projectId" type="hidden" value={projectId} />
                                    <input name="episodeId" type="hidden" value={episodeId} />
                                    <button type="submit" className="quietButton" disabled={studio.pipelineActive} title="本集所有开放的建议卡一次性豁免">全部确认保留</button>
                                  </form>
                                ) : null}
                              </div>
                              {suggestions.map(renderRow)}
                            </section>
                          ) : null}
                          {visible.length === 0 ? <div className="largeEmpty"><span>暂无未解决问题</span></div> : null}
                        </>
                      );
                    })()}
                  </>
                ) : <div className="largeEmpty"><span>暂无开放问题</span><p>E5只记录能定位到单元格的真实问题。</p></div>}
                {studio.issues.some((issue) => issue.status === "OPEN") ? <p className="issueRepairHint">「修复严重问题」只跑有 BLOCKER 卡的岗位；「连建议一起修」把 MAJOR 建议卡的归属岗位也纳入（每岗一次调用带全部卡、只动命中镜号），最后 E5 复审统一销卡；不需要修的建议用「确认保留」豁免。</p> : <p className="issueRepairHint">全部问题已清理：当前表格通过 Python 硬校验与 E5 审查，单元提示词为已放行状态。</p>}
              </section>
            </div>
          ) : null}
        </section>
        )}
        content={studio.episode.content}
        scenes={studio.scenes.map((scene) => ({
          sceneKey: scene.sceneKey,
          heading: scene.heading,
          timeOfDay: scene.timeOfDay,
          interiorExterior: scene.interiorExterior,
          timeLayer: scene.timeLayer
        }))}
        assets={studio.assets.map((asset) => ({ code: asset.code, type: asset.type, name: asset.name, status: asset.status }))}
        infoPackage={studio.episode.infoPackage}
      />
      </div>
    </AppChrome>
  );
}
