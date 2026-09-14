/** Explicit mutation permissions; identity/range fields and destructive operations are excluded. */
export const CHOICE_ASSET_FIELDS = ['name', 'type', 'role', 'relationNote', 'aliases', 'sceneRefs', 'preparation', 'variants'] as const;
export const CHOICE_SCENE_FIELDS = ['location', 'timeOfDay', 'interiorExterior', 'timeLayer', 'weather', 'characters'] as const;
export type ChoiceChangeTargets = { assetKeys: string[]; assetFields: (typeof CHOICE_ASSET_FIELDS)[number][]; sceneFields: (typeof CHOICE_SCENE_FIELDS)[number][] };

export function readChoiceChangeTargets(value: unknown): ChoiceChangeTargets | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('changeTargets: 须为明确的局部修改权限对象');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['assetKeys', 'assetFields', 'sceneFields'].includes(key))) throw new Error('changeTargets: 不接受删除、归并、拆场或未知权限字段');
  const list = (key: string, allowed?: readonly string[]) => {
    if (!Array.isArray(row[key]) || row[key].some(item => typeof item !== 'string' || !item.trim() || allowed && !allowed.includes(item))) throw new Error(`changeTargets.${key}: 须为有效的明确字段或资产键数组`);
    return [...new Set((row[key] as string[]).map(item => item.trim()))].sort();
  };
  const assetKeys = list('assetKeys'), assetFields = list('assetFields', CHOICE_ASSET_FIELDS), sceneFields = list('sceneFields', CHOICE_SCENE_FIELDS);
  if (Boolean(assetKeys.length) !== Boolean(assetFields.length)) throw new Error('changeTargets: 资产键与资产字段须同时提供；场次专用事项两者均为空');
  if (!assetFields.length && !sceneFields.length) throw new Error('changeTargets: 至少明确一种可修改字段');
  return { assetKeys, assetFields, sceneFields } as ChoiceChangeTargets;
}

/** Missing legacy permissions and explicit permissions are never interchangeable consent. */
export const changeTargetsIdentity = (value: unknown) => JSON.stringify(readChoiceChangeTargets(value) ?? null);
