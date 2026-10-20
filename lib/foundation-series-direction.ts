/** Direction is a side result of the existing Q1 read, never a new paid stage. */
import { createHash } from 'node:crypto';
import { createSeriesDirectionDraft, previewSeriesDirectionBrief, type SeriesDirectionContent, type SeriesSourceContext } from './series-direction';
import { buildNumberedSource, isRecord, type SourceIndex } from './project-foundation-contracts';
import { fragmentSource, type FoundationFragment } from './foundation-fragments';
import { assertSystemPresentationEvidence, SYSTEM_PRESENTATION_OUTPUT_SCHEMA } from './system-presentation';

export const FOUNDATION_DIRECTION_VERSION = 'FOUNDATION_DIRECTION_READING_V1';
export type DirectionRange = { episode: number; start: number; end: number };
export type DirectionSignal = { episode: number; quote: string; reading: string };
export type DirectionSystemEvidence = { episode: number; identity: string; evidenceId: string; quote: string };
export type FoundationDirectionReceipt = {
  schema: 'FOUNDATION_DIRECTION_RECEIPT_V1'; sourceVersion: string; foundationSourceVersion: string;
  runId: string; pointerToken: string; ranges: DirectionRange[]; backgroundKeys: string[];
  mode: 'COLLECT' | 'FINAL'; signals: DirectionSignal[]; content: SeriesDirectionContent | null; issue: string | null;
  systemEvidence?: DirectionSystemEvidence[];
};
export type FoundationDirectionBasis = {
  source: SeriesSourceContext; foundationSourceVersion: string; pointerToken: string;
  episodes: Array<{ id: string; number: number; title: string | null; content: string }>;
  background: Array<{ key: string; text: string }>; receipts: FoundationDirectionReceipt[];
  enabled: boolean; blocker: string | null;
};
export type FoundationDirectionRequest = {
  version: typeof FOUNDATION_DIRECTION_VERSION; mode: 'COLLECT' | 'FINAL';
  priorSignals: Array<{ episodes: number[]; signals: DirectionSignal[] }>;
  background?: Array<[string, string]>;
  systemSourceAnchors?: Array<[number, string]>;
  priorSystemEvidence?: DirectionSystemEvidence[];
};
export type FoundationDirectionWork = {
  request: FoundationDirectionRequest; basis: FoundationDirectionBasis; ranges: DirectionRange[]; backgroundKeys: string[]; source: ReturnType<typeof buildNumberedSource>;
};
export const directionDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const compatible = (basis: FoundationDirectionBasis) => basis.receipts.filter(receipt => receipt.sourceVersion === basis.source.sourceVersion
  && receipt.foundationSourceVersion === basis.foundationSourceVersion);
