import { AppChrome } from '@/app/ui/app-chrome';
import { requireProjectAccess, requireSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readLightEpisodeFoundation } from '@/lib/light-foundation-reader';
import { resolveLightAsset, type LightEpisodePacket } from '@/lib/light-foundation-supply';
import type { Preparation } from '@/lib/foundation-production-contracts';

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
  const episodes = await prisma.episode.findMany({ where: { projectId }, orderBy: { number: 'asc' }, select: { number: true, title: true } });
  const value = (await searchParams)?.episode;
  const episodeNumber = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const selected = episodeNumber !== null && episodes.some(episode => episode.number === episodeNumber);
  const result = selected ? await readLightEpisodeFoundation(projectId, episodeNumber!) : null;
  const packet = result?.packet;
  const message = value === undefined ? '请选择要预览的一集。' : episodeNumber === null ? '无效的集号，请重新选择。' : '交接集号不存在，请重新选择。';

  return <AppChrome title="交接资料预览" eyebrow="第一阶段 · 只读" projectId={projectId} activeSection="project"
    utility={<a className="quietButton" href={`/projects/${encodeURIComponent(projectId)}`}>返回全剧资料</a>}>
    <div className="projectDashboard">
      <section className="studioSection">
        <div className="sectionHeading"><div><h1>交接资料预览</h1></div><p>与后续读取函数使用同一份单集资料；只读，不启动图片、分镜或视频制作。</p></div>
        <form method="get" action={returnTo}>
          <label htmlFor="handoff-episode">选择集号 </label>
          <select id="handoff-episode" name="episode" defaultValue={selected ? String(episodeNumber) : ''} required>
            <option value="" disabled>请选择一集</option>
            {episodes.map(episode => <option key={episode.number} value={episode.number}>第{episode.number}集{episode.title ? ` · ${episode.title}` : ''}</option>)}
          </select> <button type="submit" className="quietButton">查看资料</button>
        </form>
        {!packet ? <p role="status" className="biblePlaceholder">{message}</p> : <>
          <p role="status">第{packet.episode}集 · {result!.readiness === 'READY' ? '本集资料可读取' : '局部待完善，已有资料仍可读取'}。这不是制图许可、审批或成片验收。</p>
          {result!.reasons.length ? <ul>{result!.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
          {packet.warnings.length ? <div role="note"><p>来源读取提示</p><ul>{packet.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div> : null}
          <section className="bibleSection"><h2 className="bibleSectionHead">本集原文</h2><pre className="bibleBody" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{packet.sourceText}</pre></section>
          <section className="bibleSection"><h2 className="bibleSectionHead">逐场基础与变体</h2>
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
          </section>
          {packet.materialDependencies.length ? <section className="bibleSection"><h2 className="bibleSectionHead">必要素材来源</h2>
            <div className="bibleBody"><p>以下仅供派生素材引用，不代表本集出场或状态继承。</p>
              <ul>{packet.materialDependencies.map(item => <li key={item.key}>{item.name} · {preparationText(item.preparation)}{item.preparation?.fromKey ? ` · 来源：${sourceName(packet, item.preparation)}` : ''}</li>)}</ul>
            </div>
          </section> : null}
          <section className="bibleSection"><h2 className="bibleSectionHead">前场事实</h2><div className="bibleBody">
            <p>仅作衔接线索；服装、伤势、站位等必须结合本集原文重新判断，不默认跨集永久继承。</p>
            {packet.boundaryContext ? <>
              <p>第{packet.boundaryContext.previousSource.episode}集 · {packet.boundaryContext.previousSource.sceneKey ?? '末场待定位'}{packet.boundaryContext.previousSource.clipped ? ' · 已截取，非完整前场' : ''}</p>
              {packet.boundaryContext.gaps.length ? <ul>{packet.boundaryContext.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul> : null}
              {packet.boundaryContext.previousSource.text ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{packet.boundaryContext.previousSource.text}</pre> : null}
              {packet.boundaryContext.priorStates.length ? <ul>{packet.boundaryContext.priorStates.map(state => <li key={state.assetKey}>{state.name} · {preparationText(state.preparation)}
                {state.variants.length ? `；前场状态：${state.variants.map(variant => `${variant.name}${variant.note ? `（${variant.note}）` : ''}`).join('、')}` : ''}</li>)}</ul> : null}
            </> : <p>没有更早的已提供集可作前场依据。</p>}
          </div></section>
          <section className="bibleSection"><h2 className="bibleSectionHead">后续提醒</h2><div className="bibleBody">
            {packet.followUps.length ? <ul>{packet.followUps.map(todo => <li key={todo.id}>{todo.note}</li>)}</ul> : <p>暂无已记录的后续提醒。</p>}
          </div></section>
        </>}
      </section>
    </div>
  </AppChrome>;
}
