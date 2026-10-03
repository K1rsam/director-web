import {createHash} from 'node:crypto';

type Row=Record<string,unknown>;
type Block=[string,string];
type Batch={firstBlock:string;lastBlock:string;index:number;total:number};
type Issue={code:string;message:string;sectionKeys:string[]};
type IssueRuns={code:string;message:string;sectionKeyRuns:Array<string|[string,string]>};
export type P1WireV2=Row&{reviewMode:'FULL_STRUCTURE_BLOCKS_V2';sourceVersion:string;batch:Batch;blocks:Block[];before:string;issues?:Array<Issue|IssueRuns>;baseline:Row[];wireEncoding:{scheme:'BLANK_DEFAULT_VISIBLE_RUNS_V2';defaultBlankText:string;blankExceptions:Block[];expandedJsonHash:string}};

/** Append once immediately before INPUT_JSON for V2 only. Its actual length is
 * included in the compaction decision. The model does not rebuild omitted rows. */
export const P1_WIRE_V2_MODEL_NOTE='本次采用FULL_STRUCTURE_BLOCKS_V2：blocks只展示非空原文，原B编号不重排。batch.firstBlock/lastBlock仍是原始完整批次边界，未列出的编号只含空白；wireEncoding记录默认空白及差异供程序恢复。空白不增加剧情语义，但仍可包含在有据的正文或资料归属范围内，并作为合法起止坐标；不得因未展示空白而缩短或改动assignments、baseline的归属边界。issues.sectionKeyRuns中的[首块,末块]只表示当前可见blocks顺序内的诊断引用闭区间，单个字符串只指该块；它不改变归属范围，不新增区间外的诊断成员。直接阅读可见原文并判断这些范围，无需枚举或还原机械索引；reviewed必须照原batch首尾返回，不改为最后可见块。';

const V1='FULL_STRUCTURE_BLOCKS_V1',V2='FULL_STRUCTURE_BLOCKS_V2',MAX_BLOCKS=100_000,MAX_EXPANDED_CHARS=16_000_000;
const ROOT_KEYS=['reviewMode','sourceVersion','batch','issues','blocks','before','baseline'];
const record=(value:unknown):value is Row=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const own=(value:Row,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const keys=(value:Row,required:string[],allowed=required)=>Object.keys(value).length===Reflect.ownKeys(value).length&&required.every(key=>own(value,key))&&Object.keys(value).every(key=>allowed.includes(key));
function denseArray(value:unknown):value is unknown[]{
 if(!Array.isArray(value)||Object.keys(value).length!==value.length||Reflect.ownKeys(value).length!==value.length+1)return false;
 for(let i=0;i<value.length;i++)if(!Object.prototype.hasOwnProperty.call(value,i))return false;
 return true;
}
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const blockId=(value:unknown):value is string=>typeof value==='string'&&/^B\d{6}$/.test(value)&&Number(value.slice(1))>0;
const idFor=(number:number)=>`B${String(number).padStart(6,'0')}`;
const blank=(value:unknown):value is string=>typeof value==='string'&&value.trim()==='';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const size=(value:unknown)=>JSON.stringify(value).length;
function invalid():never{throw new Error('P1_WIRE_INVALID：紧凑原文证据编码无效，未猜测或改写缺失块。');}
/** Exact JSON UTF-16 size, bounded before allocating a serialized copy. Inputs
 * have the fixed shallow wire schema; lone surrogates follow JSON.stringify. */
function boundedJsonChars(value:unknown):number{
 let chars=0;
 const add=(count:number)=>(chars+=count)<=MAX_EXPANDED_CHARS;
 const visit=(item:unknown):boolean=>{
  if(typeof item==='string'){
   if(!add(item.length+2))return false;
   for(let i=0;i<item.length;i++){
    const code=item.charCodeAt(i);
    if(code===34||code===92||code===8||code===9||code===10||code===12||code===13){if(!add(1))return false;}
    else if(code<32){if(!add(5))return false;}
    else if(code>=0xd800&&code<=0xdbff){const next=item.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff)i++;else if(!add(5))return false;}
    else if(code>=0xdc00&&code<=0xdfff&&!add(5))return false;
   }
   return true;
  }
  if(item===null)return add(4);
  if(typeof item==='number')return Number.isFinite(item)&&add(String(item).length);
  if(Array.isArray(item)){if(!add(item.length?item.length+1:2))return false;for(const row of item)if(!visit(row))return false;return true;}
  if(record(item)){const entries=Object.entries(item);if(!add(entries.length?entries.length+1:2))return false;for(const [key,row]of entries)if(!visit(key)||!add(1)||!visit(row))return false;return true;}
  return false;
 };
 return visit(value)?chars:MAX_EXPANDED_CHARS+1;
}
const issueV1=(value:unknown):value is Issue=>record(value)&&keys(value,['code','message','sectionKeys'])&&typeof value.code==='string'&&typeof value.message==='string'&&denseArray(value.sectionKeys)&&value.sectionKeys.every(blockId);

