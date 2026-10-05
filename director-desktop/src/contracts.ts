import type { AssetRef, Job, Media, Model, PreparedPackage, Unit, Workspace } from './types';

function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function strings(value: unknown): string[] | undefined { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined; }

export function normalizeJob(job: Job): Job {
  const snapshot = object(job.snapshot), prepared = object(job.prepared), result = object(job.result);
  return {
    ...job,
    model: job.model || (snapshot?.model as string | undefined),
    unitId: job.unitId || (job.kind === 'video' ? String(job.entityId || '') : undefined),
    assetId: job.assetId || (job.kind === 'image' ? String(job.entityId || '') : undefined),
    resultMediaIds: job.resultMediaIds || strings(result?.mediaIds),
    estimate: job.estimate ?? prepared?.estimatedCost,
    actualCost: job.actualCost ?? result?.actualCost,
  };
}

export function normalizeWorkspace(workspace: Workspace): Workspace {
  const assets = workspace.assets || [], media = (workspace.media || []).map(item => ({ ...item, adopted: item.adopted || assets.some(asset => asset.adoptedMediaId === item.id) }));
  const units = (workspace.units || []).map(unit => ({ ...unit, prompt: typeof unit.prompt === 'string' ? unit.prompt : '', assetRefs: (unit.assetRefs || []).map(reference => ({ ...reference, role: reference.role || reference.use || reference.usage || 'reference' })) }));
  return { ...workspace, assets, media, units, jobs: (workspace.jobs || []).map(normalizeJob), settings: workspace.settings || {}, providers: workspace.providers || [], rules: workspace.rules || [] };
}

export function packageEstimate(unit: Unit): unknown { return unit.preparedPackage?.estimatedCost ?? unit.preparedPackage?.estimate; }
export function packageProblems(unit: Unit): unknown[] { return [...(unit.problems || []), ...(unit.preparedPackage?.problems || [])]; }
export type VideoParameters = { ratio: string; resolution: string };
function compiledPrompt(unit: Unit, pkg: PreparedPackage): string {
  let prompt = unit.prompt; const counts = { image: 0, video: 0, audio: 0 };
  for (const reference of pkg.references || []) { const kind = reference.kind === 'video' ? 'video' : reference.kind === 'audio' ? 'audio' : 'image'; counts[kind]++; const marker = '@' + ({ image: '图片', video: '视频', audio: '音频' }[kind]) + counts[kind]; prompt = prompt.split('{{asset:' + (reference.assetId || '') + ':' + (reference.variantId || '') + '}}').join(marker); }
  return prompt;
}
export function packageDifferences(unit: Unit, provider: string, model: string, parameters?: VideoParameters): string[] {
  const pkg = unit.preparedPackage; if (!pkg) return [];
  const issues: string[] = [];
  if (pkg.provider !== provider || pkg.model !== model) issues.push('当前渠道或模型与冻结素材包不同，请重新准备。');
  if (pkg.unitVersion !== unit.version) issues.push('单元版本与冻结素材包不同，请重新准备。');
  if (!pkg.ratio || parameters && pkg.ratio !== parameters.ratio) issues.push('当前画面比例与冻结素材包不同或未记录，请重新准备。');
  if (!pkg.resolution || parameters && pkg.resolution !== parameters.resolution) issues.push('当前视频尺寸与冻结素材包不同或未记录，请重新准备。');
  if (!Number.isFinite(pkg.duration) || Number(pkg.duration) <= 0 || pkg.duration !== (unit.duration ?? unit.durationSeconds)) issues.push('当前单元时长与冻结素材包不同或未记录，请重新准备。');
  if (!pkg.prompt?.trim() || pkg.prompt !== compiledPrompt(unit, pkg)) issues.push('当前提示词与冻结提交文本不一致，请重新准备。');
  return issues;
}
export function packageReady(unit: Unit, provider: string, model: string, parameters?: VideoParameters): boolean {
  const pkg = unit.preparedPackage;
  return !!pkg && !!model.trim() && !/stale|block|invalid|unknown/i.test(pkg.status || unit.status || '') && !packageProblems(unit).length && !packageDifferences(unit, provider, model, parameters).length;
}
export function referenceTimingProblems(workspace: Workspace, unit: Unit): string[] {
  const ids = [...new Set([...(unit.mediaRefs || []).map(reference => reference.mediaId), ...(unit.preparedPackage?.references || []).filter(reference => ['audio', 'video'].includes(reference.kind || '')).map(reference => reference.mediaId)])];
  return ids.flatMap(id => { const media = workspace.media.find(item => item.id === id); if (media && !['audio', 'video'].includes(media.kind)) return []; return media?.metadataVerified === true && Number.isFinite(media.durationSeconds) && Number(media.durationSeconds) > 0 ? [] : [(media?.name || id) + '：参考时长尚未核实，不能提交。请检查媒体探测工具后重新导入。']; });
}
export function frozenReference(pkg: PreparedPackage | null | undefined, reference: AssetRef): string | undefined { return pkg?.references?.find(item => item.assetId === reference.assetId && (item.variantId || '') === (reference.variantId || ''))?.mediaId; }
export function unitResultIds(workspace: Workspace, unit: Unit): string[] { return [...new Set([...(unit.resultMediaIds || []), ...workspace.jobs.filter(job => job.unitId === unit.id).flatMap(job => job.resultMediaIds || []), ...[unit.resultMediaId, unit.adoptedMediaId].filter((id): id is string => !!id)])]; }
export function mediaMatchesAsset(asset: Workspace['assets'][number], media: Workspace['media'][number]): boolean {
  if (media.kind !== 'image') return false;
  const linked = asset.candidates?.some(candidate => typeof candidate === 'string' ? candidate === media.id : candidate.id === media.id && (!candidate.assetId || candidate.assetId === asset.id) && (!candidate.variantId || candidate.variantId === (asset.variantId || '')));
  return linked === true || media.assetId === asset.id && (media.variantId || '') === (asset.variantId || '');
}
export function assetImages(workspace: Workspace, asset: Workspace['assets'][number]) {
  const seen = new Set<string>();
  const images = workspace.media.filter(media => {
    if (seen.has(media.id) || !mediaMatchesAsset(asset, media)) return false;
    seen.add(media.id);
    return true;
  }).sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0));
  const current = images.find(media => media.id === asset.adoptedMediaId);
  return { current, history: images.filter(media => media.id !== current?.id), images };
}
export function assetImageSelection(workspace: Workspace, asset: Workspace['assets'][number], mediaId: string) {
  if (!assetImages(workspace, asset).images.some(media => media.id === mediaId)) throw new Error('这张图片不属于当前资产形象。');
  return { assetId: asset.id, variantId: asset.variantId || '', mediaId };
}
export function moveItem<T>(items: T[], from: number, to: number): T[] { if (from < 0 || to < 0 || from >= items.length || to >= items.length) return items; const copy = [...items], [item] = copy.splice(from, 1); copy.splice(to, 0, item); return copy; }
export function workflowResult(workspace: Workspace, stages: string | string[]): Record<string, unknown> | undefined { const prefixes = Array.isArray(stages) ? stages : [stages]; return object(workspace.jobs.find(job => job.kind === 'workflow' && prefixes.some(stage => String(job.entityId || '').startsWith(stage)))?.result); }

