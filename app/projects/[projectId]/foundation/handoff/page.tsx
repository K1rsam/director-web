import { AppChrome } from '@/app/ui/app-chrome';
import { requireProjectAccess, requireSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readProductionEpisodeHandoff } from '@/lib/episode-upstream-material';
import {readProductionScope,isProductionEpisodeNumber} from '@/lib/production-episodes';
import { resolveLightAsset, type LightEpisodePacket } from '@/lib/light-foundation-supply';
import type { Preparation } from '@/lib/foundation-production-contracts';
import { episodePresentation } from '@/lib/episode-presentation';
import { compactSourceDisplay } from '@/lib/source-display';

export const dynamic = 'force-dynamic';

function preparationText(preparation?: Preparation) {
  const labels = { REFERENCE: '独立参考图', DERIVE: '基于已有素材派生', INLINE: '镜内描述，不单独出图', AUDIO: '仅声音，不出图', UNRESOLVED: '待完善' };
  return `${preparation ? labels[preparation.mode] : '待完善'}${preparation?.note ? `：${preparation.note}` : ''}`;
}
function sourceName(packet: LightEpisodePacket, preparation?: Preparation) {
  return preparation?.fromKey ? resolveLightAsset(packet, preparation.fromKey)?.name ?? '来源尚未定位' : '—';
}

