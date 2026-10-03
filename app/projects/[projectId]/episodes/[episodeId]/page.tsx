import Link from "next/link";
import { episodePresentation } from "@/lib/episode-presentation";
import { WorkbenchEmpty } from "@/app/ui/workbench-empty";
import { notFound } from "next/navigation";
import { getEpisodeStudio } from "@/lib/studio";
import { formatDialogueEntries } from "@/lib/shot-cells";
import { AppChrome } from "@/app/ui/app-chrome";
import { MotionSelection } from "@/app/ui/motion-selection";
import { UnitPromptCard } from "./unit-prompt-card";
import { ExportEpisodeButtons } from "./export-episode";
import { WorkspaceGrid } from "./workspace-grid";
import { requireSessionUser } from "@/lib/auth";
import { isProductionEpisodeNumber, readProductionScope } from "@/lib/production-episodes";

export const dynamic = "force-dynamic";

export default async function EpisodeStudioPage({
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
  const productionScope = await readProductionScope(projectId);
  const productionEpisodes = studio.episodeNav.filter(episode => isProductionEpisodeNumber(episode.number, productionScope));
  const productionEligible = isProductionEpisodeNumber(studio.episode.number, productionScope);
  const shotCount = studio.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);

  return (
    <AppChrome
      title={episodePresentation(studio.episode.number, studio.episode.title).fullTitle}
      eyebrow={studio.project.title}
      projectId={projectId}
      projectLabel={studio.project.title}
      activeSection="episode"
      activeEpisodeId={episodeId}
      episodes={productionEpisodes.map((episode) => ({ id: episode.id, number: episode.number, title: episode.title, state: episode.status, productionEligible: true }))}
      utility={<>
        {productionEligible ? <Link className="quietButton" href={`/projects/${projectId}/episodes/${episodeId}/storyboard`}>进入第三阶段 · 新版分镜</Link> : null}
        <span className="episodeTopbarMeta"><span>{studio.project.style}</span><span>{studio.project.aspectRatio}</span><span>{shotCount} 镜</span><span>{studio.units.length} 单元</span></span>
        <span className="topbarStatus">历史记录 · 只读</span>
      </>}
    >
      <div className="episodeWorkspace episodeDashboard episodeSurface">
      <p className="biblePlaceholder">旧版 E0–E5 历史只读，保留正文、版本、问题和导出；新制作请进入第三阶段。</p>

      <WorkspaceGrid
        canvas={(
          <section className={`storyboardCanvas episodeReadingCanvas ${view === "units" ? "is-units" : ""}`} aria-label="本集制作内容">
          <div className="canvasToolbar">
            <MotionSelection className="viewTabs" label="分集视图" group="episode-views" activeKey={view}>
              <Link className={view === "shots" ? "active" : ""} aria-current={view === "shots" ? "page" : undefined} href={`?view=shots`}>分镜表 <b>{shotCount}</b></Link>
              <Link className={view === "units" ? "active" : ""} aria-current={view === "units" ? "page" : undefined} href={`?view=units`}>Seedance单元 <b>{studio.units.length}</b></Link>
              <Link className={view === "logs" ? "active" : ""} aria-current={view === "logs" ? "page" : undefined} href={`?view=logs`}>执行与问题 <b>{studio.issues.filter((issue) => issue.status === "OPEN").length}</b></Link>
            </MotionSelection>
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
                      <td className="cellClamp" title={shot.dialogue.length ? formatDialogueEntries(shot.dialogue) : "—"}><div className="cellText dialogueCellText">{shot.dialogue.length ? formatDialogueEntries(shot.dialogue) : "—"}</div></td>
                      <td className="cellClamp" title={shot.transition}><div className="cellText">{shot.transition || "—"}</div></td>
                      <td><span className="revisionTag" title={shot.revision}>{shot.revision.split("_")[0]}</span></td>
                    </tr>
                  )))}
                  {!studio.scenes.some((scene) => scene.shots.length) ? (
                    <tr><td colSpan={9} className="emptyTableCell"><WorkbenchEmpty kind="shots" title="此历史版本未保存分镜" description="新制作请使用顶部的第三阶段入口；这里不继续旧版任务。" /></td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {view === "units" ? (
            <div className="unitList">
              {studio.units.length ? (
                <ExportEpisodeButtons
                  episodeTitle={episodePresentation(studio.episode.number, studio.episode.title).fullTitle}
                  units={studio.units
                    .map((unit) => ({ unitKey: unit.unitKey, content: unit.versions[0]?.content ?? "" }))
                    .filter((unit) => Boolean(unit.content))}
                />
              ) : null}
              {studio.units.map((unit) => {
                const currentVersion = unit.versions[0];
                return (
                  <article className="unitCard episodeUnitDocument" key={unit.id} aria-labelledby={`unit-heading-${unit.id}`}>
                    <header className="unitCardHead episodeUnitIndex">
                      <span className="episodeUnitEyebrow">生成单元</span>
                      <h3 id={`unit-heading-${unit.id}`}>{unit.unitKey}</h3>
                      <div className="episodeUnitDuration"><strong>{unit.duration.toFixed(1)}</strong><span>秒</span></div>
                      <span className="episodeUnitShots">{unit.shotKeys.length} 个镜头</span>
                      <em title={unit.revision}>{unit.revision}</em>
                    </header>
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
                        pipelineActive={false}
                      readOnly
                      />
                    ) : (
                      <div className="unitGuide">
                        <h3>本单元提示词未编译</h3>
                        <p>此历史版本未保存可复制的提示词；旧引擎不会继续编译，新制作请使用第三阶段。</p>
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
                <WorkbenchEmpty kind="units" title="此历史版本未保存单元" description="新制作请使用顶部的第三阶段入口；这里不继续旧版任务。" />
              ) : null}
            </div>
          ) : null}

          {view === "logs" ? (
            <div className="logView">
              <section><div className="cardHeader"><div><span>PIPELINE RUNS</span><h3>执行记录</h3></div><em>{studio.runs.length}条</em></div>
                <div className="logEntries">{studio.runs.length ? studio.runs.map((run) => <article className="logRow" key={run.id}><b>{run.stageCode}</b><div><strong>{run.roleName}</strong><small>{run.provider} · {run.model} · {run.duration}</small></div><span>{run.status}</span><details><summary>查看输入、输出与执行日志</summary><h4>输入摘要</h4><pre>{run.inputSummary ?? "暂无"}</pre><h4>岗位输出</h4><pre>{run.outputSummary ?? "暂无"}</pre><h4>用户提示</h4><pre>{run.error ?? "无错误"}</pre><h4>技术执行日志</h4><pre>{run.log ?? "暂无"}</pre></details></article>) : <WorkbenchEmpty kind="logs" title="此历史版本未保存执行记录" description="新版第三阶段的执行记录在对应任务中查看。" />}</div>
              </section>
              <section><div className="cardHeader"><div><span>ISSUES</span><h3>问题与修订</h3></div><em>全部 {studio.issues.length} · 未解决 {studio.issues.filter((issue) => issue.status === "OPEN").length}</em></div>
                <div className="issueEntries">{studio.issues.length ? (
                  <>
                    <div className="issueFilters">
                      <Link className={issues === "open" ? "active" : ""} href={`?view=logs&issues=open`}>未解决 <b>{studio.issues.filter((issue) => issue.status === "OPEN").length}</b></Link>
                      <Link className={issues === "all" ? "active" : ""} href={`?view=logs&issues=all`}>全部 <b>{studio.issues.length}</b></Link>
                    </div>
                    {(() => {
                      const visible = studio.issues.filter((issue) => issues === "all" || issue.status === "OPEN");
                      const blockers = visible.filter((issue) => issue.severity === "BLOCKER");
                      const suggestions = visible.filter((issue) => issue.severity !== "BLOCKER");
                      const renderRow = (issue: (typeof studio.issues)[number]) => (
                        <article className={`issueRow ${issue.status === "OPEN" ? "issueOpen" : issue.status === "EXCEPTED" ? "issueExcepted" : "issueResolved"}`} key={issue.id}>
                          <div><span>{issue.severity}</span><span className={`issueStatus ${issue.status === "OPEN" ? "open" : issue.status === "EXCEPTED" ? "excepted" : "resolved"}`}>{issue.status === "OPEN" ? "OPEN" : issue.status === "EXCEPTED" ? "已豁免" : "已解决"}</span><b>{issue.coordinate}</b><em>归属 {issue.ownerRole}</em>
                            {issue.status === "OPEN" && ["E1", "E2", "E3", "E4"].includes(issue.ownerRole) ? (
                              <em className="issueOwnerBadge">历史归属保留</em>
                            ) : null}
                          </div>
                          <p>{issue.evidence}</p>
                          <small>要求：{issue.requestedEffect}</small>
                        </article>
                      );
                      return (
                        <>
                          {blockers.length > 0 ? (
                            <section className="issueGroup">
                              <h4 className="issueGroupTitle issueGroupBlockers">历史严重问题 · {blockers.length} 条</h4>
                              {blockers.map(renderRow)}
                            </section>
                          ) : null}
                          {suggestions.length > 0 ? (
                            <section className="issueGroup">
                              <div className="issueGroupHead">
                                <h4 className="issueGroupTitle issueGroupSuggestions">历史建议 · {suggestions.length} 条</h4>
                              </div>
                              {suggestions.map(renderRow)}
                            </section>
                          ) : null}
                          {visible.length === 0 ? <WorkbenchEmpty kind="issues" title="当前没有待处理问题" description="可切换到全部，查看此前的问题与处理记录。" /> : null}
                        </>
                      );
                    })()}
                  </>
                ) : <WorkbenchEmpty kind="issues" title={studio.runs.length ? "暂无问题记录" : "问题记录等待制作开始"} description={studio.runs.length ? "后续审查发现的问题会集中在这里，方便逐项定位与处理。" : "制作与审查产生的问题会集中在这里，尚未开始审查。"} />}
                {studio.issues.some((issue) => issue.status === "OPEN") ? <p className="issueRepairHint">历史问题和原处理结果均保留；这里不执行旧版返修，不影响新版第三阶段的任务。</p> : studio.units.length > 0 && studio.units.every((unit) => unit.versions[0]?.syncStatus === "RELEASE_COMPILED") ? <p className="issueRepairHint">当前单元已通过审查并放行。</p> : null}</div>
              </section>
            </div>
          ) : null}
        </section>
        )}
        episodeLabel={`${studio.project.title} / 第 ${studio.episode.number} 集`}
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
