import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const TABLES=['Project','Episode','Asset','ScriptScene','SceneSnapshot','PipelineRun'];
const AUTH_TABLES=new Set(['User','Session','UserProviderCredential','ProjectRole']);
const q=name=>`"${name.replaceAll('"','""')}"`;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const columns=(db,table)=>db.prepare(`PRAGMA table_info(${q(table)})`).all();
const tableNames=db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);
const selectProject=(db,table,projectId)=>db.prepare(`SELECT * FROM ${q(table)} WHERE ${table==='Project'?'id':table==='ScriptScene'?'episodeId IN (SELECT id FROM Episode WHERE projectId': 'projectId'}=?${table==='ScriptScene'?')':''} ORDER BY id`).all(projectId);

/** One-way project data copy. No source writes, authentication import, file-store copy or provider access. */
export function importAcceptanceProject(source,target,{projectId,ownerUsername}) {
 if(source===target)fail('SAME_DATABASE');
 if(!projectId||!ownerUsername)fail('MISSING_SCOPE');
 const sourceFile=source.prepare('PRAGMA database_list').all().find(r=>r.name==='main').file;
 const targetFile=target.prepare('PRAGMA database_list').all().find(r=>r.name==='main').file;
 if(sourceFile&&sourceFile===targetFile)fail('SAME_DATABASE');
 const owner=target.prepare('SELECT id FROM User WHERE username=?').get(ownerUsername);
 if(!owner)fail('OWNER_MISSING');
 if(target.prepare('SELECT id FROM Project WHERE id=?').get(projectId))fail('PROJECT_EXISTS');
 const data=Object.fromEntries(TABLES.map(table=>[table,selectProject(source,table,projectId)]));
 if(data.Project.length!==1)fail('SOURCE_PROJECT_MISSING');
 if(data.PipelineRun.some(r=>['RUNNING','QUEUED'].includes(r.status)))fail('SOURCE_ACTIVE');
 const selectedIds=Object.fromEntries(TABLES.map(table=>[table,new Set(data[table].map(r=>r.id))]));
 for(const table of tableNames(source)){
  if(TABLES.includes(table)||AUTH_TABLES.has(table)||table.startsWith('_'))continue;
  const names=columns(source,table).map(c=>c.name);
  const predicate=names.includes('projectId')?'projectId=?':names.includes('episodeId')?'episodeId IN (SELECT id FROM Episode WHERE projectId=?)':null;
  if(predicate&&source.prepare(`SELECT 1 FROM ${q(table)} WHERE ${predicate} LIMIT 1`).get(projectId))fail(`UNSUPPORTED_PROJECT_DATA:${table}`);
 }
 for(const table of [...TABLES,'ProjectRole']){
  const shape=db=>columns(db,table).map(({name,type,notnull,pk})=>({name,type,notnull,pk}));
  assert.deepEqual(shape(target),shape(source),`SCHEMA_MISMATCH:${table}`);
 }
 for(const table of TABLES){
  for(const row of data[table]){
   if(target.prepare(`SELECT id FROM ${q(table)} WHERE id=?`).get(row.id))fail(`ID_CONFLICT:${table}`);
   for(const fk of source.prepare(`PRAGMA foreign_key_list(${q(table)})`).all()){
    if(row[fk.from]===null||row[fk.from]===undefined)continue;
    if(fk.to!=='id'||!selectedIds[fk.table]?.has(row[fk.from]))fail(`CROSS_PROJECT_REFERENCE:${table}.${fk.from}`);
   }
  }
 }
 if(target.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('FOREIGN_KEYS_REQUIRED');
 const role={id:`acceptance-${randomUUID()}`,projectId,userId:owner.id,role:'ADMIN',createdAt:Date.now()};
 target.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;');
 try{
  for(const table of TABLES){
   const names=columns(source,table).map(c=>c.name);
   const insert=target.prepare(`INSERT INTO ${q(table)} (${names.map(q).join(',')}) VALUES (${names.map(()=>'?').join(',')})`);
   for(const row of data[table])insert.run(...names.map(name=>row[name]));
  }
  target.prepare('INSERT INTO ProjectRole(id,projectId,userId,role,createdAt) VALUES(?,?,?,?,?)').run(role.id,role.projectId,role.userId,role.role,role.createdAt);
  for(const table of TABLES)assert.deepEqual(selectProject(target,table,projectId),data[table],`IMPORT_MISMATCH:${table}`);
  assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(),[],'FOREIGN_KEY_VIOLATION');
  target.exec('COMMIT');
 }catch(error){target.exec('ROLLBACK');throw error;}
 return{projectId,ownerId:owner.id,roleId:role.id,counts:Object.fromEntries(TABLES.map(t=>[t,data[t].length])),credentialsCopied:false,providerCalls:0};
}
