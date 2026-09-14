import type { FoundationIssue, SourceIndex } from './project-foundation-contracts';
import type { ProductionAsset } from './foundation-production-contracts';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numeric = (value: string) => /^\d+$/.test(value) ? Number(value) : ({ 零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10 } as Record<string,number>)[value];
/** Detect an assertion, not a mention of an audio-only option. Structured AUDIO
 * is checked separately and cannot be cancelled by explanatory prose. */
export function hasAffirmativeAudioOnlyDeclaration(clause:string):boolean {
 const declaration=/不安排实体入镜|(?:仅|只|只有|纯)(?:为|有|保留|使用|采用|安排)?(?:声音|声源|画外音|VO\b|OS\b|AUDIO\b)|(?:无|没有)实体(?:出场|入镜)|(?:audio|voice)[ -]?only/gi;
 for(const fragment of clause.split(/[，,；;。\n]|但是|但|然而/))for(const match of fragment.matchAll(declaration)) {
  const prefix=fragment.slice(0,match.index);
  // Negation, warnings and contingent future changes do not assert absence.
  if(/不|未|非|避免|禁止|拒绝|尚待|待核|呈现待核|\b(?:not|never|avoid)\b/i.test(prefix))continue;
  if(/(?:如果|假如|除非|若|核对后|确认后|满足.*后|才可|可改为|可以改为)/.test(prefix))continue;
  if(/[“「"']/.test(prefix)||/[”」"']/.test(fragment.slice(match.index!+match[0].length)))continue;
  return true;
 }
 return false;
}
/** Narrow contradiction detector, not a visibility classifier. Never creates a body or an asset. */
export function collectPhysicalEvidenceIssues(assets: readonly ProductionAsset[], index: SourceIndex): FoundationIssue[] {
  const issues: FoundationIssue[] = [];
  for (const asset of assets) {
    if (!['CH','GROUP','BEAST'].includes(asset.type)) continue;
    const names = [...new Set([asset.name.split(/[｜|]/)[0], ...asset.aliases].filter(name=>name.length>=2))];
    const excluded = new Set<number>();
    if(asset.preparation?.mode==='AUDIO')asset.usageEpisodes.forEach(n=>excluded.add(n));
    for(const clause of (asset.preparation?.note??'').split(/[；;。\n]/)) {
      if(asset.preparation?.mode==='UNRESOLVED'||!hasAffirmativeAudioOnlyDeclaration(clause))continue;
      const mentions=[...clause.matchAll(/第([零一二三四五六七八九十\d]+)集/g)].map(m=>numeric(m[1])).filter(Number.isFinite);
      (mentions.length?mentions:asset.usageEpisodes).forEach(n=>excluded.add(n));
    }
    for(const episode of index.episodes) {
      if(!excluded.has(episode.number))continue;
      const lines=episode.content.split(/\r\n|\r|\n/);
      lines.forEach((line,i)=>{
        // Dialogue, recollection and hypothetical wording do not establish physical interaction.
        const clauses=line.split(/[。！？!?；;]/).filter(clause=>!/[：:]/.test(clause)&&!/想起|回忆|梦见|梦到|假如|如果|打算|准备|计划|没有|并未|未曾|没把|不会/.test(clause));
        const evidence=clauses.find(clause=>names.some(name=>{
          const n=escape(name);
          return new RegExp(`(?:把|将)[^，,。！？!?；;]{1,32}(?:交给|递给|交还|递还|递到)${n}(?=$|[，,\s的手怀])`).test(clause)
            || new RegExp(`${n}(?:把|将)[^，,。！？!?；;]{1,32}(?:交给|递给|交还|递还)`).test(clause)
            || new RegExp(`${n}(?:接过|接住|拿起|握住)[^，,。！？!?；;]{1,20}`).test(clause);
        }));
        if(evidence)issues.push({severity:'BLOCKER',owner:'PROGRAM',coordinate:`assets.${asset.key}.preparation`,
          problem:`第${episode.number}集第${i+1}行存在${asset.name}的明确实体交互，与纯声音/不安排实体入镜声明冲突；须局部核对场内呈现，不能仅凭VO/OS判定缺席，也不自动补造身体入镜。依据：${evidence.trim()}`,
          sourceRefs:[{episode:episode.number,startLine:i+1,endLine:i+1}]});
      });
    }
  }
  return issues;
}
