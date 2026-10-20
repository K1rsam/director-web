/** Client-safe direction choices. A carrier preference grants no new story-world ability. */
export const SYSTEM_PRESENTATION_MODES = {
  HUD: '信息面板／HUD', SPRITE: '精灵／角色化身', VOICE_ONLY: '纯声音／无实体',
  SYMBOLIC: '象征道具／环境', MIXED: '混合表现', CUSTOM: '自定义', PRESERVE_SOURCE: '保持原文',
} as const;
export const SYSTEM_PRESENTATION_HINTS: Record<keyof typeof SYSTEM_PRESENTATION_MODES, string> = {
  HUD: '原提示出现时展开简洁界面，信息随原事件更新/收起；主角反应按源，可见域单独核对，不新增数值、奖励或旁人读屏。',
  SPRITE: '原提示出现时以稳定化身探头或悬停，承载同一提示与可读态度；不把系统音改成嘴部对白，不新增人物互动、接触或能力。',
  VOICE_ONLY: '保留同一原声提示，以主角已有的眼神/动作停点表现接收；不强建图片，也不抹去源已有的屏幕或实体。',
  SYMBOLIC: '同一提示由光纹、器物界面或局部环境视觉承载；主角按源反应，不将视觉化变成真实变物、可触道具或旁人知情。',
  MIXED: '日常同一提示用简洁声画，必要时才出现选定化身；在出现规则中写明各形态触发、切换与退出，身份/外形保持连续。',
  CUSTOM: '在出现规则中写清本剧如何承载同一提示及人物反应；身份、原声、知情/接触权限与时点仍由原文限定。',
  PRESERVE_SOURCE: '沿本剧已有提示、载体、原声及人物反应；未知保留待核对，不自动补面板、精灵或新台词。',
};
export const SYSTEM_PRESENTATION_BOUNDARIES = {
  visibility: { SOURCE_ONLY: '沿原文可见性', AUDIENCE_ONLY: '新增载体仅观众可见', UNRESOLVED: '待核对，不新增可见性' },
  audibility: { SOURCE_ONLY: '保留原文声源与听者', NO_ADDED_SOUND: '不添加载体声音', UNRESOLVED: '待核对，不新增可听性' },
  contact: { SOURCE_ONLY: '仅原文已有接触', NO_ADDED_CONTACT: '不添加实体接触', UNRESOLVED: '待核对，不新增接触' },
  screenText: { SOURCE_ONLY: '仅源内面板文字；额外叠字另行许可', NO_ADDED_TEXT: '不新增额外屏字（源面板照留）' },
} as const;
export type SystemPresentationMode = keyof typeof SYSTEM_PRESENTATION_MODES;
export type SystemSourceEvidence = { evidenceId: string; quote: string };
export type SystemPresentationChoice = {
  id: string; identity: string; mode: SystemPresentationMode; carrierNotes: string | null;
  sourceEvidence: SystemSourceEvidence[];
  sourceCarrier: (SystemSourceEvidence & { mode: Exclude<SystemPresentationMode, 'PRESERVE_SOURCE'> }) | null;
  visibility: keyof typeof SYSTEM_PRESENTATION_BOUNDARIES.visibility;
  audibility: keyof typeof SYSTEM_PRESENTATION_BOUNDARIES.audibility;
  contact: keyof typeof SYSTEM_PRESENTATION_BOUNDARIES.contact;
  originalVoice: 'PRESERVE_SOURCE'; screenText: keyof typeof SYSTEM_PRESENTATION_BOUNDARIES.screenText;
  rationale: string | null;
  options?: Array<{ mode: SystemPresentationMode; description: string }>;
};
export type SystemPresentation = { systems: SystemPresentationChoice[] };
const fail = (code = 'DIRECTION_SYSTEM_PRESENTATION'): never => { throw Object.assign(new Error(code), { code }); };
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(row, key))) return fail();
  return row;
}
function text(value: unknown, max: number, quote = false): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || [...value].length > max || (quote ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f]/ : /[\r\n\u0000-\u001f]/).test(value)) return fail();
  return value;
}
function option<T extends Record<string, string>>(value: unknown, options: T): keyof T {
  if (typeof value !== 'string' || !Object.hasOwn(options, value)) return fail();
  return value;
}
function evidence(value: unknown, ids?: string[]): SystemSourceEvidence {
  const row = object(value, ['evidenceId', 'quote']);
  const result = { evidenceId: text(row.evidenceId, 200), quote: text(row.quote, 240, true) };
  if (ids && !ids.includes(result.evidenceId)) return fail('DIRECTION_SYSTEM_EVIDENCE');
  return result;
}
export function readSystemPresentation(value: unknown, evidenceIds?: string[]): SystemPresentation {
  const row = object(value, ['systems']);
  if (!Array.isArray(row.systems) || !row.systems.length || row.systems.length > 8) return fail();
  const systems = row.systems.map(value => {
    const item = object(value, ['id', 'identity', 'mode', 'carrierNotes', 'sourceEvidence', 'sourceCarrier', 'visibility', 'audibility', 'contact', 'originalVoice', 'screenText', 'rationale'], ['options']);
    if (!Array.isArray(item.sourceEvidence) || !item.sourceEvidence.length || item.sourceEvidence.length > 4 || item.originalVoice !== 'PRESERVE_SOURCE') return fail();
    const sourceEvidence = item.sourceEvidence.map(ref => evidence(ref, evidenceIds));
    if (new Set(sourceEvidence.map(ref => JSON.stringify(ref))).size !== sourceEvidence.length) return fail();
    const mode = option(item.mode, SYSTEM_PRESENTATION_MODES);
    let sourceCarrier: SystemPresentationChoice['sourceCarrier'] = null;
    if (item.sourceCarrier !== null) {
      const carrier = object(item.sourceCarrier, ['mode', 'evidenceId', 'quote']);
      const sourceMode = option(carrier.mode, SYSTEM_PRESENTATION_MODES);
      if (sourceMode === 'PRESERVE_SOURCE') return fail();
      sourceCarrier = { mode: sourceMode, ...evidence({ evidenceId: carrier.evidenceId, quote: carrier.quote }, evidenceIds) };
      if (mode !== 'PRESERVE_SOURCE' && mode !== sourceMode) return fail('DIRECTION_SYSTEM_SOURCE_CONFLICT');
    }
    let options: SystemPresentationChoice['options'];
    if (Object.hasOwn(item, 'options')) {
      if (!Array.isArray(item.options) || !item.options.length || item.options.length > 7) return fail();
      options = item.options.map(raw => { const optionRow = object(raw, ['mode', 'description']); return { mode: option(optionRow.mode, SYSTEM_PRESENTATION_MODES), description: text(optionRow.description, 180) }; });
      if (new Set(options.map(row => row.mode)).size !== options.length) return fail();
    }
    return { id: text(item.id, 80), identity: text(item.identity, 80), mode, carrierNotes: item.carrierNotes === null ? null : text(item.carrierNotes, 180), sourceEvidence, sourceCarrier,
      visibility: option(item.visibility, SYSTEM_PRESENTATION_BOUNDARIES.visibility), audibility: option(item.audibility, SYSTEM_PRESENTATION_BOUNDARIES.audibility),
      contact: option(item.contact, SYSTEM_PRESENTATION_BOUNDARIES.contact), originalVoice: 'PRESERVE_SOURCE' as const,
      screenText: option(item.screenText, SYSTEM_PRESENTATION_BOUNDARIES.screenText), rationale: item.rationale === null ? null : text(item.rationale, 140), ...(options ? { options } : {}) };
  });
  if (new Set(systems.map(item => item.id)).size !== systems.length || new Set(systems.map(item => item.identity)).size !== systems.length) return fail();
  return { systems };
}

