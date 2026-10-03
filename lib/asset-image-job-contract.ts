import type {AssetReferenceImage} from './asset-image-options';

export type ImageJobImage = AssetReferenceImage & {sha256:string};
export type ImageJobReference = AssetReferenceImage & {assetKey:string;role:'SOURCE'|'SUPPLEMENT';sha256:string};
export type ImageJob = {
  id:string;key:string;name:string;revision:number;
  status:'WAITING_EXECUTOR'|'RUNNING'|'REVIEW'|'FAILED'|'CANCELLED';
  provider:'CHATGPT_WEB';dispatchMode?:'CHROME'|'MANUAL';stale:boolean;prompt:string;createdAt:string;error:string;
  expectedCount:number;quality:string;aspectRatio:string;
  references:ImageJobReference[];images:ImageJobImage[];
  usedImageIds:string[];executionUrl?:string;leaseExpired?:boolean;resultOrigin?:'WEB_EXECUTOR'|'MANUAL_IMPORT';
};
