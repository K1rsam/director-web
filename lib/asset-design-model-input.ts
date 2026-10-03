import type {VisualFact} from './asset-visual-facts-contract';
import type {AssetDesignHandoff} from './asset-design-adoption';
import type {LightEpisodePacket} from './light-foundation-supply';
import type {AssetCandidateDesign} from './asset-material-candidates';

export type AssetProductionCard = {
  schema: 'ASSET_PRODUCTION_CARD_V1'; assetKey: string; name: string; type: string;
  use: 'ACTUAL_APPEARANCE' | 'MATERIAL_SOURCE_ONLY' | 'CANDIDATE_ONLY';
  applicable: {episode: number; sceneKeys: string[]};
  sourceFacts: {id: string; claim: 'SOURCE' | 'CHARACTER_CLAIM'; quote: string; association: 'ASSET_NAME' | 'SCENE_ACTION' | 'VISUAL_FACT'; evidence: Record<string, unknown>}[];
  adoptedDesign: {version: number | null; brief: string; provenance: 'ADOPTED_DESIGN_NOT_SOURCE_FACT'} | null;
  candidateDesign?:AssetCandidateDesign;
  candidateDesigns?:AssetCandidateDesign[];
  freeDesignScope: string; materialAvailability: 'TEXT_ONLY' | 'REFERENCE_AVAILABLE'; imageEvidence: 'NO_PIXELS_READ';
  references: AssetDesignHandoff['references'];
  materialNeeds: {kind: 'SOURCE_FUNCTION_EVIDENCE' | 'DESIGN_REVIEW' | 'REFERENCE_IMAGE'; required: false; detail: string}[];
};

/** A current quote proves only this episode's source. Future labels cannot backdate a visual fact. */
export function episodeVisualFacts(facts: VisualFact[], episode: number, sourceText: string) {
  return facts.filter(fact => {
    const sourceEpisode = fact.sourceLabel?.match(/EPISODE\s*·\s*第(\d+)集/);
    return Boolean(fact.quote.trim() && sourceText.includes(fact.quote) && (!sourceEpisode || Number(sourceEpisode[1]) === episode));
  });
}

