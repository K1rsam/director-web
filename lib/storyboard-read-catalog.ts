import {readdir,stat} from 'node:fs/promises';
import path from 'node:path';

type RunDocument=Record<string,any>;
type Scope={projectId?:string;episodeId?:string};
type Header=Scope&{id:string};
type Source={directory:string;read:(id:string)=>Promise<RunDocument>};
const matches=(value:Scope,scope:Scope)=>(!scope.projectId||value.projectId===scope.projectId)&&(!scope.episodeId||value.episodeId===scope.episodeId);

/** Cache only file membership, never a document, result, freshness decision or permission. */
function catalogue(source:Source){
 const directory=path.join(source.directory,'documents'),known=new Map<string,{signature:string;header:Header}>();
 let pending:Promise<Header[]>|undefined;
 const signature=async(id:string)=>{
  const value=await stat(path.join(directory,id+'.json'),{bigint:true});
  return [value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(':');
 };
 return ()=>pending??=(async()=>{
  const names=(await readdir(directory).catch((error:NodeJS.ErrnoException)=>error.code==='ENOENT'?[]:Promise.reject(error))).filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5));
  const present=new Set(names);for(const id of known.keys())if(!present.has(id))known.delete(id);
  const headers:Header[]=[];
  // ponytail: eight bounded reads during cold discovery; settled documents are not retained in RAM.
  for(let start=0;start<names.length;start+=8)headers.push(...await Promise.all(names.slice(start,start+8).map(async id=>{
   const before=await signature(id),saved=known.get(id);
   if(saved?.signature===before)return saved.header;
   const document=await source.read(id),header:Header={id,projectId:document.web?.binding?.projectId,episodeId:document.web?.binding?.episodeId};
   // An atomic replacement during discovery cannot cache the old binding under a new file version.
   if(await signature(id)===before)known.set(id,{signature:before,header});else known.delete(id);
   return header;
  })));
  return headers;
 })().finally(()=>{pending=undefined;});
}

/** Existing active/legacy precedence, with scoped disk reads rather than a full-body repository scan. */
export function createStoryboardReadCatalog(current:Source,archive:Source){
 const currentHeaders=catalogue(current),archiveHeaders=catalogue(archive);
 return async(scope:Scope={}):Promise<RunDocument[]>=>{
  const active=await currentHeaders(),activeIds=new Set(active.map(header=>header.id)),prior=await archiveHeaders();
  const documents=await Promise.all([
   ...active.filter(header=>matches(header,scope)).map(header=>current.read(header.id)),
   ...prior.filter(header=>!activeIds.has(header.id)&&matches(header,scope)).map(async header=>{
    const document=await archive.read(header.id);return {...document,web:{...document.web,legacyReadOnly:true}};
   })
  ]);
  // Headers choose candidates only. Fresh documents remain authoritative after a concurrent write.
  return documents.filter(document=>matches(document.web?.binding??{},scope));
 };
}
