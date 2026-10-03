/** Model-only transport. Canonical evidence, hashes and receiver contracts stay unchanged. */
import { createHash } from 'node:crypto';
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Exact transport projection; asset and scene identities are never renumbered. */
export function compactFoundationSceneRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactFoundationSceneRefs);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === 'sceneRefs' && Array.isArray(child)
      ? child.map(ref => record(ref) && Object.keys(ref).every(field => field === 'episode' || field === 'sceneKey') && typeof ref.episode === 'number' && typeof ref.sceneKey === 'string'
        ? [ref.episode, ref.sceneKey] : ref)
      : compactFoundationSceneRefs(child)]));
}

const SCENE_TABLE_FORMAT = 'SCENE_TABLE_V1';
const sceneTableGuide = 'columns按顺序对应每行rows，逐行等价于原scenes对象；null是显式空值，不是缺字段。人物、原文行号、场景键及未知附加字段均原样保留。输出仍使用原changes.scenes对象格式。';
const jsonValue = (value: unknown): boolean => value === null || typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value)
  || Array.isArray(value) && Object.keys(value).length === value.length && value.every(jsonValue)
  || record(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(jsonValue);

/** Transport-only and opt-in by actual savings. Heterogeneous/missing fields stay objects. */
export function compactFoundationSceneTable(value: unknown): unknown {
  if (!Array.isArray(value) || value.length < 2 || !value.every(record) || !jsonValue(value)) return value;
  const columns = Object.keys(value[0]);
  if (!columns.length || !value.every(row => Object.keys(row).length === columns.length && columns.every(key => Object.hasOwn(row, key)))) return value;
  const table = { format: SCENE_TABLE_FORMAT, columns, interpretation: sceneTableGuide, rows: value.map(row => columns.map(key => row[key])) };
  return JSON.stringify(table).length < JSON.stringify(value).length ? table : value;
}

/** Restore the original semantic input before hashing or supplying local repair evidence. */
export function expandFoundationSceneTable(value: unknown): unknown {
  if (!record(value) || value.format !== SCENE_TABLE_FORMAT) return value;
  const { columns, rows } = value;
  if (Object.keys(value).some(key => !['format','columns','interpretation','rows'].includes(key)) || value.interpretation !== sceneTableGuide
    || !Array.isArray(columns) || !columns.length || columns.some(key => typeof key !== 'string') || new Set(columns).size !== columns.length
    || !Array.isArray(rows) || !rows.every(row => Array.isArray(row) && row.length === columns.length && jsonValue(row))) throw new Error('场表传输结构无效，未猜测或丢弃字段。');
  return rows.map(row => Object.fromEntries(columns.map((key,index) => [key,row[index]])));
}

/** All historical evidence stays visible; only repeated wire keys/values and anchor IDs are factored out. */
function compactFoundationHistoricalEvidence(value: unknown, sourceVersion?: unknown, sourceContextVersion?: unknown): unknown {
  if (!Array.isArray(value) || value.length < 2 || !value.every(record) || !jsonValue(value)) return value;
  const fields = ['id', 'subjects', 'kind', 'statement', 'evidence', 'claim', 'applicability', 'validity', 'candidateUse', 'currentApplicability', 'retrieval'];
  const exactKeys = (row: RecordValue, keys: string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
  const oneOf = (item: unknown, choices: string[]) => typeof item === 'string' && choices.includes(item);
  const ids = value.map(row => row.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return value;
  const positions = new Map(ids.map((id, index) => [id, index]));
  // New/unknown metadata or unresolved links keep the whole original array, never a lossy best effort.
  if (!value.every(row => {
    const evidence = row.evidence, validity = row.validity, retrieval = row.retrieval;
    return exactKeys(row, fields) && typeof row.statement === 'string'
      && Array.isArray(row.subjects) && row.subjects.every(subject => typeof subject === 'string')
      && oneOf(row.kind, ['IDENTITY', 'RELATION', 'STATE', 'SETTING', 'UTTERANCE', 'CONTEXT', 'FORMAT'])
      && oneOf(row.claim, ['SOURCE', 'CHARACTER_CLAIM']) && oneOf(row.applicability, ['GLOBAL', 'SUBJECT', 'UNRESOLVED'])
      && record(evidence) && exactKeys(evidence, ['domain', 'episode', 'start', 'end']) && evidence.domain === 'EPISODE'
      && ['episode', 'start', 'end'].every(key => Number.isSafeInteger(evidence[key]) && Number(evidence[key]) >= 0) && Number(evidence.end) > Number(evidence.start)
      && record(validity) && oneOf(validity.status, ['EXPLICIT', 'UNKNOWN'])
      && Object.keys(validity).every(key => key === 'status' || ['start', 'end'].includes(key) && Number.isSafeInteger(validity[key]))
      && row.candidateUse === 'HISTORICAL_EVIDENCE_ONLY' && row.currentApplicability === 'UNKNOWN'
      && record(retrieval) && exactKeys(retrieval, ['mode', 'anchorFactIds']) && oneOf(retrieval.mode, ['SUBJECT_MENTION', 'SOURCE_NEIGHBOUR'])
      && Array.isArray(retrieval.anchorFactIds) && retrieval.anchorFactIds.every(id => typeof id === 'string' && positions.has(id));
  })) return value;
  const shared = Object.fromEntries(['validity', 'candidateUse', 'currentApplicability']
    .filter(key => value.every(row => JSON.stringify(row[key]) === JSON.stringify(value[0][key]))).map(key => [key, value[0][key]]));
  const columns = fields.filter(key => !Object.hasOwn(shared, key));
  const table = { format: 'HISTORICAL_EVIDENCE_TABLE_V1', columns, shared,
    evidenceColumns: ['domain', 'episode', 'start', 'end'], retrievalColumns: ['mode', 'anchorRows'],
    interpretation: 'columns按顺序对应rows；shared字段逐行原样适用，非缺省推测。evidence数组按evidenceColumns解释，起止为原文UTF16字符偏移；statement逐字保留。retrieval数组依retrievalColumns解释：anchorRows是本表rows的零起始索引，引用该行id，等价于原anchorFactIds；id及人物身份不改。这些仍是历史证据候选，不是当前事实；CHARACTER_CLAIM不升级为客观事实，UNKNOWN不代表状态永久持续。',
    rows: value.map(row => columns.map(key => {
      if (key === 'evidence') { const evidence = row.evidence as RecordValue; return [evidence.domain, evidence.episode, evidence.start, evidence.end]; }
      if (key === 'retrieval') { const retrieval = row.retrieval as RecordValue; return [retrieval.mode, (retrieval.anchorFactIds as string[]).map(id => positions.get(id))]; }
      return row[key];
    })) };
  const legacy = JSON.stringify(table).length < JSON.stringify(value).length ? table : value;
  // These IDs are mechanical hashes of exact source coordinates, not model-authored
  // identity or semantic judgments. Verify every hash before replacing repetition
  // with a self-contained recipe; arbitrary/legacy IDs keep the unchanged V1 wire.
  if (typeof sourceVersion !== 'string' || !sourceVersion || typeof sourceContextVersion !== 'string' || !sourceContextVersion
    || !value.every(row => {
      const evidence = row.evidence as RecordValue;
      const origin = { domain: evidence.domain, episode: evidence.episode, start: evidence.start, end: evidence.end };
      return row.id === createHash('sha256').update(JSON.stringify([sourceVersion, sourceContextVersion, origin])).digest('hex');
    })) return legacy;
  const sharedV2 = Object.fromEntries(fields.filter(key => !['id','evidence','retrieval'].includes(key)
    && value.every(row => JSON.stringify(row[key]) === JSON.stringify(value[0][key]))).map(key => [key,value[0][key]]));
  const columnsV2 = fields.filter(key => key !== 'id' && !Object.hasOwn(sharedV2,key));
  const dictionaries: Record<string, unknown[]> = {};
  const dictionaryPositions = new Map<string, Map<string, number>>();
  for (const key of columnsV2.filter(key => !['evidence','retrieval'].includes(key))) {
    const distinct = new Map<string, number>(), entries: unknown[] = [];
    const indices = value.map(row => {
      const serialized = JSON.stringify(row[key]);
      if (!distinct.has(serialized)) { distinct.set(serialized, entries.length); entries.push(row[key]); }
      return distinct.get(serialized)!;
    });
    if (JSON.stringify({[key]:entries}).length + JSON.stringify(indices).length < JSON.stringify(value.map(row=>row[key])).length) {
      dictionaries[key] = entries; dictionaryPositions.set(key,distinct);
    }
  }
  const derived = { format: 'HISTORICAL_EVIDENCE_TABLE_V2', columns: columnsV2, shared: sharedV2, dictionaries,
    idDerivation: { format: 'SHA256_JSON_V1', sourceVersion, sourceContextVersion },
    evidenceShared: { domain: 'EPISODE' }, evidenceColumns: ['episode','start','end'], retrievalColumns: ['mode','anchorRows'],
    interpretation: 'columns按顺序对应rows；shared逐行原样适用，非缺省推测。dictionaries按字段名给值表，该字段的行内整数是值表零起始索引。每条历史证据仍独立，不能把相同原句的不同来源合并。evidence数组按evidenceColumns配合evidenceShared恢复对象，起止为原文UTF16字符偏移，statement逐字保留。id由程序逐条验证后省略，可按idDerivation恢复：SHA256的十六进制摘要，输入为JSON.stringify([sourceVersion,sourceContextVersion,{domain,episode,start,end}])，对象键顺序须如上，UTF8编码。模型不需计算hash，不用机器id作为回执。retrieval为null明确表示SUBJECT_MENTION且anchorRows仅本行；非null数组依retrievalColumns解释，anchorRows引用本表rows零起始行，恢复对应行id即原anchorFactIds。仍是历史候选，不是当前事实；CHARACTER_CLAIM不升级客观事实，UNKNOWN不表示永久持续。',
    rows: value.map(row=>columnsV2.map(key=>{
      const dictionary = dictionaryPositions.get(key);
      if (dictionary) return dictionary.get(JSON.stringify(row[key]));
      if (key === 'evidence') { const evidence=row.evidence as RecordValue; return [evidence.episode,evidence.start,evidence.end]; }
      if (key === 'retrieval') {
        const retrieval=row.retrieval as RecordValue, anchors=retrieval.anchorFactIds as string[];
        return retrieval.mode==='SUBJECT_MENTION' && anchors.length===1 && anchors[0]===row.id ? null
          : [retrieval.mode,anchors.map(id=>positions.get(id))];
      }
      return row[key];
    })) };
  return JSON.stringify(derived).length < JSON.stringify(legacy).length ? derived : legacy;
}

export function projectFoundationModelInput(input: unknown): unknown {
  if (!record(input)) return input;
  const compactInput = Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
    key === 'crossBatchVariants' && Array.isArray(value)
      ? value.filter(row => !record(row) || Object.keys(row).some(field => !['assetKey','variants'].includes(field)) || !Array.isArray(row.variants) || row.variants.length > 0)
      : key === 'scenes' ? compactFoundationSceneTable(value) : key === 'source' ? value : compactFoundationSceneRefs(value)]));
  if (!record(input.facts)) return compactInput;
  const facts = input.facts;
  // Unknown root metadata may refer to full historical IDs. Keep legacy addressability
  // until that contract is understood, even if individual rows look derivable.
  const derivedHistoryAllowed = facts.schema === 'FOUNDATION_FACTS_V1' && Object.keys(facts).every(key => [
    'schema','sourceVersion','sourceContextVersion','current','background','backgroundCandidates','historicalStates',
    'historicalEvidenceCandidates','historicalEvidenceRejected','backgroundCandidatesOmitted','unlinkedBackgroundCount',
    'unlinkedBackground','sourceFactIndex','rules'
  ].includes(key));
  const historicalWire = Object.hasOwn(facts, 'historicalEvidenceCandidates')
    ? { historicalEvidenceCandidates: compactFoundationHistoricalEvidence(facts.historicalEvidenceCandidates,
      derivedHistoryAllowed ? facts.sourceVersion : undefined, derivedHistoryAllowed ? facts.sourceContextVersion : undefined) } : {};
  if (facts.format === 'FACT_TABLE_V1') return { ...compactInput, facts: { ...(compactInput.facts as RecordValue), ...historicalWire } };
  // Only omit mechanical indices when their complete backing episode is actually supplied.
  // Fragmented/missing source and externally supplied statements must stay visible.
  const sourceTexts = new Map<number, string>();
  if (record(input.source) && Array.isArray(input.source.episodes)) for (const episode of input.source.episodes) {
    if (!record(episode) || typeof episode.number !== 'number' || !Array.isArray(episode.lines)) continue;
    if (episode.lines.length !== episode.lineCount || !episode.lines.every((line, index) => Array.isArray(line) && line[0] === index + 1 && typeof line[1] === 'string')) continue;
    sourceTexts.set(episode.number, episode.lines.map(line => line[1]).join(''));
  }
  const recoverableCurrent = (fact: unknown) => {
    if (!record(fact) || !record(fact.evidence) || !record(fact.validity)) return false;
    if (fact.validity.status !== 'UNKNOWN' || Object.keys(fact.validity).length !== 1) return false;
    if (Object.keys(fact).some(key => !['id', 'subjects', 'kind', 'statement', 'evidence', 'claim', 'applicability', 'validity'].includes(key))) return false;
    const evidence = fact.evidence, text = typeof evidence.episode === 'number' ? sourceTexts.get(evidence.episode) : undefined;
    if (evidence.domain !== 'EPISODE' || text === undefined || typeof evidence.start !== 'number' || typeof evidence.end !== 'number'
      || !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) || evidence.start < 0 || evidence.end <= evidence.start || evidence.end > text.length) return false;
    return fact.statement === undefined || fact.statement === text.slice(evidence.start, evidence.end);
  };
  const semanticIdentity = (fact: RecordValue) => JSON.stringify([fact.evidence, fact.subjects, fact.kind, fact.claim, fact.applicability, fact.validity]);
  const backgroundEvidence = new Set(['background', 'backgroundCandidates'].flatMap(category => Array.isArray(facts[category])
    ? (facts[category] as unknown[]).filter(record).map(semanticIdentity) : []));
  let omittedCurrentIndexCount = 0, omittedUnlinkedDuplicateCount = 0;
  const rows: unknown[][] = [];
  const rowKeys = new Map<string, number>();
  const groups: Record<string, number[]> = {};
  const categories = ['current', 'background', 'backgroundCandidates', 'historicalStates', 'unlinkedBackground', 'sourceFactIndex'];
  for (const category of categories) {
    if (!Array.isArray(facts[category])) continue;
    const selected = (facts[category] as unknown[]).filter(fact => {
      if ((category === 'current' || category === 'sourceFactIndex') && recoverableCurrent(fact)) { omittedCurrentIndexCount++; return false; }
      if (category === 'unlinkedBackground' && record(fact) && fact.statement === undefined && backgroundEvidence.has(semanticIdentity(fact))) { omittedUnlinkedDuplicateCount++; return false; }
      return true;
    });
    if (!selected.length) continue;
    groups[category] = selected.map(fact => {
      if (!record(fact) || !record(fact.evidence)) throw new Error(`Invalid foundation fact in ${category}`);
      const evidence = fact.evidence;
      // Source coordinates remain exact, including episode zero and section identity.
      const origin = [evidence.domain, evidence.domain === 'EPISODE' ? evidence.episode : evidence.sectionKey, evidence.start, evidence.end];
      const validity = record(fact.validity) && (fact.validity.status !== 'UNKNOWN' || Object.keys(fact.validity).length > 1) ? fact.validity : undefined;
      const row = [origin, fact.subjects, fact.kind, fact.claim, fact.applicability,
        ...(typeof fact.statement === 'string' || validity ? [fact.statement ?? null] : []), ...(validity ? [validity] : [])];
      const key = JSON.stringify(row);
      let index = rowKeys.get(key);
      if (index === undefined) { index = rows.length; rowKeys.set(key, index); rows.push(row); }
      return index;
    });
  }
  const { sourceVersion: _sourceVersion, sourceContextVersion: _sourceContextVersion, schema: _schema, ...rest } = facts;
  for (const category of categories) delete rest[category];
  return { ...compactInput, facts: { ...rest, ...historicalWire, format: 'FACT_TABLE_V1',
    omittedCurrentIndexCount, omittedUnlinkedDuplicateCount,
    columns: ['origin:[domain,episodeOrSectionKey,start,end]', 'subjects', 'kind', 'claim', 'applicability', 'statement?', 'validity?'],
    interpretation: '本批事实直接查完整source；可由该原文重建的逐行机械索引不重复传输，省略索引不等于省略原文或无需检查。台词只是角色主张，不等于事实。groups内整数是rows的零起始索引，仅为本次输入引用；origin起止是原文字符偏移，非行号。statement省略时读source对应原文；validity省略表示UNKNOWN。分类是程序检索提示，不是已确认事实。unlinkedBackground重复元数据只计数，其正文及坐标仍在背景/候选表。hash与数据库id由程序保管，不作为输出回执id。',
    rows, groups } };
}
