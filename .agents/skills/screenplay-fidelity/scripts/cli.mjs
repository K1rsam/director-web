import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createSource,normalize} from './fidelity.mjs';
const args=process.argv.slice(2);
const input=args[0],out=args[1];
if(!input||!out){console.error('用法: node scripts/cli.mjs INPUT.txt OUTPUT_DIR [PLAN.json] [TRUSTED_DECISIONS.json]');process.exit(2);}
try {
  if(!['.txt','.md'].includes(extname(input).toLowerCase()))throw new Error('仅支持 UTF-8 txt/md；DOCX 必须先用明确记录版本和警告的读取器提取。');
  const bytes=await readFile(resolve(input));
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  const source=createSource(text);
  const imported=args[2]?JSON.parse(await readFile(resolve(args[2]),'utf8')):undefined;
  const decisions=args[3]?JSON.parse(await readFile(resolve(args[3]),'utf8')):[];
  const result=normalize(source,{plan:imported?.plan??imported,decisions});
  result.originalFile={name:input.split(/[\\/]/).at(-1),byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  result.reader={name:'node.TextDecoder',version:process.version,encoding:'utf-8',warnings:['仅保证相对于读取文本的字符保真；文件字节 hash 独立保存。']};
  await mkdir(resolve(out),{recursive:true});
  await writeFile(join(resolve(out),'original-upload'+extname(input).toLowerCase()),bytes);
  await writeFile(join(resolve(out),'fidelity-import.json'),JSON.stringify(result,null,2),'utf8');
  await writeFile(join(resolve(out),'cleaned.txt'),source.text,'utf8');
  await writeFile(join(resolve(out),'normalized.md'),result.normalizedText,'utf8');
  console.log(JSON.stringify({ok:true,sourceVersion:source.sourceVersion,issues:result.validation.issues.length,output:resolve(out),upload:'fidelity-import.json',plainText:'cleaned.txt',instruction:'将本输出目录压缩成一个ZIP，在3008直接上传；normalized.md只供阅读。'}));
}catch(e){console.error(JSON.stringify({ok:false,error:e.message,validation:e.validation}));process.exit(1);}
