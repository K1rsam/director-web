import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {importAcceptanceProject} from './project-acceptance-import.mjs';

const ddl=`
CREATE TABLE User(id TEXT PRIMARY KEY,username TEXT UNIQUE,passwordHash TEXT);
CREATE TABLE Project(id TEXT PRIMARY KEY,title TEXT,description TEXT);
CREATE TABLE Episode(id TEXT PRIMARY KEY,projectId TEXT REFERENCES Project(id),number INTEGER,content TEXT);
CREATE TABLE Asset(id TEXT PRIMARY KEY,projectId TEXT REFERENCES Project(id),parentId TEXT REFERENCES Asset(id));
CREATE TABLE ScriptScene(id TEXT PRIMARY KEY,episodeId TEXT REFERENCES Episode(id),sourceText TEXT);
CREATE TABLE SceneSnapshot(id TEXT PRIMARY KEY,projectId TEXT REFERENCES Project(id),episodeId TEXT REFERENCES Episode(id),sceneKey TEXT,content TEXT);
CREATE TABLE PipelineRun(id TEXT PRIMARY KEY,projectId TEXT REFERENCES Project(id),episodeId TEXT REFERENCES Episode(id),status TEXT);
CREATE TABLE ProjectRole(id TEXT PRIMARY KEY,userId TEXT REFERENCES User(id),projectId TEXT REFERENCES Project(id),role TEXT,createdAt INTEGER);
CREATE TABLE TaskPackage(id TEXT PRIMARY KEY,projectId TEXT REFERENCES Project(id));
CREATE TABLE Session(id TEXT PRIMARY KEY,userId TEXT REFERENCES User(id),tokenHash TEXT);
CREATE TABLE UserProviderCredential(id TEXT PRIMARY KEY,userId TEXT REFERENCES User(id),apiKeyCiphertext TEXT);`;
function fixture(){
 const source=new DatabaseSync(':memory:'),target=new DatabaseSync(':memory:');
 for(const db of [source,target])db.exec('PRAGMA foreign_keys=ON;'+ddl);
 source.exec(`INSERT INTO User VALUES('actor','comparison','private-source-password');
 INSERT INTO Session VALUES('source-session','actor','private-source-session');
 INSERT INTO UserProviderCredential VALUES('source-key','actor','private-source-key');
 INSERT INTO Project VALUES('sample','样稿','原项目说明');
 INSERT INTO Project VALUES('unrelated','不在范围','');
 INSERT INTO Episode VALUES('ep1','sample',1,'正文不改');
 INSERT INTO Episode VALUES('ep-other','unrelated',1,'无关正文');
 INSERT INTO Asset VALUES('parent','sample',NULL);
 INSERT INTO Asset VALUES('child','sample','parent');
 INSERT INTO ScriptScene VALUES('scene','ep1','场文');
 INSERT INTO SceneSnapshot VALUES('draft','sample',NULL,'SERIES_DIRECTION_CARD','{"status":"DRAFT","confirmation":null}');
 INSERT INTO PipelineRun VALUES('paid','sample',NULL,'SUCCEEDED');
 INSERT INTO ProjectRole VALUES('source-role','actor','sample','ADMIN',1);`);
 target.exec(`INSERT INTO User VALUES('existing-user','tester01','keep-password');
 INSERT INTO Project VALUES('existing','原有项目','keep-description');
 INSERT INTO Episode VALUES('existing-ep','existing',1,'keep-text');
 INSERT INTO Session VALUES('existing-session','existing-user','keep-session');
 INSERT INTO UserProviderCredential VALUES('existing-key','existing-user','keep-key');`);
 return{source,target,close(){source.close();target.close();}};
}
function dump(db){return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>({name,rows:db.prepare(`SELECT * FROM "${name}" ORDER BY id`).all()}));}
const options={projectId:'sample',ownerUsername:'tester01'};

test('copies only the exact project graph, preserving source facts/history and existing target accounts/projects',()=>{
 const f=fixture();try{
 const original=dump(f.source),before=dump(f.target);
 const result=importAcceptanceProject(f.source,f.target,options);
 assert.equal(result.projectId,'sample');assert.equal(result.ownerId,'existing-user');
 assert.equal(f.target.prepare('SELECT COUNT(*) n FROM Project').get().n,2);
 assert.equal(f.target.prepare('SELECT id FROM Project WHERE id=?').get('unrelated'),undefined);
 assert.deepEqual(f.target.prepare('SELECT * FROM Episode WHERE id=?').get('ep1'),f.source.prepare('SELECT * FROM Episode WHERE id=?').get('ep1'));
 assert.deepEqual(f.target.prepare('SELECT * FROM SceneSnapshot WHERE id=?').get('draft'),f.source.prepare('SELECT * FROM SceneSnapshot WHERE id=?').get('draft'));
 assert.equal(f.target.prepare('SELECT userId FROM ProjectRole WHERE projectId=?').get('sample').userId,'existing-user');
 for(const table of before)for(const row of table.rows)assert.deepEqual(f.target.prepare(`SELECT * FROM "${table.name}" WHERE id=?`).get(row.id),row);
 for(const table of ['User','Session','UserProviderCredential'])assert.equal(f.target.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n,1);
 assert.deepEqual(dump(f.source),original);assert.deepEqual(f.target.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{f.close();}
});
test('rejects repeated imports without overwriting the first imported project',()=>{
 const f=fixture();try{importAcceptanceProject(f.source,f.target,options);const before=dump(f.target);assert.throws(()=>importAcceptanceProject(f.source,f.target,options),/PROJECT_EXISTS/);assert.deepEqual(dump(f.target),before);}finally{f.close();}
});
test('rejects missing owner, active runs and unsupported project data without partial writes',()=>{
 for(const scenario of ['owner','running','unsupported']){const f=fixture();try{
  if(scenario==='running')f.source.exec("UPDATE PipelineRun SET status='RUNNING'");
  if(scenario==='unsupported')f.source.exec("INSERT INTO TaskPackage VALUES('unknown-job','sample')");
  const before=dump(f.target);assert.throws(()=>importAcceptanceProject(f.source,f.target,{...options,ownerUsername:scenario==='owner'?'missing':'tester01'}),new RegExp(scenario==='owner'?'OWNER_MISSING':scenario==='running'?'SOURCE_ACTIVE':'UNSUPPORTED_PROJECT_DATA'));assert.deepEqual(dump(f.target),before);
 }finally{f.close();}}
});
test('rejects cross-project asset parents and conflicting child IDs',()=>{
 for(const scenario of ['parent','id']){const f=fixture();try{
  if(scenario==='parent')f.source.exec("INSERT INTO Asset VALUES('outside','unrelated',NULL);UPDATE Asset SET parentId='outside' WHERE id='child'");
  else f.target.exec("INSERT INTO Episode VALUES('ep1','existing',2,'keep-collision')");
  const before=dump(f.target);assert.throws(()=>importAcceptanceProject(f.source,f.target,options),new RegExp(scenario==='parent'?'CROSS_PROJECT_REFERENCE':'ID_CONFLICT'));assert.deepEqual(dump(f.target),before);
 }finally{f.close();}}
});
test('rolls the entire import back when an insert fails',()=>{
 const f=fixture();try{f.target.exec("CREATE TRIGGER stop_snapshot BEFORE INSERT ON SceneSnapshot BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");const before=dump(f.target);assert.throws(()=>importAcceptanceProject(f.source,f.target,options),/synthetic write failure/);assert.deepEqual(dump(f.target),before);}finally{f.close();}
});
