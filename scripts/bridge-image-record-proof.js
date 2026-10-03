// Browser-side, read-only proof for one image request in an owned fresh conversation.
// Native message and asset IDs come from the current backend branch, never from DOM ordinals.
(() => {
  'use strict';
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalize(value))))].map(v => v.toString(16).padStart(2, '0')).join('');
  const fileId = value => {
    try { const u = new URL(String(value)); if (u.origin === 'https://chatgpt.com' && /^\/backend-api\/estuary\/content(?:\/|$)/.test(u.pathname)) return u.searchParams.get('id') || u.searchParams.get('file_id') || u.pathname.split('/content/')[1] || ''; } catch {}
    return String(value || '').match(/^sediment:\/\/(file[_-][a-zA-Z0-9_-]+)$/)?.[1] || '';
  };
  const nativeKeys = new WeakMap(), nativeImages = new WeakMap(), nativeDownloads = new Map();
  const rawImageSource = image => image.currentSrc || image.src || image.getAttribute?.('src') || '';
  function validImageBinding(image,bound){return Boolean(bound && image.isConnected && location.href===bound.url && rawImageSource(image)===bound.raw && (!bound.valid || bound.valid()));}
  function imageSource(image){const bound=nativeImages.get(image);return validImageBinding(image,bound) ? bound.originalUrl : '';}
  function imageReady(image){const bound=nativeImages.get(image);return bound?.trustedForBackground===true && validImageBinding(image,bound);}
  function imageMetadata(image){const bound=nativeImages.get(image);return validImageBinding(image,bound)?{mime:bound.mime,size:bound.size,bytesSha256:bound.sha256}:null;}
  function downloadBytes(artifact,url){const binding=nativeDownloads.get(fileId(url));if(!binding || !validImageBinding(binding.image,binding) || String(artifact.sourceTurnKey || '')!==binding.assistantMessageId || artifact.requestId && artifact.requestId!==binding.requestId)return null;return {bytes:binding.bytes.slice(),mime:binding.mime,sha256:binding.sha256};}
  const domFingerprint = node => JSON.stringify({text:normalize(node?.innerText || node?.textContent),images:[...new Set([...node.querySelectorAll('img')].map(img=>fileId(imageSource(img)||img.currentSrc||img.src)).filter(Boolean))].sort()});
  function key(node){const bound=nativeKeys.get(node);return bound && node.isConnected && location.href===bound.url && domFingerprint(node)===bound.fingerprint ? bound.id : '';}
  const result = (expected, status, reason, extra = {}) => ({source:'conversation-record',version:1,proofVersion:2,mode:'single-user-image/v1',status,reason,requestId:String(expected.requestId || ''),conversationId:String(expected.conversationId || ''),promptSha256:expected.promptSha256,...extra});
  function branchOf(record, conversationId) {
    if (!record || record.conversation_id !== conversationId || !record.mapping || Array.isArray(record.mapping) || typeof record.current_node !== 'string') return null;
    const branch=[],seen=new Set(),ids=new Set();let key=record.current_node;
    while(key!==null){if(seen.has(key)||branch.length>1000)return null;seen.add(key);const n=record.mapping[key];if(!n||!Object.hasOwn(n,'parent')||n.parent!==null&&typeof n.parent!=='string')return null;if(n.message?.id){if(ids.has(n.message.id))return null;ids.add(n.message.id);}branch.push(n);key=n.parent;}
    return branch;
  }
  function imagePointers(value, output = new Set(), depth=0) {
    if(depth>10||!value||typeof value!=='object')return output;
    if(typeof value.asset_pointer==='string'){const id=fileId(value.asset_pointer);if(id)output.add(id);}
    for(const [key,v] of Object.entries(value)){if(key==='parts'||key==='content'||key==='image')if(v&&typeof v==='object'){if(Array.isArray(v))for(const p of v)imagePointers(p,output,depth+1);else imagePointers(v,output,depth+1);}}
    return output;
  }
  async function nativeBoundary(record, expected, snapshot, facts) {
    const fail = reason => result(expected,'mismatch',reason);
    if(!/^[a-f0-9]{64}$/.test(expected.promptSha256||'')||!Number.isInteger(expected.imageCount)||expected.imageCount<1||expected.imageCount>4)return fail('invalid_expectation');
    if(facts.userCount!==1||facts.assistantCount!==1||await digest(facts.userText)!==expected.promptSha256)return fail('dom_user_boundary');
    if(snapshot.stopVisible||snapshot.streamingVisible||snapshot.hasError||snapshot.needsContinue||snapshot.needsConfirmation)return result(expected,'matched_incomplete','dom_generation_not_complete');
    const branch=branchOf(record,expected.conversationId);if(!branch)return result(expected,'unavailable','unsupported_branch');
    const users=branch.filter(n=>n.message?.author?.role==='user');if(users.length!==1)return fail('backend_user_boundary');
    const user=users[0].message,parts=user.content?.parts;if(typeof user.id!=='string'||!user.id)return fail('native_user_identity');
    if(!Array.isArray(parts))return result(expected,'unavailable','unsupported_user_content');
    const textParts=parts.filter(p=>typeof p==='string');if(!textParts.length||await digest(textParts.join('\n'))!==expected.promptSha256)return fail('backend_prompt');
    const userIndex=branch.indexOf(users[0]);const outputs=branch.slice(0,userIndex);const assistant=outputs.find(n=>n.message?.author?.role==='assistant')?.message;
    const schemaFacts=outputs.map(n=>({role:n.message?.author?.role,contentType:n.message?.content?.content_type,status:n.message?.status,endTurn:n.message?.end_turn}));
    if(!assistant?.id||assistant.status!=='finished_successfully'||assistant.end_turn!==true||(assistant.recipient&&assistant.recipient!=='all')||(assistant.channel&&assistant.channel!=='final'))return result(expected,'matched_incomplete','backend_generation_not_complete',{schemaFacts});
    const pointers=new Set();for(const n of outputs)if(['assistant','tool'].includes(n.message?.author?.role))imagePointers(n.message.content,pointers);
    if(pointers.size!==expected.imageCount)return result(expected,'mismatch','backend_image_identity',{schemaFacts,backendImageCount:pointers.size});
    return {userMessageId:user.id,assistantMessageId:assistant.id,backendStatus:assistant.status,endTurn:assistant.end_turn,pointers:[...pointers],schemaFacts,currentNode:record.current_node,branchIdentity:branch.map(n=>({parent:n.parent,id:n.message?.id || '',role:n.message?.author?.role || '',status:n.message?.status || '',endTurn:n.message?.end_turn}))};
  }
  async function evaluate(record,expected,snapshot,facts){
    const boundary=await nativeBoundary(record,expected,snapshot,facts);if(boundary.status)return boundary;
    const {pointers,schemaFacts,...identity}=boundary;
    const artifacts=(snapshot.artifacts||[]).filter(a=>a.kind==='image'&&a.generatedImage===true);const bindings=artifacts.map(a=>({artifactId:a.id,imageFileId:fileId(a.downloadUrl||a.src||a.url)}));
    if(artifacts.length!==expected.imageCount||bindings.some(b=>!b.artifactId||!b.imageFileId)||new Set(bindings.map(b=>b.artifactId)).size!==expected.imageCount||new Set(bindings.map(b=>b.imageFileId)).size!==expected.imageCount)return result(expected,'mismatch','dom_image_identity',{schemaFacts,backendImageCount:pointers.length,domImageCount:bindings.length,backendImageIds:expected.mode==='image_record_probe'?[...pointers]:undefined,domSourceKinds:expected.mode==='image_record_probe'?artifacts.map(a=>String(a.downloadUrl||a.src||a.url).slice(0,75)):undefined});
    if(bindings.some(b=>!pointers.includes(b.imageFileId)))return result(expected,'mismatch','backend_image_identity',{schemaFacts,backendImageCount:pointers.length,domImageCount:bindings.length});
    return result(expected,expected.mode==='image_record_probe'?'diagnostic_only':'matched_complete','exact_single_user_image_branch',{...identity,bindings});
  }
  function preflight(){const dom=globalThis.ChatGptTurnDom.createTurnDom();const empty=location.pathname==='/'&&dom.getTurnNodes().length===0;return {source:'browser-empty-preflight',version:1,proofVersion:2,status:empty?'matched_empty':'mismatch',reason:empty?'new_empty_chat':'chat_not_empty',checkedAt:Date.now()};}
  async function read(expected,snapshot,deps={}) {
    const unavailable=reason=>result(expected,'unavailable',reason);
    if(expected.mode!=='image_record_probe'&&(!expected.requestId||deps.getActiveRequest?.()?.requestId!==expected.requestId))return unavailable('active_request_identity');
    const page=new URL(location.href);if(page.origin!=='https://chatgpt.com'||page.pathname!==`/c/${expected.conversationId}`)return unavailable('page_conversation_changed');
    const identity=()=>{const request=deps.getActiveRequest?.();return {requestId:request?.requestId || '',leaseId:request?.leaseId || '',ownerServerInstanceId:request?.ownerServerInstanceId || '',responseEpoch:Number(request?.responseEpoch || 0),contentEpoch:String(deps.getContentEpoch?.() || '')};};
    const initialIdentity=identity(),sameIdentity=()=>JSON.stringify(identity())===JSON.stringify(initialIdentity);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000),cancel=()=>controller.abort();deps.signal?.addEventListener('abort',cancel,{once:true});if(deps.signal?.aborted)cancel();
    let authHeaders,readStage='record';const options={method:'GET',credentials:'include',cache:'no-store',redirect:'error',signal:controller.signal};
    try {
      const dom=globalThis.ChatGptTurnDom.createTurnDom(),turns=dom.getTurnNodes(),users=turns.filter(n=>dom.role(n)==='user'),assistants=turns.filter(n=>dom.role(n)==='assistant');
      const facts={userCount:users.length,assistantCount:assistants.length,userText:users[0]?.innerText||users[0]?.textContent||'',assistantText:normalize(assistants[0]?.innerText||assistants[0]?.textContent)};
      if(facts.userCount!==1||facts.assistantCount!==1||await digest(facts.userText)!==expected.promptSha256)return result(expected,'mismatch','dom_user_boundary');
      const endpoint=`${page.origin}/backend-api/conversation/${encodeURIComponent(expected.conversationId)}`;let response=await fetch(endpoint,options);
      if([401,403,404].includes(response.status)){const session=await fetch(`${page.origin}/api/auth/session`,options);if(!session.ok)return unavailable('authentication_unavailable');const token=(await session.json())?.accessToken;if(typeof token!=='string'||!token)return unavailable('authentication_unavailable');authHeaders={Authorization:`Bearer ${token}`};response=await fetch(endpoint,{...options,headers:authHeaders});}
      if(!response.ok)return unavailable(`http_${response.status}`);
      const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024){await reader.cancel();return unavailable('record_limit');}chunks.push(value);}}finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const record=JSON.parse(new TextDecoder().decode(bytes));
      const byteDigest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
      const recordSha256=await byteDigest(bytes);
      if(location.href!==page.href)return unavailable('page_conversation_changed');
      const boundary=await nativeBoundary(record,expected,snapshot,facts);
      if(!boundary.status){
        const generatedImages=[...assistants[0].querySelectorAll('img')].filter(img=>img.closest?.('[data-testid="generated-image-gallery"]'));
        if(boundary.pointers.length===1&&generatedImages.length===1&&expected.imageCount===1){
          const image=generatedImages[0],raw=rawImageSource(image),nativeId=boundary.pointers[0];
          const isBlob=/^blob:https:\/\/chatgpt\.com\//.test(raw);
          const nativeOnly=expected.mode!=='image_record_probe' && !raw && Number(image.naturalWidth || 0)===0 && Number(image.naturalHeight || 0)===0;
          const strongIdentity=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expected.requestId) && normalize(facts.userText).includes('任务关联码：'+expected.requestId+'。') && initialIdentity.requestId===expected.requestId && initialIdentity.leaseId && initialIdentity.ownerServerInstanceId && initialIdentity.contentEpoch && initialIdentity.responseEpoch===0;
          const directNative=expected.mode!=='image_record_probe' && fileId(raw)===nativeId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expected.requestId);
          if(nativeOnly&&!strongIdentity)return unavailable('native_source_identity');
          if(directNative&&!strongIdentity)return unavailable('native_source_identity');
          if((isBlob||nativeOnly||directNative)&&!imageSource(image)){
            if(!authHeaders){const session=await fetch(page.origin+'/api/auth/session',options);const token=session.ok?(await session.json()).accessToken:'';if(!token)return unavailable('authentication_unavailable');authHeaders={Authorization:'Bearer '+token};}
            readStage='native_file_link';const link=await fetch(page.origin+'/backend-api/files/download/'+encodeURIComponent(nativeId)+'?conversation_id='+encodeURIComponent(expected.conversationId)+'&inline=false',{...options,headers:authHeaders});
            if(!link.ok)return unavailable('native_file_http_'+link.status);const originalUrl=(await link.json()).download_url;
            if(fileId(originalUrl)!==nativeId)return unavailable('native_file_identity');
            const binary=async response=>{const mime=(response.headers.get('content-type')||'').split(';')[0].trim();if(!response.ok||!['image/png','image/jpeg','image/webp'].includes(mime)||Number(response.headers.get('content-length')||0)>20*1024*1024)throw Error('image response');const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20*1024*1024){await reader.cancel();throw Error('image limit');}chunks.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const magic=mime==='image/png'?bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71&&bytes[4]===13&&bytes[5]===10&&bytes[6]===26&&bytes[7]===10:mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes[0]===82&&bytes[1]===73&&bytes[2]===70&&bytes[3]===70&&bytes[8]===87&&bytes[9]===69&&bytes[10]===66&&bytes[11]===80;if(size<12||!magic)throw Error('image signature');return {bytes,mime,size,sha256:await byteDigest(bytes)};};
            readStage='image_bytes';const native=await fetch(originalUrl,{...options,headers:authHeaders}).then(binary);
            if(isBlob){const domBytes=await fetch(raw,{signal:controller.signal}).then(binary);if(domBytes.sha256!==native.sha256)return unavailable('blob_original_bytes_differ');}
            if(location.href!==page.href||rawImageSource(image)!==raw||!image.isConnected)return unavailable('image_changed_during_download');
            if(!sameIdentity())return unavailable('active_request_identity');
            // Re-read the authenticated current branch after the bytes arrive.
            // A valid file link alone cannot prove that this is still the task's branch.
            readStage='record_recheck';const reread=await fetch(endpoint,{...options,...(authHeaders?{headers:authHeaders}:{})});
            if(!reread.ok)return unavailable('record_recheck_http');
            const reReader=reread.body.getReader(),reChunks=[];let reSize=0;try{while(true){const {done,value}=await reReader.read();if(done)break;reSize+=value.length;if(reSize>4*1024*1024){await reReader.cancel();return unavailable('record_limit');}reChunks.push(value);}}finally{reReader.releaseLock();}
            const reBytes=new Uint8Array(reSize);let reOffset=0;for(const chunk of reChunks){reBytes.set(chunk,reOffset);reOffset+=chunk.length;}
            const reBoundary=await nativeBoundary(JSON.parse(new TextDecoder().decode(reBytes)),expected,snapshot,facts);
            if(reBoundary.status||JSON.stringify(reBoundary)!==JSON.stringify(boundary))return unavailable('native_branch_changed');
            if(!sameIdentity()||location.href!==page.href||rawImageSource(image)!==raw||!image.isConnected)return unavailable('image_changed_during_download');
            const stillCurrent=()=>sameIdentity() && users[0].isConnected && assistants[0].isConnected && normalize(users[0].innerText||users[0].textContent)===normalize(facts.userText) && normalize(assistants[0].innerText||assistants[0].textContent)===facts.assistantText && dom.getTurnNodes().length===turns.length && dom.getTurnNodes().every((n,i)=>n===turns[i]);
            if(!stillCurrent())return unavailable('dom_changed_during_proof');
            const binding={image,raw,url:page.href,originalUrl,...native,recordSha256,recordRecheckSha256:await byteDigest(reBytes),requestId:expected.requestId,assistantMessageId:boundary.assistantMessageId,proofSource:nativeOnly?'native_record_download':directNative?'dom_native_url_download':'dom_blob_bytes_equal',trustedForBackground:Boolean(strongIdentity)&&expected.mode!=='image_record_probe',valid:stillCurrent};
            nativeImages.set(image,binding);nativeDownloads.set(nativeId,binding);while(nativeDownloads.size>4)nativeDownloads.delete(nativeDownloads.keys().next().value);
          }
          const refreshed=deps.readLatestAssistantSnapshot?.(1);if(refreshed)snapshot.artifacts=refreshed.artifacts;
        }
      }
      const proof=await evaluate(record,expected,snapshot,facts);if(expected.mode!=='image_record_probe'&&deps.getActiveRequest?.()?.requestId!==expected.requestId)return unavailable('active_request_identity');if(proof.status==='matched_complete'){
        const current=dom.getTurnNodes();if(current.length!==turns.length||current.some((n,i)=>n!==turns[i])||await digest(users[0].innerText||users[0].textContent)!==expected.promptSha256)return unavailable('dom_changed_during_proof');
        const currentSnapshot=deps.readLatestAssistantSnapshot?.(1);if(!currentSnapshot)return unavailable('snapshot_unavailable');
        const confirmed=await evaluate(record,expected,currentSnapshot,facts);if(confirmed.status!=='matched_complete'||JSON.stringify(confirmed.bindings)!==JSON.stringify(proof.bindings))return unavailable('image_changed_during_proof');
        if(deps.getActiveRequest?.()?.requestId!==expected.requestId)return unavailable('active_request_identity');
        const ids=[...new Set([...assistants[0].querySelectorAll('img')].map(img=>fileId(imageSource(img)||img.currentSrc||img.src)).filter(Boolean))];
        if(ids.length!==proof.bindings.length||proof.bindings.some(b=>!ids.includes(b.imageFileId)))return unavailable('dom_pointer_changed');
        nativeKeys.set(users[0],{id:proof.userMessageId,url:page.href,fingerprint:domFingerprint(users[0])});
        nativeKeys.set(assistants[0],{id:proof.assistantMessageId,url:page.href,fingerprint:domFingerprint(assistants[0])});
        deps.onBound?.();
      }
      const bindings=proof.bindings?.map(binding=>{const native=nativeDownloads.get(binding.imageFileId);return native && validImageBinding(native.image,native)?{...binding,bytesSha256:native.sha256,size:native.size,mime:native.mime,proofSource:native.proofSource,recordSha256:native.recordSha256,recordRecheckSha256:native.recordRecheckSha256}:binding;});
      const proofSource=bindings?.every(b=>b.proofSource==='native_record_download')?'native_record_download':bindings?.every(b=>b.proofSource==='dom_blob_bytes_equal')?'dom_blob_bytes_equal':bindings?.every(b=>b.proofSource==='dom_native_url_download')?'dom_native_url_download':'dom_native_url';
      return {...proof,...(bindings?{bindings}:{}),proofSource,reason:proof.status==='matched_complete'&&proofSource==='native_record_download'?'exact_single_user_native_download':proof.status==='matched_complete'&&proofSource==='dom_blob_bytes_equal'?'exact_single_user_blob_bytes':proof.reason,checkedAt:Date.now()};
    }catch{return unavailable(controller.signal.aborted?'timeout_or_cancelled_'+readStage:'record_unavailable_'+readStage);}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',cancel);}
  }
  globalThis.ChatGptImageRecordProof=Object.freeze({read,evaluate,preflight,digest,fileId,key,imageSource,imageReady,imageMetadata,downloadBytes});
})();
