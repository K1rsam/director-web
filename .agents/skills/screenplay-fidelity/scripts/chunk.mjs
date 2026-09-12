import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createSource,proposePlan,validatePlan} from './fidelity.mjs';
const [input,out,limitArg='24000']=process.argv.slice(2);const limit=Number(limitArg);
if(!input||!out||!Number.isInteger(limit)||limit<1){console.error('用法: node scripts/chunk.mjs INPUT.txt OUTPUT_DIR [UTF16_TARGET=24000]');process.exit(2);}
try {
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await readFile(resolve(input)));
 const source=createSource(text),plan=proposePlan(source);const chunks=[];let group=[],length=0;
 const flush=()=>{if(!group.length)return;chunks.push({sourceVersion:source.sourceVersion,coordinateSystem:'utf16',start:group[0].start,end:group.at(-1).end,segments:group.map(s=>({...s,text:text.slice(s.start,s.end)})),oversize:length>limit});group=[];length=0;};
 for(const s of plan.segments){if(length+s.end-s.start>limit)flush();group.push(s);length+=s.end-s.start;}flush();
 await mkdir(resolve(out),{recursive:true});
 for(let i=0;i<chunks.length;i++)await writeFile(join(resolve(out),`chunk-${String(i+1).padStart(4,'0')}.json`),JSON.stringify(chunks[i],null,2));
 await writeFile(join(resolve(out),'manifest.json'),JSON.stringify({sourceVersion:source.sourceVersion,count:chunks.length,target:limit,coverage:validatePlan(source,plan).coverage,warnings:chunks.some(c=>c.oversize)?['存在超长单行：保留完整行，未静默截断；模型调用前需进一步预算处理。']:[]},null,2));
 console.log(JSON.stringify({ok:true,chunks:chunks.length}));
}catch(e){console.error(e.message);process.exit(1);}
