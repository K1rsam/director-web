import {promptNeedsReview,type PromptWorkspace} from './asset-prompt-contract';
export function planAssetPromptQueue(w:PromptWorkspace,requested:string[],dirtyKeys:string[]=[]){
 const queue:string[]=[],active=new Set<string>(),done=new Set<string>();
 function visit(key:string,dependency=false){
  if(done.has(key))return;if(active.has(key))throw new Error('资产来源存在循环，请先调整来源关系。');
  const a=w.assets.find(a=>a.key===key);if(!a)throw new Error('来源资产已不存在，请刷新目录。');
  const r=w.records[key];
  if(dependency&&r?.status==='READY'&&r.body&&!promptNeedsReview(a,w.records,w.assets)){done.add(key);return;}
  if(dirtyKeys.includes(key))throw new Error(`请先保存“${a.name}”的编辑，再生成此形象。`);
  if(dependency&&r?.origin==='MANUAL'&&r.body)throw new Error(`来源“${a.name}”已由你修改，请先核对并保存确认，避免覆盖人工设计。`);
  if(r?.status==='RUNNING')throw new Error(`“${a.name}”正在生成，请等待完成。`);
  active.add(key);const parent=a.fromKey??(a.variant?a.baseKey:undefined);if(parent)visit(parent,true);
  active.delete(key);done.add(key);queue.push(key);
 }
 requested.forEach(key=>visit(key));return queue;
}
