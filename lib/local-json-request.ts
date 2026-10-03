/** Bounded browser transport; never rewrites source bytes or business decisions. */
export class LocalRequestError extends Error {
  readonly code='LOCAL_REQUEST_INVALID';
  readonly requestOutcome='NOT_SENT';
  constructor(message:string,readonly status:number){super(message);}
}

export function hasSameLocalOrigin(request:Request):boolean {
  try {
    const internal=new URL(request.url),authority=request.headers.get('host')??internal.host;
    // Next can reconstruct localhost while the browser uses 127.0.0.1.
    // Never use client-controlled forwarded headers or ignore the port.
    const local=new URL(`${internal.protocol}//${authority}`);
    return ['http:','https:'].includes(local.protocol)
      &&['localhost','127.0.0.1','[::1]'].includes(local.hostname)
      &&local.host===authority&&!local.username&&!local.password
      &&local.pathname==='/'&&!local.search&&!local.hash
      &&request.headers.get('origin')===local.origin;
  } catch {return false;}
}

async function readBoundedBytes(request:Request,maxBytes:number) {
  const length=request.headers.get('content-length');
  if(length!==null&&!/^\d+$/.test(length))throw new LocalRequestError('请求长度无效。',400);
  if(length!==null&&Number(length)>maxBytes){await request.body?.cancel().catch(()=>{});throw new LocalRequestError('操作请求过长，请只提交对应的局部内容。',413);}
  const reader=request.body?.getReader();
  if(!reader)throw new LocalRequestError('请求内容无法读取。',400);
  const chunks:Uint8Array[]=[];let total=0;
  try {
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      total+=value.byteLength;
      if(total>maxBytes)throw new LocalRequestError('操作请求过长，请只提交对应的局部内容。',413);
      chunks.push(value);
    }
  } catch(error){
    await reader.cancel().catch(()=>{});
    if(error instanceof LocalRequestError)throw error;
    throw new LocalRequestError('请求读取中断，未执行操作。',400);
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}

// Like Request.json(), command field types are validated by the owning service.
// This reader enforces transport and the object envelope, not a business schema.
export async function readLocalJsonObject(request:Request,maxBytes:number):Promise<any> {
  if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw new LocalRequestError('仅接受 JSON 操作请求。',415);
  const bytes=await readBoundedBytes(request,maxBytes);
  let input;
  try {input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch {throw new LocalRequestError('请求内容不是有效的 UTF-8 JSON。',400);}
  if(!input||typeof input!=='object'||Array.isArray(input))throw new LocalRequestError('操作内容无效。',400);
  return input;
}

export async function readLocalFormData(request:Request,maxBytes:number):Promise<FormData> {
  const contentType=request.headers.get('content-type')??'';
  if(contentType.split(';',1)[0].trim().toLowerCase()!=='multipart/form-data')throw new LocalRequestError('请使用当前工作台的上传表单。',415);
  const bytes=await readBoundedBytes(request,maxBytes);
  try {return await new Response(bytes,{headers:{'content-type':contentType}}).formData();}
  catch {throw new LocalRequestError('上传表单无法读取，未执行操作。',400);}
}