export default async function FoundationHandoffPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams?: Promise<{ episode?: string | string[] }>;
}) {
  const { projectId } = await params, returnTo = `/projects/${encodeURIComponent(projectId)}/foundation/handoff`;
  await requireSessionUser(returnTo);
  await requireProjectAccess(projectId, returnTo);
  const scope=await readProductionScope(projectId);
  const episodes = (await prisma.episode.findMany({ where: { projectId }, orderBy: { number: 'asc' }, select: { number: true, title: true } })).filter(episode=>isProductionEpisodeNumber(episode.number,scope));
  const value = (await searchParams)?.episode;
  const episodeNumber = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const selected = episodeNumber !== null && episodes.some(episode => episode.number === episodeNumber);
  let result:Awaited<ReturnType<typeof readProductionEpisodeHandoff>>|null=null,readError='';
  if(selected)try{result=await readProductionEpisodeHandoff(projectId,episodeNumber!);}catch(error){readError=(error as {code?:string})?.code==='UPSTREAM_CHANGED'?(error as Error).message:'交接资料暂时无法读取，已有原件和成果保留，请稍后刷新。';}
  const packet = result?.packet;
  const message = value === undefined ? '请选择要预览的一集。' : episodeNumber === null ? '无效的集号，请重新选择。' : '交接集号不存在，请重新选择。';

  return <AppChrome title="分镜输入检查" eyebrow="P4 · 自动按集交接" projectId={projectId} activeSection="project"
    utility={<a className="quietButton" href={`/projects/${encodeURIComponent(projectId)}`}>返回全剧资料</a>}>
    <div className="projectDashboard">
      <section className="studioSection">
        <div className="sectionHeading"><div><h1>分镜输入检查</h1></div><p>交接由系统自动完成；本页仅供按需检查，不是进入第三阶段的必经步骤。查看不会启动图片、分镜或视频制作。</p></div>
        <form method="get" action={returnTo}>
          <label htmlFor="handoff-episode">选择集号 </label>
          <select id="handoff-episode" name="episode" defaultValue={selected ? String(episodeNumber) : ''} required>
            <option value="" disabled>请选择一集</option>
            {episodes.map(episode => <option key={episode.number} value={episode.number}>{episodePresentation(episode.number, episode.title).fullTitle}</option>)}
          </select> <button type="submit" className="quietButton">查看资料</button>
        </form>
        {!packet ? <p role={readError?'alert':'status'} className="biblePlaceholder">{readError||message}</p> : <>
          <p role="status">第{packet.episode}集 · {result!.readiness === 'READY' ? '本集资料可读取' : '局部待完善，已有资料仍可读取'}。这不是制图许可、审批或成片验收。</p>
          <p>本集摘要：{packet.scenes.length} 场 · {packet.assets.length} 项基础素材 · {packet.followUps.length} 条后续提醒。完整原文、事实和素材明细可按需展开。</p>
          {result!.reasons.length ? <ul>{result!.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
          {packet.warnings.length ? <div role="note"><p>来源读取提示</p><ul>{packet.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div> : null}
          <p>资料修订 {packet.documentRevision} · <a href={returnTo+'/download?episode='+packet.episode+'&revision='+packet.documentRevision+'&materialVersion='+result!.materialVersion}>下载本集交接包</a></p>
          <details className="bibleSection"><summary className="bibleSectionHead">全剧方向与已采用设计</summary><div className="bibleBody">
            <p>全剧方向：{packet.upstream.seriesDirection.status==='CONFIRMED'?'已确认':packet.upstream.seriesDirection.status==='STALE'?'来源已变，未投递旧方向':'未定稿，未投递方向'}</p>
            {packet.upstream.seriesDirection.projection?<p style={{whiteSpace:'pre-wrap'}}>{packet.upstream.seriesDirection.projection.brief}</p>:null}
            <a href={`/projects/${projectId}/preparation#series-direction`}>核对全剧方向</a>
            {packet.upstream.assetDesigns.length?<ul>{packet.upstream.assetDesigns.map(design=><li key={design.assetKey}>
              <strong>{resolveLightAsset(packet,design.assetKey)?.name??design.assetKey}</strong> · {({TEXT_ADOPTED:'文字设计已采用',REFERENCE_ADOPTED:'参考设计已采用',UNADOPTED:'未采用，不投递设计',STALE:'待更新，不投递旧设计'})[design.status]}
              {design.brief?<p>{design.brief}</p>:null}
              {design.references.length?<p>参考说明：{design.references.map(ref=>`${ref.description||'未填写说明'}（${ref.available?'文件可用':'文件不可用'}）`).join('；')}。未读取图片像素。</p>:null}
            </li>)}</ul>:<p>本集暂无已登记的设计材料。可先做原文分镜，不把缺图误报为已完成。</p>}
            <p>{packet.upstream.policy}</p>
          </div></details>
          <details className="bibleSection"><summary className="bibleSectionHead">必要事实与跨集状态</summary><div className="bibleBody"><p>身份、状态与素材准备分开；以下是原文依据，未知解除时间不自动解释为永久持续。</p>{packet.facts.background.map(fact=><p key={fact.id}>{fact.statement}<small> · 作者资料出处 {fact.evidence.sectionKey} · {fact.evidence.start}–{fact.evidence.end}</small></p>)}{packet.facts.historicalStates.map(fact=><p key={fact.id}>{fact.statement}<small> · 第{fact.evidence.episode}集 · {fact.evidence.start}–{fact.evidence.end} · 当前适用性待结合本集核对</small></p>)}{packet.facts.current.length?<details><summary>本集身份与事实定位（原文在下方只提供一次）</summary><ul>{packet.facts.current.map(fact=><li key={fact.id}>{fact.subjects.join('、')||'未明确对象'} · {fact.kind} · 原文位置 {fact.evidence.start}–{fact.evidence.end}</li>)}</ul></details>:<p>当前没有可确定的额外事实标签，仍以本集完整原文为准。</p>}{packet.facts.unlinkedBackgroundCount?<p>另有 {packet.facts.unlinkedBackgroundCount} 条作者资料尚未建立对象关联；在接收与清洗页可回查。</p>:null}</div></details>
          <details className="bibleSection"><summary className="bibleSectionHead">本集原文</summary><div className="bibleBody"><p>阅读区隐藏空白行；下载的交接包保留原文排版。</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{compactSourceDisplay(packet.sourceText)}</pre></div></details>
          <details className="bibleSection"><summary className="bibleSectionHead">逐场基础与变体</summary>
            {packet.scenes.length ? packet.scenes.map(scene => <div className="bibleBody" key={scene.sceneKey}>
              <h3>{scene.heading || scene.sceneKey}</h3>
              <p>{[scene.location, scene.timeOfDay, scene.interiorExterior, scene.weather].filter(Boolean).join(' · ')}{scene.characters.length ? ` · 人物：${scene.characters.join('、')}` : ''}</p>
              {scene.assetKeys.length ? <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', minWidth: 720, tableLayout: 'fixed', textAlign: 'left' }}>
                <colgroup><col style={{ width: '10%' }} /><col style={{ width: '25%' }} /><col style={{ width: '47%' }} /><col style={{ width: '18%' }} /></colgroup>
                <thead><tr><th scope="col">基础／变体</th><th scope="col">身份</th><th scope="col">准备方式</th><th scope="col">派生来源</th></tr></thead>
                <tbody>{scene.assetKeys.map(key => { const asset = resolveLightAsset(packet, key); return <tr key={key}>
                  <td>{asset?.kind === 'BASE' ? '基础' : asset?.kind === 'VARIANT' ? '变体' : '未定位'}</td><th scope="row">{asset?.name ?? key}</th>
                  <td>{preparationText(asset?.preparation)}</td><td>{sourceName(packet, asset?.preparation)}</td>
                </tr>; })}</tbody>
              </table></div> : <p>本场资产尚未定位。</p>}
            </div>) : <p className="bibleBody">本集场次资料尚待整理；原文已保留。</p>}
          </details>
          {packet.materialDependencies.length ? <details className="bibleSection"><summary className="bibleSectionHead">必要素材来源</summary>
            <div className="bibleBody"><p>以下仅供派生素材引用，不代表本集出场或状态继承。</p>
              <ul>{packet.materialDependencies.map(item => <li key={item.key}>{item.name} · {preparationText(item.preparation)}{item.preparation?.fromKey ? ` · 来源：${sourceName(packet, item.preparation)}` : ''}</li>)}</ul>
            </div>
          </details> : null}
          <details className="bibleSection"><summary className="bibleSectionHead">前场事实</summary><div className="bibleBody">
            <p>仅作衔接线索；服装、伤势、站位等必须结合本集原文重新判断，不默认跨集永久继承。</p>
            {packet.boundaryContext ? <>
              <p>第{packet.boundaryContext.previousSource.episode}集 · {packet.boundaryContext.previousSource.sceneKey ?? '末场待定位'}{packet.boundaryContext.previousSource.clipped ? ' · 已截取，非完整前场' : ''}</p>
              {packet.boundaryContext.gaps.length ? <ul>{packet.boundaryContext.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul> : null}
              {packet.boundaryContext.previousSource.text ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{compactSourceDisplay(packet.boundaryContext.previousSource.text)}</pre> : null}
              {packet.boundaryContext.priorStates.length ? <ul>{packet.boundaryContext.priorStates.map(state => <li key={state.assetKey}>{state.name} · {preparationText(state.preparation)}
                {state.variants.length ? `；前场状态：${state.variants.map(variant => `${variant.name}${variant.note ? `（${variant.note}）` : ''}`).join('、')}` : ''}</li>)}</ul> : null}
            </> : <p>没有更早的已提供集可作前场依据。</p>}
          </div></details>
          <details className="bibleSection"><summary className="bibleSectionHead">后续提醒</summary><div className="bibleBody">
            {packet.followUps.length ? <ul>{packet.followUps.map(todo => <li key={todo.id}>{todo.note}</li>)}</ul> : <p>暂无已记录的后续提醒。</p>}
          </div></details>
        </>}
      </section>
    </div>
  </AppChrome>;
}
