import assert from 'node:assert/strict';
import {buildSourceIndex} from '../lib/project-foundation-contracts';
import {createEmptyDocument,mergeDocumentF2,loadFoundationDocument} from '../lib/foundation-document';
import {requireProductionCatalogAuthor} from '../lib/foundation-production-contracts';

async function main(){
 const sourceIndex=buildSourceIndex([{number:1,title:'一',content:'甲：一。'},{number:2,title:'二',content:'乙：二。'}]);
 const base:any={sourceIndex,sourceVersion:sourceIndex.version,sourceContext:{version:'context',background:[]},projectConditions:{style:'3D国漫',aspectRatio:'16:9'}};
 const empty=createEmptyDocument(base),catalog=requireProductionCatalogAuthor({format:'ASSET_CATALOG_V2',coverage:[1,2],assets:[]},sourceIndex,[1,2]);
 const prior={...mergeDocumentF2({...empty,workflow:'LIGHT_STAGE1_V1'},catalog,sourceIndex),editorialCoverage:[1,2]};
 const saved=JSON.stringify(prior);
 const db:any={sceneSnapshot:{findMany:async()=>[{id:'saved',sceneKey:'FOUNDATION_DOCUMENT',content:saved}]}};
 const unchanged=await loadFoundationDocument(db,'p',base);
 assert.equal(unchanged.document.revision,prior.revision);
 const changed={...base,scriptInterpretationVersions:{1:'confirmed-local-interpretation'}};
 const next=await loadFoundationDocument(db,'p',changed);
 assert.equal(next.sourceChanged,true,'confirmed interpretation changes are real dependencies even when raw text stays identical');
 assert.deepEqual(next.document.f2?.coverage,[2],'only the changed episode loses current catalog coverage');
 assert.deepEqual(next.document.editorialCoverage,[2]);
 assert.equal(next.document.sourceVersion,sourceIndex.version,'raw source is not relabeled or rewritten');
 assert.equal(next.document.sourceHashes['2'],prior.sourceHashes['2']);
 assert.equal(JSON.stringify(prior),saved,'previous paid document is immutable');
 console.log('PASS local interpretation invalidates only its episode while original source and prior results stay intact');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
