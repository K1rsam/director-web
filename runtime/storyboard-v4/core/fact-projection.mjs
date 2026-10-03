import {digest} from './shared.mjs';

export const MODEL_PROJECTION_VERSION='retrieval-facts-v1';
const categories=['current','background','backgroundCandidates','historicalStates','unlinkedBackground','sourceFactIndex'];
const fields=['id','evidence','subjects','kind','claim','applicability','validity'];
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const jsonValue=value=>value===null||typeof value==='string'||typeof value==='boolean'
 ||typeof value==='number'&&Number.isFinite(value)
 ||Array.isArray(value)&&Object.keys(value).length===value.length&&value.every(jsonValue)
 ||record(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.values(value).every(jsonValue);
const supported=fact=>record(fact)&&fields.every(key=>Object.hasOwn(fact,key))
 &&['id','kind','claim','applicability'].every(key=>typeof fact[key]==='string')
 &&record(fact.evidence)&&record(fact.validity)&&Array.isArray(fact.subjects)&&fact.subjects.every(value=>typeof value==='string')
 &&(!Object.hasOwn(fact,'statement')||typeof fact.statement==='string');
const withoutStatement=({statement,...fact})=>fact;

/** Model-only table/group projection, following foundation-model-input.ts without omitting source indices. */
export function projectRetrievalFacts(facts){
 if(!record(facts)||facts.schema!=='FOUNDATION_FACTS_V1'||!jsonValue(facts)
  ||['format','columns','interpretation','rows','groups'].some(key=>Object.hasOwn(facts,key))
  ||categories.some(key=>Object.hasOwn(facts,key)&&(!Array.isArray(facts[key])||!facts[key].every(supported))))return facts;
 const backgrounds=new Map();
 for(const group of ['background','backgroundCandidates'])for(const fact of facts[group]||[]){
  if(!Object.hasOwn(fact,'statement'))continue;
  const key=digest(withoutStatement(fact)),previous=backgrounds.get(key);
  // Conflicting statements remain separate; do not choose one for an unlinked record.
  backgrounds.set(key,!backgrounds.has(key)||previous&&previous.statement===fact.statement?fact:null);
 }
 const rows=[],rowKeys=new Map(),groups={};
 for(const group of categories){
  if(!Object.hasOwn(facts,group))continue;
  groups[group]=facts[group].map(fact=>{
   const full=group==='unlinkedBackground'&&!Object.hasOwn(fact,'statement')?backgrounds.get(digest(fact)):null;
   const item=full||fact,key=digest(item);
   let index=rowKeys.get(key);
   if(index===undefined){
    const extra=Object.fromEntries(Object.entries(item).filter(([key])=>!fields.includes(key)&&key!=='statement'));
    const hasExtra=Object.keys(extra).length>0,hasStatement=Object.hasOwn(item,'statement');
    const row=fields.map(key=>item[key]);
    if(hasStatement||hasExtra)row.push(hasStatement?item.statement:null);
    if(hasExtra)row.push(extra);
    index=rows.length;rowKeys.set(key,index);rows.push(row);
   }
   return full?[index]:index;
  });
 }
 const rest=Object.fromEntries(Object.entries(facts).filter(([key])=>!categories.includes(key)));
 const table={...rest,format:'STORYBOARD_FACT_TABLE_V1',columns:[...fields,'statement?','extra?'],
  interpretation:'columns依次对应rows；groups中i取零起始第i行，[i]取该行但不含statement；statement的null占位表示缺字段，extra原样并回；分组不是事实确认，evidence偏移仍按原文字符。',rows,groups};
 return JSON.stringify(table).length<JSON.stringify(facts).length?table:facts;
}
