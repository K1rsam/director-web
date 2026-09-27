import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {digest,fail} from './core/shared.mjs';

export function validateEpisodeSourceContext(profile,episode){
 const keys=['schemaVersion','projectId','episodeId','contentHash','title','scene','origin','contextRows','entryFacts'];
 if(!profile||Array.isArray(profile)||profile.schemaVersion!=='independent-source-context-v1'||Object.keys(profile).some(k=>!keys.includes(k))||!Array.isArray(profile.contextRows)||!Array.isArray(profile.entryFacts)||typeof profile.title!=='string'||typeof profile.scene!=='string'||!profile.origin)fail('SOURCE_CONTEXT_SCHEMA','独立片段前情格式无效；不得混入分镜答案');
 if(profile.episodeId!==episode.id||profile.projectId!==episode.projectId)fail('SOURCE_CONTEXT_BINDING','独立片段配置不属于当前项目和分集');
 if(profile.contentHash!==digest(episode.content))fail('SOURCE_CONTEXT_STALE','本集正文已改变，原独立片段前情不再适用；请核对配置，未串接旧资料');
 return profile;
}
export async function readEpisodeSourceContext(dataRoot,episode){
 if(typeof episode.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(episode.id))fail('SOURCE_CONTEXT_BINDING','分集标识无效');
 const file=path.join(dataRoot,'source-contexts',`${episode.id}.json`);
 let stat;try{stat=await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)fail('SOURCE_CONTEXT_SCHEMA','独立片段配置须为本机普通小文件');
 let value;try{value=JSON.parse(await readFile(file,'utf8'));}catch{fail('SOURCE_CONTEXT_SCHEMA','独立片段配置无法读取，未自动使用旧项目资料');}
 return validateEpisodeSourceContext(value,episode);
}
