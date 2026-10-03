import {createHash} from 'node:crypto';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';

export type BridgeConfig={baseUrl:string;apiToken:string};
export type BridgeHealth={ok:boolean;clients:number;pendingRequests?:number;activeRequests?:unknown;needsSelection?:boolean};
type BrowserClient={id:string;launchToken?:string;ready?:boolean;compatible?:boolean;quarantined?:boolean;selected?:boolean;activeRequest?:unknown;session?:{id?:string}};
export const boundImagePrompt=(prompt:string,id:string)=>`${prompt}\n\n任务关联码：${id}。仅用于关联本次生成，请勿将编号或文字画入图片。`;
export const imagePromptDigest=(prompt:string)=>digest(Buffer.from(prompt.replace(/\s+/g,' ').trim()));
export class BridgeError extends Error{constructor(public code:'OFFLINE'|'HTTP'|'INVALID'|'MISSING',message:string){super(message);}}
const maxJson=4*1024*1024,maxImage=20*1024*1024;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const imageBrowserDirectory=()=>path.resolve(/*turbopackIgnore: true*/ 'runtime-3008/image-browser');
export async function readImageBrowserConfig():Promise<BridgeConfig|null>{
  try{
    const filename=path.join(/*turbopackIgnore: true*/ imageBrowserDirectory(),'bridge.env');
    const info=await lstat(/*turbopackIgnore: true*/ filename);if(!info.isFile()||info.isSymbolicLink())return null;
    const contents=await readFile(/*turbopackIgnore: true*/ filename,'utf8');
    const token=contents.match(/^API_TOKEN=([A-Za-z0-9_-]{32,})\r?$/m)?.[1];
    const port=Number(contents.match(/^PORT=(\d+)\r?$/m)?.[1]??53179);
    return token&&Number.isSafeInteger(port)&&port>=1024&&port<=65535?{baseUrl:`http://127.0.0.1:${port}`,apiToken:token}:null;
  }catch{return null;}
}
async function bounded(response:Response,limit:number){
  const length=Number(response.headers.get('content-length')??0);if(length>limit){await response.body?.cancel();throw new BridgeError('INVALID','返回内容超出大小限制。');}
  const reader=response.body?.getReader();if(!reader)throw new BridgeError('INVALID','桥接返回为空。');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new BridgeError('INVALID','返回内容超出大小限制。');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
export type BridgeArtifact={id:string;mime:string;size?:number;generatedImage?:boolean;kind?:string;phase?:string;downloadable?:boolean;requestId?:string;sourceTurnKey?:string;sessionId?:string;sourceClientId?:string;blockTestId?:string;url?:string};
export type BridgeTurn={id:string;status:string;error?:unknown;output?:{artifacts?:BridgeArtifact[];response?:{requestId?:string;turnKey?:string;session?:{id?:string};sourceClientId?:string;url?:string}}};
export type NativeImageProof={status:string;requestId?:string;conversationId?:string;assistantMessageId?:string;promptSha256?:string;bindings?:{imageFileId:string;bytesSha256?:string;size?:number;mime?:string}[]};
export function nativeImageFileId(value:string|undefined){try{const url=new URL(value||'');return url.origin==='https://chatgpt.com'&&/^\/backend-api\/estuary\/content(?:\/|$)/.test(url.pathname)?url.searchParams.get('id')||url.searchParams.get('file_id')||url.pathname.split('/content/')[1]||'':'';}catch{return '';}}
export function verifyNativeImageResult(turn:BridgeTurn,proof:NativeImageProof,promptSha256:string){
  if(proof.status!=='matched_complete'||proof.requestId!==turn.id||proof.promptSha256!==promptSha256||proof.conversationId!==turn.output?.response?.session?.id||proof.assistantMessageId!==turn.output?.response?.turnKey||!proof.bindings?.length)throw new BridgeError('INVALID','原生来源证明与最终网页回复不匹配。');
  const artifacts=turn.output?.artifacts??[];
  if(artifacts.length!==proof.bindings.length||new Set(proof.bindings.map(b=>b.imageFileId)).size!==proof.bindings.length||artifacts.some(a=>!proof.bindings!.some(b=>b.imageFileId===nativeImageFileId(a.url)&&/^[a-f0-9]{64}$/.test(b.bytesSha256||''))))throw new BridgeError('INVALID','原生原图证明与最终文件不匹配。');
}
export function generatedTurnImages(turn:BridgeTurn,turnId:string,count:number,sourceClientId?:string){
  const response=turn.output?.response;
  if(turn.id!==turnId||turn.status!=='completed'||response?.requestId!==turnId||!response.turnKey||!response.session?.id||!response.sourceClientId||sourceClientId&&response.sourceClientId!==sourceClientId)throw new BridgeError('INVALID','网页结果缺少当前任务的来源凭据，未导入。');
  // The canonical bridge projection strips generatedImage and sessionId. A generated
  // gallery image still carries its request, native reply key and owning client.
  const artifacts=(turn.output?.artifacts??[]).filter(item=>item.kind==='image'&&(item.generatedImage===true||item.generatedImage===undefined&&item.blockTestId==='generated-image-preview'));
  if(artifacts.length!==count||new Set(artifacts.map(item=>item.id)).size!==count)throw new BridgeError('INVALID','网页实际原图数量与任务不符，未导入。');
  for(const image of artifacts){
    if(!image.id||image.kind!=='image'||image.phase!=='READY'||image.downloadable!==true||!['image/png','image/jpeg','image/webp'].includes(image.mime)||image.requestId!==turnId||image.sourceTurnKey!==response.turnKey||image.sessionId!==undefined&&image.sessionId!==response.session.id||image.sourceClientId!==response.sourceClientId)throw new BridgeError('INVALID','候选原图与当前网页回复不匹配，未导入。');
  }
  const url=response.url;
  if(!url||!/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(url)||url.split('/').pop()!==response.session.id)throw new BridgeError('INVALID','网页生成会话身份无效，未导入。');
  return {artifacts,url};
}
export class BridgeClient{
  constructor(private config:BridgeConfig){const url=new URL(config.baseUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new BridgeError('INVALID','桥接必须使用本机回环地址。');}
  private async request(route:string,body?:unknown,timeoutMs=15000){
    let response:Response;
    try{response=await fetch(this.config.baseUrl+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.config.apiToken}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}catch{throw new BridgeError('OFFLINE','Chrome 桥接暂时离线；已提交任务不会重发。');}
    if(!response.ok){await response.body?.cancel();throw new BridgeError(response.status===404?'MISSING':'HTTP',response.status===404?'当前网页任务不存在，请人工核对网页；不会自动重发。':'Chrome 桥接请求未成功，请查看本地桥接状态。');}
    return response;
  }
  private async json<T>(route:string,body?:unknown,timeoutMs=15000):Promise<T>{
    try{return JSON.parse((await bounded(await this.request(route,body,timeoutMs),maxJson)).toString('utf8')) as T;}catch(error){if(error instanceof BridgeError)throw error;throw new BridgeError('INVALID','Chrome 桥接返回格式无效。');}
  }
  health(){return this.json<BridgeHealth>('/health');}
  async browserAvailability(){
    const result=await this.json<{ok:boolean;clients?:BrowserClient[]}>('/browser/clients');
    if(!result.ok||!Array.isArray(result.clients))throw new BridgeError('INVALID','无法核对浏览器执行状态。');
    const usable=result.clients.filter(client=>client.ready&&client.compatible!==false&&!client.quarantined&&!client.activeRequest);
    const opener=usable.find(client=>client.selected)??(usable.length===1?usable[0]:undefined);
    return {clients:result.clients,opener,quarantined:result.clients.some(client=>client.quarantined)};
  }
  async taskBrowser(id:string,allowOpen:boolean,active=false){
    const launchToken=`director3008-${id}`;
    const existing=await this.browserAvailability();
    const matching=existing.clients.filter(client=>client.launchToken===launchToken);
    if(matching.length>1)throw new BridgeError('INVALID','任务标签页身份存在冲突。');
    if(matching.length===1){const client=matching[0];if(!client.ready||client.compatible===false||client.quarantined)throw new BridgeError('OFFLINE','任务标签页尚未就绪或已被锁定。');return client.id;}
    if(!allowOpen)throw new BridgeError('MISSING','任务标签页创建回执未确认，请检查 Chrome；不会自动重复打开或发送。');
    if(!existing.opener)throw new BridgeError('OFFLINE','没有可执行的 Chrome 标签页；请新开 ChatGPT 标签页并连接 Bridge。');
    const opened=await this.json<{ok:boolean;launchToken?:string;client?:BrowserClient}>('/browser/tabs/open',{url:'https://chatgpt.com/',sourceClientId:existing.opener.id,active,select:false,launchToken,timeoutMs:12000,allowSystemFallback:false});
    if(!opened.ok||opened.launchToken!==launchToken||opened.client?.launchToken!==launchToken||!opened.client.id||!opened.client.ready||opened.client.compatible===false)throw new BridgeError('INVALID','任务标签页创建身份未确认。');
    return opened.client.id;
  }
  async emptyImagePreflight(sourceClientId:string){
    const recovered=await this.json<{result?:{url?:string;sourceClientId?:string;reconciliation?:{source?:string;status?:string;version?:number;proofVersion?:number}}}>('/browser/recover-latest',{sourceClientId,index:1,timeoutMs:10000,reconcileConversation:{mode:'image_preflight'}});
    const r=recovered.result;
    if(r?.sourceClientId!==sourceClientId||r.url!=='https://chatgpt.com/'||r.reconciliation?.source!=='browser-empty-preflight'||r.reconciliation.version!==1||r.reconciliation.status!=='matched_empty')throw new BridgeError('INVALID','新建生图会话未通过空白检查，未发送。');
    if(r.reconciliation.proofVersion!==2)throw new BridgeError('INVALID','Chrome 扩展需要加载新版原图接收模块；尚未发送生图。');
    return r.reconciliation;
  }
  async confirmImageRecord(id:string,sourceClientId:string,promptSha256:string,imageCount:number){
    const browsers=await this.browserAvailability();const source=browsers.clients.find(c=>c.id===sourceClientId&&c.launchToken===`director3008-${id}`);
    const conversationId=source?.session?.id;if(!source?.ready||!conversationId)return null;
    const recovered=await this.json<{result?:{sourceClientId?:string;reconciliation?:NativeImageProof}}>('/browser/recover-latest',{sourceClientId,index:1,timeoutMs:40000,reconcileConversation:{mode:'image_record_v1',requestId:id,conversationId,promptSha256,imageCount}},45000);
    const r=recovered.result,proof=r?.reconciliation;
    if(r?.sourceClientId!==sourceClientId||!proof||proof.requestId!==id||proof.conversationId!==conversationId||proof.promptSha256!==promptSha256)throw new BridgeError('INVALID','原生图片记录凭据与任务不一致。');
    return proof;
  }
  async uploadReference(reference:{path:string;sha256:string;name:string;mime:string}){
    const info=await lstat(reference.path);if(!info.isFile()||info.isSymbolicLink()||info.size>maxImage||digest(await readFile(reference.path))!==reference.sha256)throw new BridgeError('INVALID','绑定参考图校验失败，未发送任务。');
    const result=await this.json<{ok:boolean;file?:{id?:string}}>('/files/from-path',{path:reference.path,name:reference.name,mime:reference.mime});
    if(!result.ok||!result.file?.id)throw new BridgeError('INVALID','参考图上传未确认。');return result.file.id;
  }
  async submitTurn(id:string,message:string,attachments:string[],projectId:string,sourceClientId?:string){
    // A caller-supplied stable turn id is also the upstream request id. Never retry POST here.
    const response=await fetch(this.config.baseUrl+'/turns',{method:'POST',headers:{Authorization:`Bearer ${this.config.apiToken}`,'Content-Type':'application/json','Idempotency-Key':`director3008:${id}`},body:JSON.stringify({id,message,attachments,newSession:!sourceClientId,...(sourceClientId?{sourceClientId}:{}),metadata:{jobId:id,projectId}}),redirect:'error',signal:AbortSignal.timeout(15000)}).catch(()=>{throw new BridgeError('OFFLINE','提交回执尚未确认；只查询原任务，不重新发送。');});
    if(!response.ok){await response.body?.cancel();throw new BridgeError('HTTP','提交结果未确认；只查询原任务，不重新发送。');}
    const result=JSON.parse((await bounded(response,maxJson)).toString('utf8')) as {ok:boolean;turn?:BridgeTurn};
    if(!result.ok||result.turn?.id!==id)throw new BridgeError('INVALID','提交回执身份不匹配。');return result.turn;
  }
  async turn(id:string){const result=await this.json<{ok:boolean;turn?:BridgeTurn}>(`/turns/${encodeURIComponent(id)}`);if(!result.ok||result.turn?.id!==id)throw new BridgeError('INVALID','网页任务身份不匹配。');return result.turn;}
  async download(image:BridgeArtifact,directory:string){
    const response=await this.request(`/artifacts/${encodeURIComponent(image.id)}/download`);
    const mime=response.headers.get('content-type')?.split(';')[0].trim();
    if(mime!==image.mime){await response.body?.cancel();throw new BridgeError('INVALID','原图下载格式与结果不匹配。');}
    const bytes=await bounded(response,maxImage);if(!bytes.length||image.size&&image.size!==bytes.length)throw new BridgeError('INVALID','原图下载不完整。');
    const sha256=digest(bytes),suffix=({ 'image/png':'png','image/jpeg':'jpg','image/webp':'webp'} as Record<string,string>)[image.mime];
    if(!suffix)throw new BridgeError('INVALID','原图格式不支持。');
    const filename=path.join(directory,createHash('sha256').update(image.id).digest('hex')+'.'+suffix);
    try{await writeFile(filename,bytes,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||digest(await readFile(filename))!==sha256)throw new BridgeError('INVALID','已保存原图发生冲突，请人工核对。');}
    if(digest(await readFile(filename))!==sha256)throw new BridgeError('INVALID','原图落盘校验失败。');
    return {path:filename,sha256,size:bytes.length};
  }
}
