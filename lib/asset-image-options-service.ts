import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {prisma} from './prisma';
import {loadLatestStoredFoundationDocument} from './foundation-document';
import {emptyImageOptions,normalizeImageOptions,imageTemplatesFor,IMAGE_QUALITIES,IMAGE_RATIOS,type AssetImageOptions,type AssetReferenceImage} from './asset-image-options';
export const IMAGE_OPTIONS_KEY='ASSET_IMAGE_OPTIONS_V1';
const optionsId=(projectId:string,key:string)=>`ai15_${createHash('sha256').update(JSON.stringify([projectId,key])).digest('hex').slice(0,40)}`;
const root=()=>path.resolve(process.env.DIRECTOR_ASSET_REFERENCE_DIR||'outputs/asset-references');
export async function readImageOptions(projectId:string,key:string){const row=await prisma.sceneSnapshot.findUnique({where:{id:optionsId(projectId,key)}});return row?normalizeImageOptions(JSON.parse(row.content) as AssetImageOptions):emptyImageOptions();}
async function assetType(projectId:string,key:string){const doc=await loadLatestStoredFoundationDocument(prisma,projectId);const asset=doc?.f2?.assets.find(a=>a.key===key||a.variants.some(v=>v.key===key));if(!asset)throw new Error('该资产不在当前目录中，请刷新。');return asset.type;}
async function writeOptions(projectId:string,key:string,expected:number,next:AssetImageOptions){
 if(!Number.isSafeInteger(expected)||expected<0)throw new Error('无效的设置版本。');
 const id=optionsId(projectId,key),row=await prisma.sceneSnapshot.findUnique({where:{id}});
 if(!row){if(expected!==0)throw new Error('设置已更新，请刷新。');try{await prisma.sceneSnapshot.create({data:{id,projectId,sceneKey:IMAGE_OPTIONS_KEY,title:key,content:JSON.stringify(next)}});}catch{throw new Error('另一窗口已更新设置，请刷新。');}}
 else{if(JSON.parse(row.content).revision!==expected)throw new Error('另一窗口已更新设置，请刷新。');const result=await prisma.sceneSnapshot.updateMany({where:{id,content:row.content},data:{content:JSON.stringify(next)}});if(result.count!==1)throw new Error('设置刚被更新，请刷新。');}
 return next;
}
export async function saveImageTemplate(projectId:string,key:string,revision:number,templateId:string,templateText:string,quality?:AssetImageOptions['quality'],aspectRatio?:AssetImageOptions['aspectRatio'],count?:number){
 const type=await assetType(projectId,key);if(!imageTemplatesFor(type).some(t=>t.id===templateId))throw new Error('此模板不适用于当前资产类型。');
 if(typeof templateText!=='string'||templateText.length>8000)throw new Error('模板内容请控制在8000字以内。');
 if(count!==undefined&&(!Number.isSafeInteger(count)||count<1||count>4))throw new Error('请选择1至4张。');
 if(quality!==undefined&&!IMAGE_QUALITIES.includes(quality))throw new Error('请选择有效画质。');
 if(aspectRatio!==undefined&&!IMAGE_RATIOS.includes(aspectRatio))throw new Error('请选择有效比例。');
 const current=await readImageOptions(projectId,key);return writeOptions(projectId,key,revision,{...current,revision:revision+1,templateId,templateText:templateId==='none'?'':templateText,count:count??current.count??1,quality:quality??current.quality??'1K',aspectRatio:aspectRatio??current.aspectRatio??'16:9'});
}
export async function uploadAssetReference(projectId:string,key:string,revision:number,file:File){
 await assetType(projectId,key);const current=await readImageOptions(projectId,key);
 if(current.revision!==revision)throw new Error('设置已更新，请刷新后上传。');
 if(current.references.length>=6)throw new Error('首版每项资产最多保存6张参考图。');
 if(file.size===0||file.size>10*1024*1024)throw new Error('请选择不超过10 MB的PNG、JPEG或WebP图片。');
 const bytes=Buffer.from(await file.arrayBuffer());
 let meta:Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
 try{meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();if(!['png','jpeg','webp'].includes(meta.format??'')||!meta.width||!meta.height||(meta.pages??1)>1)throw new Error();await sharp(bytes,{limitInputPixels:40_000_000}).stats();}catch{throw new Error('图片无法读取；请使用有效的静态PNG、JPEG或WebP，且不超过4000万像素。');}
 const image:AssetReferenceImage={id:randomUUID(),name:file.name.slice(0,160),mime:`image/${meta.format}`,size:bytes.length,width:meta.width!,height:meta.height!};
 await mkdir(root(),{recursive:true});await writeFile(path.join(root(),image.id),bytes,{flag:'wx'});
 return writeOptions(projectId,key,revision,{...current,revision:revision+1,references:[...current.references,image]});
}
export async function removeAssetReference(projectId:string,key:string,revision:number,id:string){
 await assetType(projectId,key);const current=await readImageOptions(projectId,key);
 if(!current.references.some(r=>r.id===id))throw new Error('参考图已移除，请刷新。');
 // Only detach; retained files remain recoverable in the local reference directory.
 return writeOptions(projectId,key,revision,{...current,revision:revision+1,references:current.references.filter(r=>r.id!==id)});
}
export async function readAssetReference(projectId:string,key:string,id:string){
 const current=await readImageOptions(projectId,key),reference=current.references.find(r=>r.id===id);
 if(!reference||!/^[-a-f0-9]{36}$/.test(id))return null;
 return {reference,bytes:await readFile(path.join(root(),id))};
}
