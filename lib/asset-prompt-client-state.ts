import type {PromptWorkspace} from './asset-prompt-contract';
export function clearSavedPromptDraft(drafts:Record<string,string>,key:string,savedBody:string){
 const next={...drafts};if(next[key]===savedBody)delete next[key];return next;
}
/** A poll started before a save must never roll the saved revision backwards. */
export function mergePromptWorkspace(current:PromptWorkspace,incoming:PromptWorkspace):PromptWorkspace{
 if(current.projectId!==incoming.projectId)return incoming;
 const records={...incoming.records},imageOptions={...incoming.imageOptions};
 for(const [key,value] of Object.entries(current.records))if(!records[key]||records[key].revision<value.revision)records[key]=value;
 for(const [key,value] of Object.entries(current.imageOptions??{}))if(!imageOptions[key]||imageOptions[key].revision<value.revision)imageOptions[key]=value;
 return {...incoming,records,imageOptions,...(current.styleRevision>incoming.styleRevision?{styleRevision:current.styleRevision,stylePrefix:current.stylePrefix}:{} )};
}