function covers(ranges: DirectionRange[], episode: { number: number; content: string }) {
  let end = 0;
  for (const range of ranges.filter(row => row.episode === episode.number).sort((a, b) => a.start - b.start)) {
    if (range.start > end) return false;
    end = Math.max(end, range.end);
  }
  return end >= episode.content.length;
}
export function foundationDirectionCoverage(basis: FoundationDirectionBasis, ranges: DirectionRange[] = [], backgroundKeys: string[] = []) {
  const receipts = compatible(basis).filter(row => !row.issue);
  const allRanges = [...receipts.flatMap(row => row.ranges), ...ranges];
  const backgrounds = new Set([...receipts.flatMap(row => row.backgroundKeys), ...backgroundKeys]);
  const covered = basis.episodes.filter(episode => covers(allRanges, episode));
  return { coveredEpisodes: covered.filter(episode => basis.source.episodeIds.includes(episode.id)).length,
    complete: covered.length === basis.episodes.length && basis.background.every(part => backgrounds.has(part.key)) };
}
/** Prior signals are sent once, to the final existing read. No growing history in each part. */
export function prepareFoundationDirectionWork(basis: FoundationDirectionBasis | null, index: SourceIndex, scope: number[], fragment?: FoundationFragment): FoundationDirectionWork | null {
  if (!basis?.enabled || basis.blocker || index.version !== basis.foundationSourceVersion) return null;
  const ranges = fragment ? [{ episode: fragment.episode, start: fragment.start, end: fragment.end }]
    : index.episodes.filter(episode => scope.includes(episode.number)).map(episode => ({ episode: episode.number, start: 0, end: episode.content.length }));
  const receipts = compatible(basis).filter(row => !row.issue);
  if (ranges.every(range => receipts.some(row => row.ranges.some(old => old.episode === range.episode && old.start <= range.start && old.end >= range.end)))) return null;
  // Do not let a huge author appendix turn a small catalogue read into an oversized paid job.
  if (basis.background.reduce((sum, part) => sum + part.text.length, 0) > 6000) return null;
  const final = foundationDirectionCoverage(basis, ranges, basis.background.map(part => part.key)).complete;
  // Calls are ephemeral: a first-batch author appendix is not memory for the final decision.
  // Supply it once at synthesis; ordinary asset facts remain available in every relevant batch.
  const background = final ? basis.background : [];
  const backgroundKeys = background.map(part => part.key);
  const priorSignals = final ? receipts.filter(row => row.signals.length).map(row => ({ episodes: [...new Set(row.ranges.map(range => range.episode))], signals: row.signals })) : [];
  const priorSystemEvidence = final ? [...new Map(receipts.flatMap(row => row.systemEvidence ?? []).map(ref => [JSON.stringify(ref), ref])).values()] : [];
  // Fail visibly rather than silently truncate evidence or purchase an extra synthesis call.
  if (JSON.stringify({ priorSignals, priorSystemEvidence }).length > 10000) return null;
  return { basis, ranges, backgroundKeys, source: fragment ? fragmentSource(index, fragment) : buildNumberedSource(index, scope), request: { version: FOUNDATION_DIRECTION_VERSION, mode: final ? 'FINAL' : 'COLLECT', priorSignals,
    ...(background.length ? { background: background.map(part => [part.key, part.text]) } : {}),
    systemSourceAnchors: basis.episodes.filter(episode => final || scope.includes(episode.number)).map(episode => [episode.number, `episode:${episode.id}`]),
    ...(priorSystemEvidence.length ? { priorSystemEvidence } : {}) } };
}

