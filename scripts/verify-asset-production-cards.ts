import assert from 'node:assert/strict';
import {attachEpisodeMaterials} from '../lib/episode-upstream-material';

const text='1-1 仓库 日 内\n△甲反锁铁门，躲进固定货架后。\n甲：这扇门永远打不开。\n';
const first=text.indexOf('△'),last=text.indexOf('甲：');
const base={packet:{episode:1,sourceText:text,assets:[{key:'warehouse',name:'仓库',type:'LOC',aliases:[],episodes:[1],sceneRefs:[{episode:1,sceneKey:'1-1'}],variants:[]}],materialDependencies:[{key:'base-store',baseKey:'base-store',name:'原仓库',type:'LOC',kind:'BASE',use:'MATERIAL_SOURCE_ONLY'}],scenes:[{episode:1,sceneKey:'1-1',sourceRange:{start:0,end:text.length},assetKeys:['warehouse']}],facts:{sourceFactIndex:[{id:'action',kind:'STATE',subjects:['甲'],claim:'SOURCE',evidence:{domain:'EPISODE',episode:1,start:first,end:last}},{id:'claim',kind:'UTTERANCE',subjects:['甲'],claim:'CHARACTER_CLAIM',evidence:{domain:'EPISODE',episode:1,start:last,end:text.length}}]}},readiness:'READY',reasons:[]} as unknown as Parameters<typeof attachEpisodeMaterials>[0];
const direction={status:'UNCONFIRMED',projection:null} as Parameters<typeof attachEpisodeMaterials>[1];
const handoff=attachEpisodeMaterials(base,direction,[{assetKey:'warehouse',status:'UNADOPTED',materialAvailability:'TEXT_ONLY',references:[]}]);
const cards=(handoff.packet.upstream as unknown as {assetProductionCards?:Array<Record<string,any>>}).assetProductionCards;
assert.ok(cards?.length,'unadopted assets still receive source-grounded production cards');
const room=cards.find(c=>c.assetKey==='warehouse')!;
assert.equal(room.use,'ACTUAL_APPEARANCE');
assert.equal(room.adoptedDesign,null);
assert.ok(room.sourceFacts.some((f: {quote:string})=>f.quote.includes('反锁铁门')),'scene action evidence supports doors, paths, occlusion and fixed furniture without inventing blocking');
assert.ok(!room.sourceFacts.some((f: {quote:string;claim:string})=>f.quote.includes('永远打不开')&&f.claim==='SOURCE'),'character claims never become objective functional facts');
assert.deepEqual(room.applicable,{episode:1,sceneKeys:['1-1']});
assert.equal(cards.find(c=>c.assetKey==='base-store')?.use,'MATERIAL_SOURCE_ONLY');
assert.equal(handoff.packet.upstream.modelDesigns.length,0,'legacy adopted-only input stays compatible');
const stale=attachEpisodeMaterials(base,direction,[{assetKey:'warehouse',status:'STALE',materialAvailability:'TEXT_ONLY',brief:'旧设计的秘密出口',references:[]}]);
assert.ok(!JSON.stringify((stale.packet.upstream as any).assetProductionCards).includes('秘密出口'),'expired design never masquerades as adopted material');
const adopted=attachEpisodeMaterials(base,direction,[{assetKey:'warehouse',status:'TEXT_ADOPTED',materialAvailability:'TEXT_ONLY',adoptionVersion:2,brief:'铁门和固定货架保持位置；未锁定墙色。',references:[]}]);
assert.equal((adopted.packet.upstream as any).assetProductionCards[0].adoptedDesign.version,2);
assert.equal((adopted.packet.upstream as any).assetProductionCards[0].imageEvidence,'NO_PIXELS_READ');
assert.equal(base.packet.sourceText,text,'canonical source is untouched');
const quotedClaim=attachEpisodeMaterials(base,direction,[{assetKey:'warehouse',status:'UNADOPTED',materialAvailability:'TEXT_ONLY',references:[],visualFacts:[{id:'visual-claim',subjectKey:'warehouse',attribute:'门功能',value:'永远打不开',scope:'STABLE',quote:'甲：这扇门永远打不开。',chunkId:'ep1',startLine:3,endLine:3,sourceLabel:'EPISODE · 第1集'}]}]);
assert.equal((quotedClaim.packet.upstream as any).assetProductionCards[0].sourceFacts.find((f:any)=>f.id==='visual-claim')?.claim,'CHARACTER_CLAIM','a visual extraction cannot launder a quoted character claim');
const characterBase={...base,packet:{...base.packet,assets:[...base.packet.assets,{key:'hero',name:'甲｜默认',type:'CH',aliases:[],episodes:[1],sceneRefs:[{episode:1,sceneKey:'1-1'}],variants:[{key:'wounded',name:'受伤形象',episodes:[1],sceneRefs:[{episode:1,sceneKey:'1-1'}]}]}]}} as unknown as Parameters<typeof attachEpisodeMaterials>[0];
const characterCards=(attachEpisodeMaterials(characterBase,direction,[]).packet.upstream as any).assetProductionCards;
for(const key of ['hero','wounded']){
 const card=characterCards.find((c:any)=>c.assetKey===key);
 assert.ok(card.sourceFacts.some((f:any)=>f.id==='action'),'Catalogue look suffix must not hide source character evidence; variants keep the base identity');
 assert.equal(card.sourceFacts.find((f:any)=>f.id==='claim')?.claim,'CHARACTER_CLAIM');
}
const nearName={...characterBase,packet:{...characterBase.packet,facts:{...characterBase.packet.facts,sourceFactIndex:[{id:'other',kind:'STATE',subjects:['甲乙'],claim:'SOURCE',evidence:{domain:'EPISODE',episode:1,start:first,end:last}}]}}} as unknown as Parameters<typeof attachEpisodeMaterials>[0];
assert.equal((attachEpisodeMaterials(nearName,direction,[]).packet.upstream as any).assetProductionCards.find((c:any)=>c.assetKey==='hero').sourceFacts.length,0,'A single-character identity must not match unrelated substrings');
console.log('PASS asset production cards: unadopted source evidence, action-functional layout, claims, scoped appearance, material-only dependencies, stale design isolation, no image claim; DB/model calls 0');
