import { createHash } from 'node:crypto';
import { readApplicationScope, scopeEpisodes, type ChoiceEvidenceRef } from './foundation-application-scope';
import { unresolvedOwner, unresolvedEpisodeScope } from './foundation-production-contracts';
import type { FoundationDocument } from './foundation-document';
import type { LightScene } from './light-foundation-supply';
import type { FoundationIssue, SourceIndex } from './project-foundation-contracts';
import type { HumanChoice } from './foundation-human-choices';

type SceneRef = { episode: number; sceneKey: string };
export type FoundationDispatchItem = {
  fingerprint: string; owner: 'PROGRAM' | 'F2' | 'Q1'; coordinate: string; problem: string;
  episodes: number[]; keys: string[]; scenes: SceneRef[]; evidenceRefs: ChoiceEvidenceRef[];
  allowedFields: string[]; acceptance: string[]; todoId?: string;
};
export type FoundationDispatchTarget = {
  owner: 'F2' | 'Q1'; episodes: number[]; keys: string[]; sceneKeys: string[];
  items: FoundationDispatchItem[]; allowedFields: string[]; acceptance: string[];
};
export type FoundationIssueDispatchPlan = {
  targets: FoundationDispatchTarget[]; backendItems: FoundationDispatchItem[];
  authorQuestions: HumanChoice[]; fingerprints: string[]; fingerprint: string;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = <T>(values: T[]) => [...new Set(values)];
const sorted = (values: number[]) => unique(values).sort((a,b)=>a-b);
const preserve = '原文逐字保留；只改列明对象和字段；重跑原问题校验后才能结案';

/** Pure routing only. A backend item never authorizes a model call or a source mutation. */
export function planFoundationIssueDispatch(input: {
  doc: Pick<FoundationDocument, 'f2' | 'editorialTodos'>; scenes: readonly LightScene[];
  index: SourceIndex; issues: readonly FoundationIssue[]; authorQuestions?: HumanChoice[];
}): FoundationIssueDispatchPlan {
  const {doc, scenes, index} = input;
  const all = index.episodes.map(e=>e.number);
  const entries = doc.f2?.assets.flatMap(asset=>[asset,...asset.variants].map(item=>({asset,item}))) ?? [];
  const items: FoundationDispatchItem[] = [];
  function add(raw: Omit<FoundationDispatchItem,'fingerprint'|'acceptance'>, identity: string) {
    raw.episodes = sorted(raw.episodes);
    raw.keys = unique(raw.keys).sort();
    raw.scenes = [...new Map(raw.scenes.map(s=>[`${s.episode}:${s.sceneKey}`,s])).values()].sort((a,b)=>a.episode-b.episode||a.sceneKey.localeCompare(b.sceneKey));
    if (!raw.episodes.length || raw.episodes.some(n=>!all.includes(n)) || raw.scenes.some(ref=>!scenes.some(s=>s.episode===ref.episode&&s.sceneKey===ref.sceneKey))) {
      raw.owner='PROGRAM'; raw.allowedFields=[]; raw.episodes=[]; raw.scenes=[];
    }
    // A coordinate is an object, not an issue id. Preserve multiplicity when several
    // diagnostics target the same field, without using volatile model wording/ids.
    const basis=digest([identity,raw.keys,raw.episodes,raw.scenes]);
    const ordinal=items.filter(item=>item.fingerprint.startsWith(`${basis}:`)).length;
    items.push({...raw,fingerprint:`${basis}:${ordinal}`,acceptance:[preserve]});
  }
  for (const issue of input.issues) {
    const entry=entries.find(({item})=>issue.coordinate===`assets.${item.key}.preparation` || issue.coordinate===`assets.${item.key}.sceneRefs`)
      ?? entries.find(({asset,item})=>issue.coordinate===`assets.${asset.key}.variants.${item.key}.episodes`);
    const repair=doc.f2?.repairItems?.find(r=>issue.coordinate===`assets.${r.assetKey}.variants.${r.variantKey}.episodes`);
    const episodeMatch=/^episodes\.(\d+)\.assetKeys\.(.+)$/.exec(issue.coordinate);
    const evidenceRefs=issue.sourceRefs.filter(r=>index.episodes.some(e=>e.number===r.episode&&r.startLine>=1&&r.endLine>=r.startLine&&r.endLine<=e.lineCount)).map(r=>({...r,sourceVersion:index.version}));
    let episodes=repair?.episodes ?? (entry ? ('usageEpisodes' in entry.item?entry.item.usageEpisodes:entry.item.episodes) : episodeMatch?[Number(episodeMatch[1])]:evidenceRefs.map(r=>r.episode));
    if(entry && issue.coordinate.endsWith('.sceneRefs')) {
      const refs=entry.item.sceneRefs??[];
      episodes=unique([...episodes.filter(n=>!refs.some(r=>r.episode===n)),...refs.filter(r=>!scenes.some(s=>s.episode===r.episode&&s.sceneKey===r.sceneKey)).map(r=>r.episode)]);
    }
    const owner=issue.coordinate.startsWith('source.')?'PROGRAM':entry||repair?'Q1':issue.owner==='F2'?'F2':issue.owner==='CONTROL'?'Q1':'PROGRAM';
    add({owner,coordinate:issue.coordinate,problem:issue.problem,episodes,keys:entry?[entry.asset.key]:episodeMatch?[episodeMatch[2]]:[],scenes:[],evidenceRefs,
      allowedFields:owner==='PROGRAM'?[]:['changes.assets','resolvedCatalogIssues']},`issue:${issue.owner}:${issue.coordinate}:${/明确实体交互/.test(issue.problem)?'physicalEvidence':'contract'}`);
  }
  for(const todo of doc.editorialTodos) {
    if(unresolvedOwner(todo)==='STAGE2')continue;
    let scope; try {scope=readApplicationScope(todo.applicationScope,unresolvedEpisodeScope(todo));} catch {scope={kind:'UNRESOLVED'} as const;}
    const split=/(?:拆场|拆分场次|独立子场|新增.{0,8}场次|sceneSplits|须拆|需拆)/.test(todo.note)
      && !/(?:无需|不需(?:要)?|不必|禁止)(?:再|进行)?(?:拆场|拆分场次|拆分)/.test(todo.note);
    let episodes=scopeEpisodes(scope,all), refs:SceneRef[]=scope.kind==='SCENES'?scope.scenes:[];
    // Legacy notes can narrow a declared episode, but cannot turn an unresolved scope into permission.
    if(scope.kind!=='UNRESOLVED'&&!refs.length) refs=scenes.filter(s=>episodes.includes(s.episode)&&(todo.key===s.sceneKey||new RegExp(`(?<![\\w-])${s.sceneKey.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\w-])`).test(todo.note))).map(({episode,sceneKey})=>({episode,sceneKey}));
    if(refs.length)episodes=sorted(refs.map(r=>r.episode));
    const entry=entries.find(({item})=>item.key===todo.key);
    const owner=unresolvedOwner(todo)==='PROGRAM'&&!split?'PROGRAM':'Q1';
    add({owner,coordinate:todo.key??'editorial.unlocated',problem:todo.note,episodes,keys:entry?[entry.asset.key]:[],scenes:refs,
      evidenceRefs:(todo.evidenceRefs??[]).filter(r=>r.sourceVersion===index.version&&episodes.includes(r.episode)&&!r.nodeId
        &&index.episodes.some(e=>e.number===r.episode&&(r.startLine===undefined||r.startLine>=1&&r.endLine!==undefined&&r.endLine>=r.startLine&&r.endLine<=e.lineCount))
        &&(!r.sceneKey||scenes.some(s=>s.episode===r.episode&&s.sceneKey===r.sceneKey))),todoId:todo.id,
      allowedFields:owner==='PROGRAM'?[]:split?['changes.sceneSplits','changes.scenes','changes.assets','resolvedUnresolved']:['changes.assets','changes.scenes','resolvedUnresolved']},`todo:${split?'sceneSplit':unresolvedOwner(todo)}:${todo.key??''}`);
  }
  const targets:FoundationDispatchTarget[]=items.filter(item=>item.owner!=='PROGRAM').map(item=>({owner:item.owner as 'F2'|'Q1',episodes:item.episodes,keys:item.keys,sceneKeys:item.scenes.map(s=>s.sceneKey),items:[item],allowedFields:item.allowedFields,acceptance:item.acceptance}));
  // Only explicit, already reviewed author decisions enter this channel. Diagnostics never become questions.
  const authorQuestions=input.authorQuestions??[];
  const fingerprints=unique([...items.map(i=>i.fingerprint),...authorQuestions.map(q=>digest(['AUTHOR',q.decisionKey,q.applicationScope??q.episodes]))]).sort();
  return {targets,backendItems:items.filter(item=>item.owner==='PROGRAM'),authorQuestions,fingerprints,fingerprint:digest(fingerprints)};
}

/** Rewording, replacement ids and reordered diagnostics cannot count as progress. */
export function hasFoundationIssueProgress(before: FoundationIssueDispatchPlan, after: FoundationIssueDispatchPlan): boolean {
  return after.fingerprints.length<before.fingerprints.length && after.fingerprints.every(id=>before.fingerprints.includes(id));
}