/** Exact source anchors are verified; their interpretation still requires source-first review. */
export function assertSystemPresentationEvidence(value: SystemPresentation | undefined, units: Array<{ evidenceId: string; text: string }>) {
  if (!value) return;
  const texts = new Map(units.map(unit => [unit.evidenceId, unit.text]));
  for (const system of value.systems) for (const ref of [...system.sourceEvidence, ...(system.sourceCarrier ? [system.sourceCarrier] : [])]) {
    if (!texts.get(ref.evidenceId)?.includes(ref.quote)) fail('DIRECTION_SYSTEM_EVIDENCE');
  }
}
export const SYSTEM_PRESENTATION_POLICY = '原文明确的系统身份、实体、外观、声源、固定事实及揭示时点优先；载体偏好与引用解释都不能改写原文，未登记sourceCarrier不证明原文无实体，须按当集源文核对。逐身份匹配，不把一个系统的权限用于另一个；历史引用不证明当集出场，仅当当集原文对应此身份时采用，不给无关集新增系统镜头。精灵出镜仅是载体选择，不授权新剧情、新台词、他人看见/听见/触碰、物理能力或额外屏字；原有系统音不改成画内嘴部对白，不强加人物voiceBindings，原声/原话/声窗按源保留。必要提示、原载体与原声不因额外幻想off或叠字关闭消失；额外视觉化服从取消/off/待审及不得新增载体等既有限制，实质冲突只提最小待确认项，不暗开开关。剧情内系统面板文字依源保留，额外叠字仍须独立许可，不虚构证据或新增实体。';

