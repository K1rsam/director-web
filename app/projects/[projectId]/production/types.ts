import type {ProductionWorkflow} from '@/lib/production-workflow';

export type EpisodeOption={id:string;number:number;title:string};
export type AssetOption={key:string;name:string;episodes:number[];mode:string};
export type WorkflowAction={kind:string;owner?:string;message?:string;episodeNumber?:number;runId?:string;fingerprint?:string;assetKeys?:string[];proposedAction?:WorkflowAction;needs?:{stage:number;target:string;purpose:string;blocking:boolean;sourceRefs:string[];packageIds:string[]}[]};
export type WorkflowSnapshot={workflow:ProductionWorkflow;keyDesignGate:'NOT_SPECIFIED'|'WAITING_CONFIRMATION'|'CONFIRMED';
 readiness:{sourceVersion:string;standard:{ready:boolean;issues:unknown[]};stage1:{ready:boolean;busy:boolean;blocker?:string};direction:{status:string;hasCandidate:boolean;pending:boolean;blocker?:string};assets:{missingCandidateKeys:string[];missingCriticalKeys:string[];busy:boolean};sourceConflicts:unknown[];technicalIssues:unknown[]};nextAction:WorkflowAction;
 budget:{id:string;maxCalls:number;maxTokens:number;paused:boolean;summary:{calls:number;knownTokens:number;unknownAttempts:number;inFlight:number;complete:boolean}}};
export type RunOption={id:string;status:string;createdAt:string;legacyReadOnly?:boolean};

export const actionLabel=(action:WorkflowAction)=>({STAGE1:'整理基础资料',DIRECTION:'整理全剧方向候选',ASSETS:'补所选资产材料',STORYBOARD_CREATE:`开始第${action.episodeNumber}集分镜`,STORYBOARD_CONTINUE:`继续第${action.episodeNumber}集分镜`,WAIT_CONTINUITY:'等待必要的实际承接核对',QUALITY_CHECK:'记录首集实际质量核对',COMPLETE:'选集文字交付已完成'} as Record<string,string>)[action.kind]||'先处理当前待办';
export const paidAction=(kind:string)=>['STAGE1','DIRECTION','ASSETS','STORYBOARD_CREATE','STORYBOARD_CONTINUE'].includes(kind);
