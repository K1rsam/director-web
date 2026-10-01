export const SCHEMA_PROJECTION_VERSION='shared-enums-v1';

// Only generated, exact string-enum leaves are shared. No source or creative text is rewritten.
export function projectOutputSchema(schema){
 const counts=new Map();let reserved=false;
 const keyOf=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&value.type==='string'&&Array.isArray(value.enum)&&value.enum.length&&value.enum.every(item=>typeof item==='string')?JSON.stringify(value):null;
 const scan=value=>{
  if(!value||typeof value!=='object')return;
  if(Object.hasOwn(value,'$defs')||Object.hasOwn(value,'$ref'))reserved=true;
  const key=keyOf(value);
  if(key){counts.set(key,(counts.get(key)||0)+1);return;}
  for(const item of Object.values(value))scan(item);
 };
 scan(schema);
 if(reserved)return schema;
 const names=new Map(),definitions={};
 for(const [key,count] of counts){
  const name=`enum${names.size+1}`,ref=JSON.stringify({$ref:`#/$defs/${name}`});
  const definitionCost=JSON.stringify(name).length+1+key.length+1;
  if(count<2||key.length<100||count*key.length<=count*ref.length+definitionCost)continue;
  names.set(key,name);definitions[name]=JSON.parse(key);
 }
 if(!names.size)return schema;
 const visit=value=>{
  if(!value||typeof value!=='object')return value;
  const name=names.get(keyOf(value));
  if(name)return {$ref:`#/$defs/${name}`};
  return Array.isArray(value)?value.map(visit):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
 };
 const projected={...visit(schema),$defs:definitions};
 return JSON.stringify(projected).length<JSON.stringify(schema).length?projected:schema;
}
