import type {PromptEvidence} from './asset-prompt-contract';

type Identity={key:string;name:string;aliases:string[]};
type Candidate=PromptEvidence & {episode?:number;offset?:number;temporal:boolean};
type SceneRange={episode:number;sceneKey:string;sourceRange:{start:number;end:number}};
const visual=/外形|外貌|容貌|身穿|穿着|身着|长袍|长发|短发|发色|脸型|眉眼|肤色|皮肤|身材|体型|身高|鳞片|羽毛|毛色|建筑|大门|墙壁|材质|形状|黑色|白色|红色|蓝色|少年|少女|老者|中年|眼镜/;
const temporal=/前世|后期|后来|之后|此后|随后|受伤|失明|血迹|泥巴|破损|破坏后|换上|改穿/;
const clean=(s:string)=>s.trim().replace(/^[#\s△▲＊*\d.、）)（(]+/,'').trim();
const rootName=(s:string)=>s.split(/[｜|]/)[0].trim();

/** Conservative local attribution: mention retrieval is never appearance evidence. */
export function buildAppearanceEvidenceIndex(identities:Identity[],background:{key:string;text:string}[],episodes:{number:number;content:string}[],scenes?:SceneRange[]){
 const owners=new Map<string,Set<string>>();
 for(const a of identities)for(const n of new Set([rootName(a.name),...a.aliases])){
  if(n.length<2)continue;const set=owners.get(n)??new Set<string>();set.add(rootName(a.name));owners.set(n,set);
 }
 const unique=[...owners].filter(([,s])=>s.size===1).map(([name,s])=>({name,owner:[...s][0]})).sort((a,b)=>b.name.length-a.name.length);
 const rows=new Map<string,Candidate[]>();
 const add=(owner:string,row:Candidate)=>{const list=rows.get(owner)??[];list.push(row);rows.set(owner,list);};
 const heading=(text:string)=>unique.find(n=>text===n.name||text.startsWith(n.name+'：')||text.startsWith(n.name+':'));
 for(const section of background){
  let owner:string|undefined;
  section.text.split(/\r?\n/).forEach((line,i)=>{
   const t=clean(line);if(!t)return;
   const h=heading(t);
   if(h)owner=h.owner;
   // Any unfamiliar standalone title or new named block terminates ownership.
   else if(!/^(外形|外貌|容貌|性格|背景|身份|年龄|服装|体型|身高|特征|形象)[：:]/.test(t)){owner=undefined;return;}
   if(!owner||!visual.test(t)||/^(背景|性格)[：:]/.test(t))return;
   if(unique.some(n=>n.owner!==owner&&t.includes(n.name)))return;
   add(owner,{label:`作者人物资料 · ${owner} · L${i+1}`,text:line,temporal:temporal.test(t)});
  });
 }
 for(const episode of episodes){let cursor=0;episode.content.split('\n').forEach((line,i)=>{
  const offset=cursor;cursor+=line.length+1;
  const t=clean(line);if(!visual.test(t))return;
  const subject=unique.find(n=>t.startsWith(n.name));if(!subject)return;
  const rest=t.slice(subject.name.length);
  // Exclude dialogue, possessive relationships, and clauses mentioning another identity.
  if(!/^[，,\s]*(?:身穿|穿着|身着|戴着|戴上|一身|身高|皮肤|肤色|身材|体型|长着|留着|留有|披着|满头|头发|面容|外形|外貌|容貌|年龄|[（(](?:身穿|穿着|身着|戴着))/.test(rest))return;
  if(unique.some(n=>n.owner!==subject.owner&&t.includes(n.name)))return;
  add(subject.owner,{label:`第${episode.number}集 L${i+1} · ${subject.owner}`,text:line,episode:episode.number,offset,temporal:temporal.test(t)});
 });}
 return {forAsset(name:string,scope:number[],_variant:boolean,refs?:{episode:number;sceneKey:string}[],excludedRefs:{episode:number;sceneKey:string}[]=[]):PromptEvidence[]{
  const seen=new Set<string>();let chars=0;
  return (rows.get(rootName(name))??[]).filter(r=>r.episode===undefined||scope.includes(r.episode)).filter(r=>{
   if(r.episode===undefined||scenes===undefined)return true;
   const scene=scenes.find(s=>s.episode===r.episode&&r.offset!>=s.sourceRange.start&&r.offset!<s.sourceRange.end);
   if(!scene)return false;
   return Boolean(refs?.some(s=>s.episode===scene.episode&&s.sceneKey===scene.sceneKey))&&!excludedRefs.some(s=>s.episode===scene.episode&&s.sceneKey===scene.sceneKey);
  }).filter(r=>!r.temporal).filter(r=>{
   if(seen.has(r.text)||seen.size>=24||chars+r.text.length>14000)return false;seen.add(r.text);chars+=r.text.length;return true;
  }).map(({label,text})=>({label,text}));
 }};
}
