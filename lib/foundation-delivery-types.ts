import type { FoundationDocument } from './foundation-document';
import type { FoundationChoiceView } from './foundation-choice-store';
import type { FoundationIssue, FoundationStageCode } from './project-foundation-contracts';
import type { FoundationSourceContext } from './foundation-source';

export type DeliveryStatus = 'QUEUED' | 'RUNNING' | 'WAITING_USER' | 'COMPLETE' | 'PARTIAL' | 'INTERRUPTED' | 'STOPPED';
export type DeliveryPhase = 'PREPARE_SOURCE' | 'GENERATE_F1' | 'GENERATE_F2' | 'EDIT' | 'REPAIR' | 'APPLY_DECISION';
export type FoundationDeliveryTask = {
  schema: 'FOUNDATION_DELIVERY_TASK_V1'; id: string; revision: number; projectId: string;
  provider: 'API' | 'CLI'; contextFingerprint: string;
  sourceVersion: string; documentRevision: string; status: DeliveryStatus; phase: DeliveryPhase;
  scope: number[]; completedEpisodes: number[]; totalEpisodes: number; message: string;
  createdAt: string; updatedAt: string; workerPid: number | null; workerToken: string | null;
  addedCalls: number; repairCalls: number; repairRounds: number; maxRepairCalls: number; maxRepairRounds: number;
  repairBudgetUsed?: number;
  repairBudgetKey?: string;
  repairBudgetContext?: string;
  repairHalt?: { fingerprint: string; reason: string };
  sourceInputVersion?: string;
  unknownOutcome: boolean; error: string | null; decisionIds: string[];
  /** Explicit opt-in captured when queueing; image generation is not included. */
  autoAssetPrompts?: boolean;
  unknownRetry?: { runId: string; sequence: number };
  unresolved: { key?: string; episodes?: number[]; note: string }[];
};
export type FoundationDeliveryState = {
  document: FoundationDocument; previousDocument: FoundationDocument | null;
  task: FoundationDeliveryTask | null; totalEpisodes: number; availableEpisodes: number; editedEpisodes: number;
  busy: boolean; complete: boolean; needsContextEdit: boolean;
  documentReady?: boolean;
  effectiveEditorialCoverage?:number[];
  needsAssetRefresh?: boolean;
  methodUpdateAvailable?: boolean;
  action: 'START' | 'CONTINUE' | 'NONE' | 'UNKNOWN_CONFIRM' | 'BLOCKED';
  continuationBlocker?: string | null;
  requiredChoices: FoundationChoiceView[]; confirmedChoices: FoundationChoiceView[];
  suggestionsCount: number; sourceContext: FoundationSourceContext; codes: Record<string, string>;
  activeCallStartedAt?: string | null;
  issues: FoundationIssue[]; expectedState: string;
};

export const DELIVERY_ACTIVE_STATUSES: DeliveryStatus[] = ['QUEUED', 'RUNNING'];
export const deliveryStage = (phase: DeliveryPhase): FoundationStageCode => phase === 'GENERATE_F1' ? 'F1' : phase === 'GENERATE_F2' ? 'F2' : 'Q1';
