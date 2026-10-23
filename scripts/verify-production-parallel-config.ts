/** Offline component render: no browser, network, database or model dispatcher. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

async function main(){
 const built=await build({entryPoints:['app/projects/[projectId]/production/parallel-panel.tsx'],bundle:true,write:false,outdir:'unused-memory-output',platform:'node',format:'cjs',jsx:'automatic',external:['react','react/*']});
 const module={exports:{} as any};new Function('require','module','exports',built.outputFiles.find(f=>f.path.endsWith('.js'))!.text)(createRequire(import.meta.url),module,module.exports);
 const {ParallelPanel}=module.exports;
 const render=(count?:number,paused=false,nextAction:any={kind:'STORYBOARD_CREATE',episodeNumber:1})=>{
  const parallel=count?{version:count===4?'production-parallel-v1':'production-parallel-v2',...(count===6?{laneCount:6}:{}),authorizedAt:paused?'original':undefined}:undefined;
  return renderToStaticMarkup(React.createElement(ParallelPanel,{snapshot:{nextAction,workflow:{projectId:'synthetic',paused,parallel,episodeNumbers:[1,2],costAcknowledged:true},budget:{maxCalls:40,maxTokens:2000000,summary:{calls:0,knownTokens:0,unknownAttempts:0}},parallel:count?{enabled:false,maxConcurrent:count,executionTier:'standard',activeEpisodes:0,completedEpisodes:0,provisionalEpisodes:0,lanes:[],status:'CONFIGURED'}:null},busy:false,onAction:()=>{throw Error('render cannot dispatch');},episodeLink:()=>'/synthetic'}));
 };
 const fresh=render();assert.match(fresh,/保存六路安排/);assert.match(fresh,/value="6" selected=""/);assert.match(fresh,/value="4"/);assert.doesNotMatch(fresh,/aria-label="并行路数" disabled/);
 for(const count of [4,6]){
  const html=render(count,true);assert.match(html,new RegExp(`继续原${count===4?'四':'六'}路制作`));assert.match(html,/aria-label="并行路数" disabled=""/);assert.match(html,new RegExp(`value="${count}" selected=""`));
 }
 for(const kind of ['DIRECTION','WAIT_DIRECTION_CONFIRM','WAIT_DIRECTION_REPAIR']){
  const html=render(6,false,{kind,message:'方向候选待补，已付资料保留。'});
  assert.match(html,/方向候选待补，已付资料保留/);assert.match(html,/href="\/projects\/synthetic\/preparation#series-direction"/);assert.match(html,/查看并确认全剧方向/);
 }
 console.log('PASS parallel config offline render: new six/four selection and frozen original resume; zero browser/model calls');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
