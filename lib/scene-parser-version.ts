/** Scene keys are interpreted under their saved source basis, not the newest lexer by accident. */
import type { Prisma } from '@prisma/client';
import { buildSourceIndex, isRecord, type RawSourceEpisode } from './project-foundation-contracts';
import { SCENE_PARSER_VERSION, type SceneParserVersion } from './source-parser';

const legacy: SceneParserVersion = 'SCENE_PARSER_V1';
type Db = Pick<Prisma.TransactionClient, 'sceneSnapshot'>;

export async function readSceneParserVersions(projectId: string, db: Db, episodes: readonly RawSourceEpisode[]): Promise<Record<number, SceneParserVersion>> {
  const row = await db.sceneSnapshot.findFirst({ where: { projectId, sceneKey: 'FOUNDATION_SOURCE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!row) return Object.fromEntries(episodes.map(episode => [episode.number, SCENE_PARSER_VERSION]));
  let source: unknown;
  try { source = JSON.parse(row.content); } catch { throw new Error('已保存的场次来源索引损坏，不能猜测解析版本。'); }
  if (!isRecord(source)) throw new Error('已保存的场次来源索引无效，不能猜测解析版本。');
  if (source.sceneParserVersions !== undefined && !isRecord(source.sceneParserVersions)) throw new Error('已保存的场次解析版本无效。');
  const versions = isRecord(source.sceneParserVersions) ? source.sceneParserVersions : {};
  const oldIndex = isRecord(source.sourceIndex) && Array.isArray(source.sourceIndex.episodes) ? source.sourceIndex.episodes.filter(isRecord) : [];
  const sameWholeSource = source.sourceVersion === buildSourceIndex(episodes).version;
  return Object.fromEntries(episodes.map(episode => {
    const previous = oldIndex.find(item => item.number === episode.number);
    const stillBound = previous ? previous.content === episode.content : sameWholeSource;
    if (!stillBound) return [episode.number, SCENE_PARSER_VERSION];
    const version = Object.hasOwn(versions, String(episode.number)) ? versions[String(episode.number)] : legacy;
    if (version !== 'SCENE_PARSER_V1' && version !== 'SCENE_PARSER_V2') throw new Error(`第${episode.number}集的场次解析版本不受支持。`);
    return [episode.number, version];
  }));
}