/** Independent optional-output boundary: a bad direction never invalidates correct asset edits. */
export function readFoundationDirectionReceipt(work: FoundationDirectionWork, index: SourceIndex, value: unknown, runId: string): FoundationDirectionReceipt {
  const receipt: FoundationDirectionReceipt = { schema: 'FOUNDATION_DIRECTION_RECEIPT_V1', sourceVersion: work.basis.source.sourceVersion,
    foundationSourceVersion: index.version, runId, pointerToken: work.basis.pointerToken, ranges: work.ranges, backgroundKeys: work.backgroundKeys,
    mode: work.request.mode, signals: [], content: null, issue: null };
  try {
    if (!isRecord(value)) throw new Error('本次资料回包未提供方向材料；正确资料已保存，不自动重读原稿。');
    if (work.request.mode === 'FINAL') {
      const card = createSeriesDirectionDraft({ id: `series-direction:${work.basis.source.projectId}`, revision: 1, sourceVersion: work.basis.source.sourceVersion,
        content: value.content as SeriesDirectionContent, reviewedEpisodeIds: work.basis.source.episodeIds, evidenceRefs: work.basis.source.evidenceIds }, work.basis.source);
      if (!card.content.primaryTone || !card.content.audiencePromise || !card.content.episodeFlexibility) throw new Error('方向候选缺少主调、观众体验或单集弹性。');
      previewSeriesDirectionBrief(card);
      assertSystemPresentationEvidence(card.content.systemPresentation, [...work.basis.episodes.map(episode => ({ evidenceId: `episode:${episode.id}`, text: episode.content })),
        ...work.basis.background.map(part => ({ evidenceId: part.key, text: part.text }))]);
      receipt.content = card.content;
    } else {
      if (!Array.isArray(value.signals) || !value.signals.length || value.signals.length > 3) throw new Error('分批方向依据须有1–3条，不生产逐集剧情复述。');
      receipt.signals = value.signals.map(signal => {
        if (!isRecord(signal) || !Number.isSafeInteger(signal.episode) || typeof signal.quote !== 'string' || !signal.quote.trim()
          || Array.from(signal.quote).length > 100 || typeof signal.reading !== 'string' || !signal.reading.trim() || /[\r\n]/.test(signal.reading) || Array.from(signal.reading).length > 120) throw new Error('方向依据的引文或简短判断格式不正确。');
        const text = work.source.episodes.find(episode => episode.number === signal.episode)?.lines.map(line => line[1]).join('');
        if (!text?.includes(signal.quote)) throw new Error('方向依据不在本次实际提供的原文片段中；未提升为事实。');
        return { episode: signal.episode as number, quote: signal.quote, reading: signal.reading };
      });
      if (value.systemEvidence !== undefined) {
        if (!Array.isArray(value.systemEvidence) || value.systemEvidence.length > 8) throw new Error('系统依据格式无效；未追加读取。');
        const refs = value.systemEvidence.map(ref => {
          if (!isRecord(ref) || typeof ref.identity !== 'string' || !ref.identity.trim() || ref.identity !== ref.identity.trim() || /[\r\n\u0000-\u001f]/.test(ref.identity) || [...ref.identity].length > 80
            || typeof ref.quote !== 'string' || !ref.quote.trim() || [...ref.quote].length > 240) throw new Error('系统依据须保留身份与逐字短引。');
          const sourceEpisode = work.source.episodes.find(episode => episode.number === ref.episode);
          const episode = work.basis.episodes.find(episode => episode.number === ref.episode);
          if (!episode || !sourceEpisode?.lines.map(line => line[1]).join('').includes(ref.quote)) throw new Error('系统依据不在本次真实源片段中。');
          return { episode: episode.number, identity: ref.identity, evidenceId: `episode:${episode.id}`, quote: ref.quote };
        });
        if (refs.length) receipt.systemEvidence = refs;
      }
    }
  } catch (error) { receipt.issue = (error as { code?: string }).code?.startsWith('DIRECTION_')
    ? '方向候选未满足精简接收格式；正确资料已保存，不自动重读原稿。' : error instanceof Error ? error.message : '方向材料需要补充核对；未追加模型调用。'; }
  return receipt;
}

export const FOUNDATION_DIRECTION_CONTENT_SCHEMA = {
  settingTags: ['有据世界/时代，最多3项，每项24字；无据[]'], mechanismTags: ['有据机制，最多3项，每项24字；角色说法非世界规则'],
  arcTags: ['持续主线，最多3项，每项24字；不泄露未来身份或事件'], primaryTone: '全剧稳定主调，30字内；不是当前场情绪',
  secondaryTones: ['最多2项，每项24字'], audiencePromise: '观众持续期待的情绪回报，100字内',
  expressionRules: ['最多3条，每条70字内；不规定逐镜表演/机位'], avoidances: ['最多3条，每条50字内'],
  episodeFlexibility: '单集可有悲伤/悬疑/低谷等起伏，事实和揭示时点优先，100字内',
  expressionPreferences: { emotion: 'NATURAL|STRONG|HEIGHTENED|null，自然有层次/强烈鲜明/高幅夸张', camera: 'BALANCED|DYNAMIC_FAST|null，动静有别/快速有冲击', fantasy: 'RESTRAINED|BALANCED|RICH|null，少量精准/适度择优/丰富大胆', rationale: '结合全剧反差、对白气质和情绪走势说明建议与边界，140字内；无据null。仅候选，用户确认后采用，不开启幻想开关。' },
  systemPresentation: SYSTEM_PRESENTATION_OUTPUT_SCHEMA,
};