export function imageBatchEstimate(workspace: Workspace, ids: string[], provider: string, model: Model | string | undefined) {
  const reliable = provider === 'bh' && model && typeof model === 'object' && model.kind === 'image' && model.adapted === true && ['per_image', 'per_call'].includes(String(model.billing)) && typeof model.price === 'number' && Number.isFinite(model.price) && model.price >= 0 && typeof model.currency === 'string' && !!model.currency.trim();
  const amount = reliable && typeof model === 'object' ? model.price as number : undefined, currency = reliable && typeof model === 'object' ? String(model.currency) : undefined;
  const selected = [...new Set(ids)], selectedSet = new Set(selected), extra = new Set<string>(), visited = new Set<string>(); let unresolved = false;
  function dependency(value: string, identity?: string): string | undefined { if (workspace.assets.some(asset => asset.id === value)) return value; const candidates = workspace.assets.filter(asset => asset.variantId === value), same = candidates.filter(asset => identity && asset.baseAssetId === identity), matches = same.length ? same : candidates; return matches.length === 1 ? matches[0].id : undefined; }
  function walk(id: string) { if (visited.has(id)) return; visited.add(id); const asset = workspace.assets.find(asset => asset.id === id); if (!asset) { unresolved = true; return; } const design = object(asset.design); const refs = [...(strings(design?.referenceAssetIds) || []), ...(strings(asset.referenceAssetIds) || [])]; if (typeof asset.sourceAssetId === 'string' && asset.sourceAssetId) refs.push(asset.sourceAssetId); else if (typeof asset.sourceVariantId === 'string' && asset.sourceVariantId) refs.push(asset.sourceVariantId); for (const ref of new Set(refs)) { const parent = dependency(ref, asset.baseAssetId); if (!parent || parent === id) { unresolved = true; continue; } const parentAsset = workspace.assets.find(asset => asset.id === parent); if (parentAsset?.adoptedMediaId) continue; if (!selectedSet.has(parent)) extra.add(parent); walk(parent); } }
  for (const id of selected) walk(id);
  const items = selected.map(assetId => { const asset = workspace.assets.find(asset => asset.id === assetId); return { assetId, name: asset?.name || assetId, count: 1, amount: asset ? amount : undefined }; });
  return { items, currency, selectedTotal: items.length && items.every(item => item.amount !== undefined) ? items.reduce((total, item) => total + item.amount!, 0) : undefined, dependencies: [...extra].map(id => ({ assetId: id, name: workspace.assets.find(asset => asset.id === id)?.name || id })), unresolved };
}

