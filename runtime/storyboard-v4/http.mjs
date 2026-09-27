const error=(status,message,code='INPUT')=>Object.assign(new Error(message),{status,code});
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const modes=['off','all','recommended','review'];
const keys={create:['settings','notes','maxCalls','maxTokens'],start:['mode'],replan:[],pause:[],stop:[],acknowledge_cancel:['attemptId','acceptUnknownUsage'],choice:['mode','overrides','unitOverrides','expectedFingerprint','resetDrafts'],confirm:['selectedIds','expectedFingerprint','resetDrafts'],repair:['packageIds','notes'],recover:['attemptId'],recheck:['candidateId'],budget:['maxCalls','maxTokens']};
const safeId=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(x);
const stringList=x=>Array.isArray(x)&&x.length<=500&&x.every(s=>typeof s==='string'&&s.length>0&&s.length<=150)&&new Set(x).size===x.length;
export function assertEpisodeBinding(run,episode){if(run?.web?.binding?.episodeId!==episode.id||run.web.binding.projectId!==episode.projectId)throw error(404,'任务不存在','NOT_FOUND');}
export async function readCommand(request){
 if(request.headers.get('x-storyboard-action')!=='1')throw error(403,'缺少本地操作确认','LOCAL_HEADER');
 // Next can reconstruct request.url with localhost while the browser uses 127.0.0.1.
 const internal=new URL(request.url),authority=request.headers.get('host')||internal.host;
 let publicUrl;try{publicUrl=new URL(`${internal.protocol}//${authority}`);}catch{throw error(403,'无效本机来源','ORIGIN');}
 if(!['localhost','127.0.0.1','[::1]'].includes(publicUrl.hostname)||publicUrl.username||publicUrl.password||publicUrl.pathname!=='/')throw error(403,'仅允许本机来源','ORIGIN');
 const origin=request.headers.get('origin');if(origin&&origin!==publicUrl.origin)throw error(403,'不允许跨来源操作','ORIGIN');
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')||''))throw error(415,'仅接收JSON');
 const reader=request.body?.getReader();let bytes=0;const chunks=[];
 if(reader)while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>65536){await reader.cancel();throw error(413,'请求超过64KiB，未截断');}chunks.push(value);}
 let b;try{b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw error(400,'请求须为有效JSON');}
 if(!object(b)||!Object.hasOwn(keys,b.action))throw error(400,'未知操作');
 const allowed=['action',...(b.action==='create'?[]:['runId']),...keys[b.action]];
 if(Object.keys(b).some(k=>!allowed.includes(k)))throw error(400,'包含本操作不接受的字段');
 if(b.action!=='create'&&!safeId(b.runId))throw error(400,'任务编号无效');
 for(const k of ['maxCalls','maxTokens'])if(b[k]!==undefined&&(!Number.isSafeInteger(b[k])||b[k]<0||b[k]>(k==='maxCalls'?128:2000000)))throw error(400,'预算范围无效');
 if(b.notes!==undefined&&(typeof b.notes!=='string'||b.notes.length>4000||b.notes.includes('\0')))throw error(400,'备注须为4000字以内文本');
 if(b.action==='create'){
  b.settings??={maxUnitSeconds:30,fantasyMode:'recommended'};
  if(!object(b.settings)||Object.keys(b.settings).some(k=>!['maxUnitSeconds','fantasyMode'].includes(k))||![15,30].includes(b.settings.maxUnitSeconds??30)||!modes.includes(b.settings.fantasyMode??'recommended'))throw error(400,'单元容量或幻想模式无效');
 }
 if(b.action==='start'&&!['next','all'].includes(b.mode))throw error(400,'执行方式无效');
 if(b.action==='repair'&&(!stringList(b.packageIds)||!b.packageIds.length||!b.notes?.trim()))throw error(400,'请选择返修范围并描述问题');
 if(b.action==='confirm'&&(!stringList(b.selectedIds)||typeof b.expectedFingerprint!=='string'||!b.expectedFingerprint))throw error(400,'确认范围或版本无效');
 if(b.mode!==undefined&&b.action==='choice'&&!modes.includes(b.mode))throw error(400,'幻想模式无效');
 if(b.expectedFingerprint!==undefined&&(typeof b.expectedFingerprint!=='string'||b.expectedFingerprint.length>100))throw error(400,'确认版本无效');
 for(const k of ['overrides','unitOverrides'])if(b[k]!==undefined&&(!object(b[k])||Object.entries(b[k]).some(([id,value])=>!id||id.length>150||typeof value!=='boolean')))throw error(400,'勾选值必须为是或否');
 if(b.resetDrafts!==undefined&&typeof b.resetDrafts!=='boolean')throw error(400,'重做确认无效');
 for(const k of ['attemptId','candidateId'])if(b[k]!==undefined&&!safeId(b[k]))throw error(400,'记录编号无效');
 if(b.action==='recover'&&!safeId(b.attemptId)||b.action==='recheck'&&!safeId(b.candidateId))throw error(400,'缺少记录编号');
 if(b.action==='acknowledge_cancel'&&(!safeId(b.attemptId)||b.acceptUnknownUsage!==true))throw error(400,'须明确确认本次中断用量未知，才能解除未完成请求的阻塞');
 if(b.action==='budget'&&(b.maxCalls===undefined||b.maxTokens===undefined))throw error(400,'请填写完整预算');
 return b;
}