/** Background quotes inform project design; only introduced episode identities reach episode authoring. */
export function projectSystemPresentation(value: SystemPresentation, episodeIds: string[], episodeId?: string) {
  const position = episodeId === undefined ? Infinity : episodeIds.indexOf(episodeId);
  const timed = (ref: SystemSourceEvidence) => {
    const id = ref.evidenceId.startsWith('episode:') ? ref.evidenceId.slice(8) : ref.evidenceId;
    const sourcePosition = episodeIds.indexOf(id);
    if (episodeId !== undefined && (sourcePosition < 0 || sourcePosition > position)) return null;
    return { ...ref, episodeId: sourcePosition < 0 ? null : id, timing: sourcePosition < 0 ? 'AUTHOR_BACKGROUND' as const : sourcePosition === position ? 'CURRENT_EPISODE_EVIDENCE' as const : 'PRIOR_EVIDENCE' as const };
  };
  const systems = value.systems.flatMap(({ rationale: _rationale, options: _options, sourceEvidence, sourceCarrier, ...system }) => {
    const refs = sourceEvidence.map(timed).filter((ref): ref is NonNullable<typeof ref> => ref !== null);
    if (!refs.length) return [];
    const carrier = sourceCarrier ? timed(sourceCarrier) : null;
    return [{ ...system, sourceEvidence: refs, sourceCarrier: carrier && sourceCarrier ? { ...carrier, mode: sourceCarrier.mode } : null,
      sourceCarrierStatus: carrier ? 'EXPLICIT_SOURCE_QUOTE' as const : 'UNRESOLVED_SOURCE_FIRST' as const }];
  });
  return { schemaVersion: 'SYSTEM_PRESENTATION_V1' as const, systems, policy: SYSTEM_PRESENTATION_POLICY };
}

export function newSystemPresentationChoice(id: string): SystemPresentationChoice {
  return { id, identity: '', mode: 'PRESERVE_SOURCE', carrierNotes: null, sourceEvidence: [], sourceCarrier: null,
    visibility: 'UNRESOLVED', audibility: 'SOURCE_ONLY', contact: 'NO_ADDED_CONTACT', originalVoice: 'PRESERVE_SOURCE', screenText: 'NO_ADDED_TEXT', rationale: null };
}

export const SYSTEM_PRESENTATION_OUTPUT_SCHEMA = { systems: [{
  id: '稳定的逐系统身份键，80字内；同系统面板/化身不拆身份', identity: '真实叙事系统名称/别名，80字内',
  mode: '原文明示载体且无真实冲突时PRESERVE_SOURCE直接沿用；未定部分才建议HUD|SPRITE|VOICE_ONLY|SYMBOLIC|MIXED|CUSTOM，不强制重复选择', carrierNotes: '本剧具体轮廓/尺度/出现退出、同一原提示与按源人物反应；混合须写切换，180字内或null',
  sourceEvidence: [{ evidenceId: 'systemSourceAnchors给出的真实id', quote: '该来源逐字提示/固定事实，240字内；每系统1-4处，不是解释' }],
  sourceCarrier: '原文明确载体/外观时填{mode(除PRESERVE_SOURCE),evidenceId,quote}；不明确null，不把未描述当没有实体，所选模式不与明确源载体相斥',
  visibility: 'SOURCE_ONLY|AUDIENCE_ONLY|UNRESOLVED', audibility: 'SOURCE_ONLY|NO_ADDED_SOUND|UNRESOLVED', contact: 'SOURCE_ONLY|NO_ADDED_CONTACT|UNRESOLVED',
  originalVoice: 'PRESERVE_SOURCE', screenText: 'SOURCE_ONLY|NO_ADDED_TEXT', rationale: '原文明示时如实记原文明示，直接沿用及范围/边界；未定才写建议理由，140字内或null；沿用不伪记用户逐项确认',
  options: [{ mode: '可选保留2-3个有区别的适合方案；源互斥方案不列为普通选项；不适用可省略整个options', description: '本剧该系统怎样出现、承载同一真实源提示与人物反应及限制，180字内；选择时作为carrierNotes采用，不要只有名称或泛化优点' }],
}] };
export const SYSTEM_PRESENTATION_GUIDANCE = '仅确有剧情系统时可选附systemPresentation，多个身份分别有据记录；无系统/资料不足省略，不新设。参考source及priorSystemEvidence，用systemSourceAnchors绑定真实引用；早批摘录是出处，不证明当前出场或完整设定。先核原文明示：已明确载体/外观且无真实冲突时登记sourceCarrier，mode用PRESERVE_SOURCE直接沿用，rationale如实记原文明示，直接沿用及真实依据/范围/已知显隐声道；省略options，不为源已定形式重复提问或伪记用户逐项确认。原文未定、实质冲突或用户明确改编时才就该范围提出本剧具体载体、同一原提示、人物接收反应和边界；仅系统/叮/系统音不证明视觉已定，未知sourceCarrier保留null。询问当前形式先解释实际采用与边界，不自动重开菜单；既有整体方向确认保留，旧有效决定继承，真实冲突只问最小缺项。化身不改系统声道、不加嘴部对白/人物voiceBindings，不给他人可见听触或新能力。纯声不强建图；原声/原载体/必要提示不因幻想off消失；额外视觉化仍服从既有取消/off/待审，剧情内系统面板文字依源保留，额外叠字须独立文字许可。方向候选仍不自动采用，不追加调用或改资产权限。';
