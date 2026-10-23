import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('./season-scope.mjs').catch(()=>({}));
const basis={sourceVersion:'v1',sourceHash:'a'.repeat(64),episodes:[{number:5,sceneKeys:['5-1'],lineCount:4},{number:2,sceneKeys:['2-1','2-2'],lineCount:6},{number:9,sceneKeys:['9-1'],lineCount:4}]};
const range=(min,max)=>({min,max});
const timeline=[{episode:5,startLine:1,endLine:4,speech:range(3000,3100),action:range(900,1000),overlap:range(800,900),transition:range(0,20),basis:'原声分句自然语速，动作同期段重叠；非平均集长'},{episode:2,startLine:1,endLine:6,speech:range(4000,4100),action:range(400,500),overlap:range(100,200),transition:range(0,20),basis:'必要动作与原声共用时间线，观看停点独立'}];
function fixture(){return {version:'series-season-scope-v1',id:'S01',revision:1,seasonNumber:1,status:'locked',sourceVersion:'v1',sourceHash:basis.sourceHash,readingEpisodes:[5,2,9],episodeNumbers:[5,2],target:{minSeconds:7200,maxSeconds:9000,planningSeconds:8100},ending:{episode:2,sceneKey:'2-2',endLine:6,closure:'主冲突阶段兑现',hook:'原生未兑现追问',sourceRefs:[{episode:2,startLine:5,endLine:6}],timeline,assetBurden:{characters:['甲'],locations:[],costumes:[],forms:[],props:[]}},confirmation:{kind:'user',basis:'真实用户选择',actorId:'user',at:'2026-10-23T00:00:00Z'}};}
test('source ordered whole-episode boundary and lock required by all consumers',()=>{
 assert.equal(typeof mod.assertSeasonEpisodes,'function','season hard gate is absent');
 const s=fixture();assert.doesNotThrow(()=>mod.validateSeasonScope(s,basis));
 for(const kind of ['storyboard','assets','images','export']){assert.doesNotThrow(()=>mod.assertSeasonEpisodes(s,[5,2],kind));assert.throws(()=>mod.assertSeasonEpisodes(s,[9],kind),{code:'SEASON_SCOPE'});assert.throws(()=>mod.assertSeasonEpisodes({...s,status:'proposed'},[5],kind),{code:'SEASON_NOT_LOCKED'});}
 assert.throws(()=>mod.validateSeasonScope({...s,episodeNumbers:[2,5]},basis),{code:'SEASON_BOUNDARY'});
 assert.throws(()=>mod.validateSeasonScope({...s,ending:{...s.ending,sceneKey:'2-1'}},basis),{code:'SEASON_BOUNDARY'});
 assert.throws(()=>mod.validateSeasonScope({...s,sourceHash:'b'.repeat(64)},basis),{code:'SEASON_SOURCE'});
 assert.throws(()=>mod.validateSeasonScope({...s,sourceVersion:'v2'},basis),{code:'SEASON_SOURCE'});
});
test('timeline overlap is counted once and future parent or form is not a production use',()=>{
 assert.equal(typeof mod.seasonEstimate,'function','shared timeline estimate is absent');
 assert.deepEqual(mod.seasonEstimate(timeline),{minSeconds:7200,maxSeconds:7840});
 assert.throws(()=>mod.seasonEstimate([{...timeline[0],overlap:range(2000,2100)}]),{code:'SEASON_ESTIMATE'});
 const s=fixture();assert.equal(mod.seasonAssetAllowed(s,{sceneRefs:[{episode:5,sceneKey:'5-1'}]},basis),true);
 assert.equal(mod.seasonAssetAllowed(s,{baseKey:'hero',sceneRefs:[{episode:9,sceneKey:'9-1'}]}),false);
 assert.equal(mod.seasonAssetAllowed(s,{episodes:[5]}),false,'no scene evidence is not an in-season use');
});
test('final needs exact coverage, actual shot seconds and explicit duration exception; preview is partial',()=>{
 assert.equal(typeof mod.seasonDelivery,'function','actual-shot final delivery gate is absent');
 const s=fixture(),runs=[{web:{binding:{episodeNumber:5}},source:{sourceRows:[{id:'r1',sceneKey:'5-1'}]},assembly:{draft:{units:[{id:'U1',exitState:'持物在手',shots:[{id:'S1',duration:3600,sourceRefs:['r1']}]}]}}},{web:{binding:{episodeNumber:2}},source:{sourceRows:[{id:'r2',sceneKey:'2-1'},{id:'r3',sceneKey:'2-2'}]},assembly:{draft:{units:[{id:'U2',exitState:'抬头等答复',shots:[{id:'S2',duration:1800,sourceRefs:['r2']},{id:'S3',duration:1800.5,sourceRefs:['r3']}]}]}}}];
 assert.equal(mod.seasonDelivery(s,basis,runs,'final').actualSeconds,7200.5);
 assert.equal(mod.seasonDelivery(s,basis,runs.slice(0,1),'preview').complete,false);
 assert.throws(()=>mod.seasonDelivery(s,basis,runs.slice(0,1),'final'),{code:'SEASON_COVERAGE'});
 const short=structuredClone(runs);short[0].assembly.draft.units[0].shots[0].duration=1;
 assert.throws(()=>mod.seasonDelivery(s,basis,short,'final'),{code:'SEASON_DURATION'});
 assert.equal(mod.seasonDelivery({...s,durationException:{basis:'真实节奏达成，明确同意偏离',confirmation:s.confirmation}},basis,short,'final').durationStatus,'exception-authorized');
});
test('final cannot reorder tail or round actual duration through a boundary',()=>{
 const s=fixture(),runs=s.episodeNumbers.map((n,i)=>({web:{binding:{episodeNumber:n}},source:{sourceRows:basis.episodes.find(e=>e.number===n).sceneKeys.map(k=>({id:k,sceneKey:k}))},assembly:{draft:{units:[{id:'U',exitState:'真实尾态',shots:basis.episodes.find(e=>e.number===n).sceneKeys.map((k,j)=>({id:`S${j}`,duration:i===0?3600:1800,sourceRefs:[k]}))}]}}}));
 assert.throws(()=>mod.seasonDelivery(s,basis,[...runs].reverse(),'final'),{code:'SEASON_COVERAGE'});
 for(const seconds of [7199.9996,9000.0004]){const altered=structuredClone(runs);altered[0].assembly.draft.units[0].shots[0].duration=seconds-3600;assert.throws(()=>mod.seasonDelivery(s,basis,altered,'final'),{code:'SEASON_DURATION'});}
 assert.equal(mod.seasonAssetAllowed(s,{sceneRefs:[{episode:5,sceneKey:'9-1'}]},basis),false);
 assert.equal(mod.seasonAssetAllowed(s,{sceneRefs:[{episode:5,sceneKey:'5-1'}]}),false,'missing actual basis fails closed');
 assert.throws(()=>mod.seasonEstimate([{...timeline[0],speech:range(1e308,1e308),action:range(1e308,1e308),overlap:range(0,0)}]),{code:'SEASON_ESTIMATE'});
});
test('earlier source reference does not stand in for actually staged original scene',()=>{
 const b={sourceVersion:'v',sourceHash:'a'.repeat(64),episodes:[{number:1,sceneKeys:['1-1','1-2'],lineCount:2}]},s={...fixture(),sourceVersion:'v',readingEpisodes:[1],episodeNumbers:[1],ending:{...fixture().ending,episode:1,sceneKey:'1-2',endLine:2,sourceRefs:[{episode:1,startLine:1,endLine:2}],timeline:[{...timeline[0],episode:1,startLine:1,endLine:2}]}};
 const r={web:{binding:{episodeNumber:1}},source:{sourceRows:[{id:'r1',sceneKey:'1-1'},{id:'r2',sceneKey:'1-2'}]},assembly:{draft:{units:[{id:'U',scene:'1-2',exitState:'尾态',shots:[{id:'S1',duration:3600,sourceRefs:['r1']},{id:'S2',duration:3600,sourceRefs:['r2']}]}]}}};
 assert.throws(()=>mod.seasonDelivery(s,b,[r],'final'),{code:'SEASON_COVERAGE'});
});
test('native source scene mapping uses original offsets and timing calibration uses completed shots',()=>{
 assert.equal(typeof mod.bindSeasonSource,'function');assert.equal(typeof mod.seasonCalibration,'function');
 const e={number:1,scenes:[{sceneKey:'A',start:0,end:10,startLine:1,endLine:2},{sceneKey:'B',start:10,end:20,startLine:3,endLine:4}]};
 const source=mod.bindSeasonSource({sourceRows:[{id:'r1',line:2},{id:'r2',standard:{regroup:{originalSourceParts:{body:[{start:11,end:15}]}}}}]},e);
 assert.deepEqual(source.seasonSceneMap,{r1:'A',r2:'B'});
 const s=fixture(),runs=[{web:{binding:{episodeNumber:5}},source:{sourceRows:[{id:'r1',sceneKey:'5-1'}]},assembly:{draft:{units:[{id:'U',scene:'5-1',exitState:'尾态',shots:[{id:'S',duration:100,sourceRefs:['r1']}]}]}}}];
 const result=mod.seasonCalibration(s,basis,runs);assert.equal(result.actualSeconds,100);assert.equal(result.requiresReview,true);assert.deepEqual(result.completedEpisodes,[5]);
});
test('duration exception presence is strictly validated and never treated as truthy authorization',()=>{
 for(const durationException of [{},null,{basis:'自填',confirmation:{kind:'ai',basis:'self'}}]){assert.throws(()=>mod.validateSeasonScope({...fixture(),durationException},basis),{code:'SEASON_CONFIRMATION'});assert.throws(()=>mod.assertSeasonEpisodes({...fixture(),durationException},[5]),{code:'SEASON_CONFIRMATION'});}
 assert.equal(mod.seasonDurationException({...fixture(),durationException:{basis:'用户明确允许本次实际偏离',confirmation:fixture().confirmation}}),true);
});
