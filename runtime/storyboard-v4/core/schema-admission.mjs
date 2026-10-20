import {digest} from './shared.mjs';

function regexIssue(pattern){
 let inClass=false;
 for(let i=0;i<pattern.length;i++){
  const c=pattern[i];
  if(c==='\\'){
   const next=pattern[++i];
   if(!inClass&&(/[1-9]/.test(next||'')||next==='k'&&pattern[i+1]==='<'))return 'regex_backreference';
   continue;
  }
  if(c==='['&&!inClass){inClass=true;continue;}
  if(c===']'&&inClass){inClass=false;continue;}
  if(!inClass&&c==='('&&/^\(\?(?:[=!]|<[=!])/.test(pattern.slice(i)))return 'regex_lookaround';
 }
 return null;
}

// Deliberately a known-incompatibility guard, not a substitute for server or
// domain validation. Never strip constraints or edit the frozen schema.
export function schemaCompatibilityIssue(schema){
 if(!schema||typeof schema!=='object'||Array.isArray(schema)||schema.type!=='object'||schema.anyOf)return {schemaPath:'$',reason:'root_object_required'};
 const visit=(node,at)=>{
  if(!node||typeof node!=='object'||Array.isArray(node))return {schemaPath:at,reason:'schema_object_required'};
  for(const key of ['allOf','not','dependentRequired','dependentSchemas','if','then','else'])if(Object.hasOwn(node,key))return {schemaPath:at+'.'+key,reason:'unsupported_composition'};
  if(Object.hasOwn(node,'pattern')){
   if(typeof node.pattern!=='string')return {schemaPath:at+'.pattern',reason:'invalid_regex'};
   const reason=regexIssue(node.pattern);if(reason)return {schemaPath:at+'.pattern',reason};
  }
  // Only schema-bearing fields: examples/defaults/enum/prose are data, not schemas.
  for(const key of ['properties','$defs','definitions','patternProperties'])if(node[key]&&typeof node[key]==='object')for(const [name,child]of Object.entries(node[key])){const issue=visit(child,at+'.'+key+'.'+name);if(issue)return issue;}
  for(const key of ['items','additionalProperties'])if(node[key]&&typeof node[key]==='object'){const issue=visit(node[key],at+'.'+key);if(issue)return issue;}
  if(Array.isArray(node.anyOf))for(let i=0;i<node.anyOf.length;i++){const issue=visit(node.anyOf[i],at+'.anyOf['+i+']');if(issue)return issue;}
  return null;
 };
 return visit(schema,'$');
}

const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const onlyFields=(value,allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key));
function plainDiagnostic(value){
 if(typeof value!=='string'||!value.trim()||value.length>16384)return false;
 // Encoded data is not a known plain-text warning/schema diagnostic.
 try{JSON.parse(value);return false;}catch{return true;}
}

// Pure known startup shapes only. The caller must also check event ordering.
export function isPureStartupEvent(event){
 if(event?.type==='thread.started')return onlyFields(event,['type','thread_id'])&&(!Object.hasOwn(event,'thread_id')||typeof event.thread_id==='string');
 if(event?.type==='turn.started')return onlyFields(event,['type']);
 return event?.type==='item.completed'&&onlyFields(event,['type','item'])&&onlyFields(event.item,['id','type','message'])&&event.item.type==='error'&&
  (!Object.hasOwn(event.item,'id')||typeof event.item.id==='string')&&plainDiagnostic(event.item.message);
}

// Typed rejection proof only; callers must still exclude earlier model activity,
// conflicting terminal events and a live/unobserved process before accounting.
export function classifySchemaAdmissionEvent(event){
 if(!['error','turn.failed'].includes(event?.type)||event.status!==undefined&&event.status!==400)return null;
 let envelope=event;
 if(envelope.status===undefined){
  if(!onlyFields(event,['type','error','message'])||Object.hasOwn(event,'error')===Object.hasOwn(event,'message'))return null;
  if(record(event.error)&&!onlyFields(event.error,['message']))return null;
  const raw=Object.hasOwn(event,'message')?event.message:typeof event.error==='string'?event.error:event.error?.message;
  if(typeof raw!=='string'||raw.length>16384)return null;
  try{envelope=JSON.parse(raw);}catch{return null;}
 }
 // Whitelist both layers, including scalar error fields. Null usage, encoded
 // content or any unknown extension is uncertainty, never proof of no inference.
 const error=envelope?.error;
 if(!onlyFields(envelope,['type','status','error'])||envelope.status!==400||Object.hasOwn(envelope,'type')&&!['error','turn.failed'].includes(envelope.type)||
  !onlyFields(error,['type','param','code','message'])||error.type!=='invalid_request_error'||error.param!=='text.format.schema'||error.code!=='invalid_json_schema'||!plainDiagnostic(error.message))return null;
 return {status:400,type:error.type,param:error.param,code:error.code,evidenceHash:digest(event)};
}