export function videoContainerVerified(media: Media): boolean { return media.kind === 'video' && media.metadataVerified === true && !!media.streams?.some(stream => stream.kind === 'video' && stream.attachedPicture !== true); }
export function videoAdoptionProblems(workspace: Workspace, unit: Unit, media: Media): string[] {
  const issues: string[] = [];
  if (!videoContainerVerified(media)) issues.push('视频容器与运动视频流尚未可靠核实，不能采用。请检查下载文件与媒体探测工具。');
  const jobs = workspace.jobs.filter(job => job.kind === 'video' && (job.unitId || job.entityId) === unit.id && job.resultMediaIds?.includes(media.id));
  if (!Number.isInteger(unit.version) || Number(unit.version) < 1 || !jobs.some(job => object(job.snapshot)?.unitVersion === unit.version)) issues.push('此视频未关联当前分镜版本，不能作为当前成品采用。请查看历史任务或重新生成并验收。');
  return issues;
}

export type GenerationParameters = { model: string; ratio: string; resolution: string };
const COMMON_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'];
export function generationChoices(workspace: Workspace, provider: string, kind: 'image' | 'video', parameters: GenerationParameters) {
  const providers = Array.isArray(workspace.providers) ? workspace.providers : Object.entries(workspace.providers).map(([id, item]) => ({ ...item, id }));
  const channel = providers.find(item => (item.id || item.provider) === provider);
  const models = (channel?.models || []).filter((item): item is Model => typeof item === 'object' && item.kind === kind && typeof item.id === 'string' && !!item.id);
  const selected = models.find(item => item.id === parameters.model);
  const ratios = [...new Set(strings(selected?.ratios) || [])].sort((a, b) => { const ai = COMMON_RATIOS.indexOf(a), bi = COMMON_RATIOS.indexOf(b); return (ai < 0 ? COMMON_RATIOS.length : ai) - (bi < 0 ? COMMON_RATIOS.length : bi); });
  const resolutions = [...new Set(strings(selected?.resolutions) || [])];
  const problems: string[] = [];
  if (!selected) problems.push(parameters.model ? `模型 ${parameters.model} 不在已核实的${kind === 'image' ? '图片' : '视频'}目录中，请重新选择。` : '请选择已核实的模型。');
  else if (selected.adapted !== true || selected.available === false) problems.push('当前模型尚未完成参数适配或不可用，请选择其他模型。');
  if (selected && !ratios.includes(parameters.ratio)) problems.push(ratios.length ? `比例 ${parameters.ratio || '未选择'} 不适用于当前模型，请重新选择。` : '渠道尚未提供可用比例，请先核实模型能力。');
  if (selected && !resolutions.includes(parameters.resolution)) problems.push(resolutions.length ? `尺寸 ${parameters.resolution || '未选择'} 不适用于当前模型，请重新选择。` : '渠道尚未提供可用尺寸，请先核实模型能力。');
  return { models, selected, ratios, resolutions, problems, valid: problems.length === 0 };
}
export function ratioLabel(value: string): string { const label: Record<string, string> = { '16:9': '横屏', '9:16': '竖屏', '1:1': '方形', '4:3': '横向', '3:4': '竖向', '3:2': '横向', '2:3': '竖向', '21:9': '宽银幕' }; return label[value] ? `${value} · ${label[value]}` : value; }
export function resolutionLabel(value: string, kind: 'image' | 'video'): string { const normalized = value.toLowerCase(); if (normalized === 'native') return '网页原生尺寸'; if (kind === 'image' && normalized === '1080p') return '1080P（像素尺寸）'; if (kind === 'image' && /^\d+(\.\d+)?k$/.test(normalized)) return normalized.toUpperCase(); if (/^\d+p$/.test(normalized)) return normalized.toUpperCase(); return value; }

export function storyboardRange(workspace: Workspace, selection = 'all') {
  const seen = new Set<string>();
  const episodes = (workspace.source?.episodes || []).flatMap(episode => {
    const id = episode.id;
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title: episode.title || `第 ${episode.number ?? id} 集` }];
  });
  const episodeIds = episodes.filter(episode => selection === 'all' || episode.id === selection).map(episode => episode.id);
  const problems = !workspace.source ? ['先在第一阶段导入并确认原文。'] : !episodes.length ? ['原文尚无已确认的制作集，请先在第一阶段确认集场范围。'] : !episodeIds.length ? ['所选制作集不属于当前原文，请重新选择。'] : [];
  return { episodes, episodeIds, problems, valid: problems.length === 0 };
}