/** Identity and evidence supply only: no generated blocking, no inherited offscreen current state. */
export function buildAssetProductionCards(packet: LightEpisodePacket, designs: AssetDesignHandoff[],candidates:({assetKey:string}&AssetCandidateDesign)[]=[]): AssetProductionCard[] {
  const identities = packet.assets.flatMap(asset => [
    {assetKey: asset.key!, name: asset.name, type: asset.type, aliases: asset.aliases??[], refs: asset.sceneRefs, use: 'ACTUAL_APPEARANCE' as const},
    ...asset.variants.map(variant => ({assetKey: variant.key!, name: variant.name, type: asset.type, aliases: [asset.name, ...asset.aliases??[]], refs: variant.sceneRefs, use: 'ACTUAL_APPEARANCE' as const})),
  ]);
  const material = packet.materialDependencies.map(asset => ({assetKey: asset.key, name: asset.name, type: asset.type, aliases: [] as string[], refs: undefined, use: 'MATERIAL_SOURCE_ONLY' as const}));
  const entries = [...identities, ...material].filter(entry => Boolean(entry.assetKey));
  return entries.map(entry => {
    const design = designs.find(item => item.assetKey === entry.assetKey);
    const candidateDesigns=candidates.filter(item=>item.assetKey===entry.assetKey).map(({assetKey:_key,...candidate})=>candidate);
    const effective = Boolean(design && ['TEXT_ADOPTED', 'REFERENCE_ADOPTED'].includes(design.status));
    const sceneKeys = [...new Set((entry.refs ?? []).filter(ref => ref.episode === packet.episode).map(ref => ref.sceneKey))];
    // Catalogue names carry look labels (e.g. 苏尘｜发白T恤), while source subjects
    // use the character identity. Reuse the source-reader convention, not AI alias guessing.
    const names = [...new Set([entry.name, ...entry.aliases].flatMap(name => [name.trim(), name.split(/[|｜]/)[0].trim()]).filter(Boolean))];
    const sourceFacts: AssetProductionCard['sourceFacts'] = [];
    if (entry.use === 'ACTUAL_APPEARANCE') for (const fact of packet.facts.sourceFactIndex ?? []) {
      const ref = fact.evidence;
      if (ref.domain !== 'EPISODE' || ref.episode !== packet.episode || ref.start < 0 || ref.end > packet.sourceText.length || fact.kind === 'FORMAT') continue;
      const quote = packet.sourceText.slice(ref.start, ref.end);
      const named = names.some(name => fact.subjects.includes(name) || name.length > 1 && quote.includes(name));
      const sceneAction = entry.type === 'LOC' && fact.claim === 'SOURCE' && packet.scenes.some(scene => sceneKeys.includes(scene.sceneKey) && ref.start >= scene.sourceRange.start && ref.end <= scene.sourceRange.end);
      if (named || sceneAction) sourceFacts.push({id: fact.id, claim: fact.claim, quote, association: named ? 'ASSET_NAME' : 'SCENE_ACTION', evidence: {...ref}});
    }
    for (const fact of episodeVisualFacts(design?.visualFacts ?? [], packet.episode, packet.sourceText)) {
      if (entry.use !== 'ACTUAL_APPEARANCE' || sourceFacts.some(item => item.quote.includes(fact.quote))) continue;
      // Keep the original quotation authoritative; extracted values are not additional facts.
      const quotedClaim=packet.facts.sourceFactIndex.some(item=>item.claim==='CHARACTER_CLAIM'&&(()=>{const text=packet.sourceText.slice(item.evidence.start,item.evidence.end).trim();return text&&(text.includes(fact.quote)||fact.quote.includes(text));})());
      sourceFacts.push({id: fact.id, claim: quotedClaim?'CHARACTER_CLAIM':'SOURCE', quote: fact.quote, association: 'VISUAL_FACT', evidence: {chunkId: fact.chunkId, startLine: fact.startLine, endLine: fact.endLine, ...(fact.sourceLabel ? {sourceLabel: fact.sourceLabel} : {})}});
    }
    const materialNeeds: AssetProductionCard['materialNeeds'] = [];
    if (!sourceFacts.length && ['LOC', 'PROP'].includes(entry.type) && entry.use === 'ACTUAL_APPEARANCE') materialNeeds.push({kind: 'SOURCE_FUNCTION_EVIDENCE', required: false, detail: '尚无已关联的本集功能依据；需要门／通路／遮挡／固定物或道具作用的原文定位时回查，不据名称补造。'});
    if (!effective) materialNeeds.push({kind: 'DESIGN_REVIEW', required: false, detail: design?.status === 'STALE' ? '旧设计待重新核对，未当作当前采用；原文文字可继续使用。' : '尚无已采用设计；以本集原文为准，非剧情补足可提案。'});
    if (!effective || design?.materialAvailability !== 'REFERENCE_AVAILABLE') materialNeeds.push({kind: 'REFERENCE_IMAGE', required: false, detail: '缺图不阻断文字制作；需要外观锁定时再补参考图。'});
    return {schema: 'ASSET_PRODUCTION_CARD_V1', assetKey: entry.assetKey, name: entry.name, type: entry.type, use: entry.use,
      applicable: {episode: packet.episode, sceneKeys}, sourceFacts,
      adoptedDesign: effective ? {version: design!.adoptionVersion ?? null, brief: design!.brief!, provenance: 'ADOPTED_DESIGN_NOT_SOURCE_FACT'} : null,
      ...(candidateDesigns.length?{candidateDesigns}:{}),
      freeDesignScope: effective && design?.freeDesignScope ? design.freeDesignScope : '原文与已采用设计未限定的非剧情美术细节可提出补足；不得擅自新增剧情功能、出入口、遮挡关系或道具能力。',
      materialAvailability: effective ? design!.materialAvailability : 'TEXT_ONLY', imageEvidence: 'NO_PIXELS_READ', references: effective ? design!.references : [], materialNeeds};
  });
}

/** Model transport only. Stored facts/quotes/IDs and their validation remain unchanged. */
export function projectAssetDesignFacts(facts: VisualFact[]) {
  const unique=[...new Map(facts.map(f=>[JSON.stringify([f.subjectKey,f.attribute,f.value,f.versionKey,f.scope,f.quote,f.chunkId,f.startLine,f.endLine]),f])).values()];
  const evidence: {id:string;quote:string;chunkId:string;startLine:number;endLine:number;sourceLabel?:string}[]=[];
  const references=new Map<string,string>();
  const lockedFacts=unique.map(fact=>{
    const {id:_id,quote,chunkId,startLine,endLine,sourceLabel,...value}=fact;
    const identity=JSON.stringify([quote,chunkId,startLine,endLine,sourceLabel]);
    let evidenceId=references.get(identity);
    if(!evidenceId){evidenceId=`E${evidence.length+1}`;references.set(identity,evidenceId);evidence.push({id:evidenceId,quote,chunkId,startLine,endLine,...(sourceLabel?{sourceLabel}:{})});}
    return {...value,evidenceId};
  });
  const compact={lockedFacts,evidence,evidenceTableRule:'lockedFacts的evidenceId引用同包evidence；原文只出现一次，记录不等于用户已确认，原文引用优先。'};
  const original={lockedFacts:unique};
  return JSON.stringify(compact).length<JSON.stringify(original).length?compact:original;
}