function common(value:unknown,mode:typeof V1|typeof V2){
 if(!record(value)||value.reviewMode!==mode||!keys(value,['reviewMode','sourceVersion','batch','blocks','before','baseline',...(mode===V2?['wireEncoding']:[])],[...ROOT_KEYS,...(mode===V2?['wireEncoding']:[])])||typeof value.sourceVersion!=='string'||!value.sourceVersion||typeof value.before!=='string')return null;
 const batch=value.batch;
 if(!record(batch)||!keys(batch,['firstBlock','lastBlock','index','total'])||!blockId(batch.firstBlock)||!blockId(batch.lastBlock)||!integer(batch.index)||!integer(batch.total)||batch.total<batch.index)return null;
 const start=Number(batch.firstBlock.slice(1)),end=Number(batch.lastBlock.slice(1));
 if(end<start||end-start+1>MAX_BLOCKS||!denseArray(value.blocks)||value.blocks.length>MAX_BLOCKS||!denseArray(value.baseline)||value.baseline.some(row=>!record(row)||!keys(row,['episodeNumber','firstBlock','lastBlock'])||!blockId(row.firstBlock)||!blockId(row.lastBlock)||!(row.episodeNumber===null||typeof row.episodeNumber==='string'||typeof row.episodeNumber==='number'&&Number.isFinite(row.episodeNumber)))||own(value,'issues')&&!denseArray(value.issues))return null;
 return {value,batch:batch as Batch,start,end};
}

function compactIssue(issue:Issue,positions:Map<string,number>):Issue|IssueRuns{
 const indices=issue.sectionKeys.map(id=>positions.get(id));
 if(indices.some((index,i)=>index===undefined||i>0&&index<=indices[i-1]!))return structuredClone(issue);
 const groups:string[][]=[];
 for(const id of issue.sectionKeys){const previous=groups.at(-1);if(previous&&positions.get(id)===positions.get(previous.at(-1)! )!+1)previous.push(id);else groups.push([id]);}
 const runs:Array<string|[string,string]>=[];
 for(const group of groups){if(group.length>2)runs.push([group[0],group.at(-1)!]);else runs.push(...group);}
 const compact=Object.fromEntries(Object.entries(issue).map(([key,value])=>key==='sectionKeys'?['sectionKeyRuns',runs]:[key,value])) as IssueRuns;
 return size(compact)<size(issue)?compact:structuredClone(issue);
}

/** Pure wire projection. Unknown fields, repairs, sparse/nonstandard IDs and any
 * representation that is not shorter including the model note retain V1 intact. */
export function compactP1WireV2<T>(input:T):T|P1WireV2{
 const checked=common(input,V1);if(!checked)return input;
 const {value,start,end}=checked,rows=value.blocks as unknown[];
 if(rows.length!==end-start+1||rows.some((row,i)=>!denseArray(row)||row.length!==2||row[0]!==idFor(start+i)||typeof row[1]!=='string')||own(value,'issues')&&!(value.issues as unknown[]).every(issueV1)||boundedJsonChars(value)>MAX_EXPANDED_CHARS)return input;
 const blocks=rows as Block[],visible=blocks.filter(([,text])=>!blank(text)),frequencies=new Map<string,number>();
 for(const [,text]of blocks)if(blank(text))frequencies.set(text,(frequencies.get(text)??0)+1);
 const defaultBlankText=[...frequencies].sort((a,b)=>b[1]-a[1])[0]?.[0]??'\n',blankExceptions=blocks.filter(([,text])=>blank(text)&&text!==defaultBlankText),positions=new Map(visible.map(([id],i)=>[id,i]));
 const projected=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='reviewMode'?V2:key==='blocks'?structuredClone(visible):key==='issues'?(item as Issue[]).map(issue=>compactIssue(issue,positions)):structuredClone(item)]));
 const wire={...projected,wireEncoding:{scheme:'BLANK_DEFAULT_VISIBLE_RUNS_V2',defaultBlankText,blankExceptions:structuredClone(blankExceptions),expandedJsonHash:hash(value)}} as P1WireV2;
 if(size(wire)+P1_WIRE_V2_MODEL_NOTE.length+1>=size(value))return input;
 // This is also a byte-order guard: no future optimization may silently change
 // the original V1 object that feeds the existing paid-work fingerprint.
 if(JSON.stringify(expandP1WireEvidence(wire))!==JSON.stringify(value))return input;
 return wire;
}

/** Expand before projectP1ReviewEvidenceRequest / workFingerprint / validation.
 * Unencoded legacy history passes through untouched. This checksum is an integrity guard,
 * not a new paid-work identity or a substitute for canonical-source validation. */
