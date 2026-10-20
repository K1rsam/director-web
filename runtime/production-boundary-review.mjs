import {digest,fail} from './storyboard-v4/core/shared.mjs';
import {selectedActualTail} from './episode-boundary.mjs';
import {boundaryReviewEntry,boundaryEntryEvidence} from './storyboard-v4/core/pipeline.mjs';

/** Evidence transport only: no semantic decision, inferred actual state or AI call. */
export function buildProductionBoundaryPacket(workflow,current,previous,sources,nativeEvidence={}){
 const b=current?.web?.binding,context=current?.production?.boundary,from=context?.seed?.fromEpisode;
 if(!b||b.projectId!==workflow.projectId||b.productionChain?.id!==workflow.id||workflow.selectedRuns[b.episodeNumber]!==current.id
  ||!context||!previous||workflow.selectedRuns[from]!==previous.id||previous.web?.binding?.projectId!==workflow.projectId
  ||previous.web.binding.episodeNumber!==from||context.mode!=='ACTUAL'||!context.actual?.validated
  ||context.actual.runId!==previous.id||context.actual.version!==digest(selectedActualTail(previous))
  ||current.web.sourceStale||previous.web.sourceStale||current.operations.some(o=>o.status==='running'||o.status==='queued'||o.status==='unknown'&&!o.cancelAcknowledgement?.acceptUnknownUsage))
  fail('WORKFLOW_BOUNDARY_EVIDENCE','必须先取得当前选定前集真实尾稿、当前双源和已结回执；不能从摘要推断承接。');
 if(!sources||typeof sources.previous!=='string'||!sources.previous||typeof sources.current!=='string'||!sources.current)fail('WORKFLOW_BOUNDARY_EVIDENCE','缺少完整双源正文。');
 const entry=boundaryReviewEntry(current);
 if(!entry)fail('WORKFLOW_BOUNDARY_EVIDENCE','没有当前有效的入口回执，不能套用旧计划签名。');
 const revision=n=>workflow.selectionHistory?.findLast(h=>h.episodeNumber===n&&h.runId===workflow.selectedRuns[n])?.selectionRevision??workflow.selectionRevision;
 const selectionRevision=b.productionChain.selectionProtocol==='per-episode-selection-v1'?{[from]:revision(from),[b.episodeNumber]:revision(b.episodeNumber)}:workflow.selectionRevision;
 const evidence={version:'production-boundary-evidence-v1',workflowId:workflow.id,projectId:workflow.projectId,selectionRevision,
  selectedRuns:{[from]:previous.id,[b.episodeNumber]:current.id},sourceVersion:workflow.sourceVersion,runId:current.id,episodeNumber:b.episodeNumber,
  sources:structuredClone(sources),nativeEvidence:structuredClone(nativeEvidence),previous:{runId:previous.id,source:previous.source,assembly:previous.assembly,tail:selectedActualTail(previous)},
  current:{source:current.source,assembly:current.assembly??null,adopted:current.adopted,entry,plan:current.plan},entryEvidence:boundaryEntryEvidence(current,entry),
  context,check:current.production.boundaryCheck,
  bindings:{previous:digest({source:previous.source,assembly:previous.assembly,adopted:previous.adopted,operations:previous.operations}),
   current:digest({source:current.source,assembly:current.assembly,adopted:current.adopted,operations:current.operations,entry,entryEvidenceContext:current.production?.entryEvidenceContext??null,sourceResolutions:current.production?.sourceResolutions??[]})}};
 return {...structuredClone(evidence),evidenceHash:digest(evidence),scope:'只供完整双源及实际尾首镜语义复核；不得把结构通过当成文字、视听或用户验收。'};
}

export function assertBoundaryPacket(packet,expectedHash){
 if(typeof expectedHash!=='string'||expectedHash!==packet.evidenceHash)fail('WORKFLOW_BOUNDARY_STALE','选版、双源、回执或尾稿已变化；先重新读取证据包，未套用旧裁决。');
}