export function expandP1WireEvidence<T>(input:T):T|Row{
 if(!record(input))return input;
 if(input.reviewMode!==V2){
  // A damaged version marker must not bypass decoding and become a fresh paid
  // fingerprint. Encoding clues belong only to their exact supported protocol.
  if(own(input,'wireEncoding')||own(input,'sectionKeyRuns')
   ||Array.isArray(input.issues)&&input.issues.some(issue=>record(issue)&&own(issue,'sectionKeyRuns'))
   ||typeof input.reviewMode==='string'&&input.reviewMode.startsWith('FULL_STRUCTURE_BLOCKS')&&input.reviewMode!==V1)invalid();
  return input;
 }
 const checked=common(input,V2);if(!checked)invalid();
 const {value,start,end}=checked!,encoding=value.wireEncoding;
 if(!record(encoding)||!keys(encoding,['scheme','defaultBlankText','blankExceptions','expandedJsonHash'])||encoding.scheme!=='BLANK_DEFAULT_VISIBLE_RUNS_V2'||!blank(encoding.defaultBlankText)||!denseArray(encoding.blankExceptions)||encoding.blankExceptions.length>end-start+1||typeof encoding.expandedJsonHash!=='string'||!/^[a-f0-9]{64}$/.test(encoding.expandedJsonHash))invalid();
 // Count the restored JSON before creating any expanded blocks/reference lists.
 // Empty arrays account for root punctuation; subsequent costs fill them exactly.
 const skeleton=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='wireEncoding').map(([key,item])=>[key,key==='reviewMode'?V1:key==='blocks'||key==='issues'?[]:item]));
 let expandedChars=boundedJsonChars(skeleton);
 const spend=(count:number)=>{if(!Number.isSafeInteger(count)||count<0||expandedChars>MAX_EXPANDED_CHARS-count)invalid();expandedChars+=count;};
 spend(0);
 const blocks=new Map<string,string>();let previous=start-1;
 for(const row of value.blocks as unknown[]){
  if(!denseArray(row)||row.length!==2||!blockId(row[0])||typeof row[1]!=='string'||blank(row[1]))invalid();
  const number=Number(row[0].slice(1));if(number<=previous||number<start||number>end)invalid();previous=number;spend(boundedJsonChars(row[1]));blocks.set(row[0],row[1]);
 }
 const visible=[...blocks.keys()],positions=new Map(visible.map((id,i)=>[id,i]));previous=start-1;
 for(const row of encoding.blankExceptions){
  if(!denseArray(row)||row.length!==2||!blockId(row[0])||!blank(row[1])||row[1]===encoding.defaultBlankText||blocks.has(row[0]))invalid();
  const number=Number(row[0].slice(1));if(number<=previous||number<start||number>end)invalid();previous=number;spend(boundedJsonChars(row[1]));blocks.set(row[0],row[1]);
 }
 const blockCount=end-start+1;
 spend(blockCount*13-1); // each fixed B###### ID, tuple framing and row separator
 spend((blockCount-blocks.size)*boundedJsonChars(encoding.defaultBlankText));
 const issues=(value.issues??[]) as unknown[];
 if(issues.length)spend(issues.length-1);
 const issuePlans=issues.map(issue=>{
  if(issueV1(issue)){spend(boundedJsonChars(issue));return {issue,ranges:null};}
  if(!record(issue)||!keys(issue,['code','message','sectionKeyRuns'])||typeof issue.code!=='string'||typeof issue.message!=='string'||!denseArray(issue.sectionKeyRuns)||!issue.sectionKeyRuns.length)invalid();
  const ranges:Array<[number,number]>=[];let last=-1,refCount=0;
  for(const run of issue.sectionKeyRuns){
   let first:number|undefined,to:number|undefined;
   if(typeof run==='string'){first=positions.get(run);to=first;}
   else if(denseArray(run)&&run.length===2&&typeof run[0]==='string'&&typeof run[1]==='string'){first=positions.get(run[0]);to=positions.get(run[1]);if(first!==undefined&&to!==undefined&&first>=to)invalid();}
   else invalid();
   if(first===undefined||to===undefined||first<=last||to<first)invalid();ranges.push([first,to]);refCount+=to-first+1;last=to;
  }
  spend(boundedJsonChars(Object.fromEntries(Object.entries(issue).map(([key,item])=>key==='sectionKeyRuns'?['sectionKeys',[]]:[key,item]))));
  spend(refCount*10-1); // quoted seven-character IDs and separators
  return {issue,ranges};
 });
 const restoredBlocks=Array.from({length:blockCount},(_,i)=>{const id=idFor(start+i);return [id,blocks.has(id)?blocks.get(id)!:encoding.defaultBlankText] as Block;});
 const restoredIssues=issuePlans.map(({issue,ranges})=>{
  if(ranges===null)return structuredClone(issue);
  const refs:string[]=[];for(const [first,last]of ranges)for(let i=first;i<=last;i++)refs.push(visible[i]);
  return Object.fromEntries(Object.entries(issue).map(([key,item])=>key==='sectionKeyRuns'?['sectionKeys',refs]:[key,structuredClone(item)])) as Issue;
 });
 const restored=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='wireEncoding').map(([key,item])=>[key,key==='reviewMode'?V1:key==='blocks'?restoredBlocks:key==='issues'?restoredIssues:structuredClone(item)]));
 if(hash(restored)!==encoding.expandedJsonHash)invalid();
 return restored;
}
