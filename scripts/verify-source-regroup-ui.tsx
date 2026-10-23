import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createSourceIndex} from '../lib/standard-script';

test('the reception provides direct original-line selection and a free preview before adoption',async()=>{
 const file='app/projects/[projectId]/source-regroup-panel.tsx';assert.ok(existsSync(file),'practical source regroup panel is required');
 const {SourceRegroupPanel}:any=await import('../app/projects/[projectId]/source-regroup-panel' as string);
 const text='甲：你好。△门开。再见。\r\n乙抬手🙂。\r\n',index=createSourceIndex(text,'episode-1');
 const selected={number:1,title:null,sourceVersion:index.sourceVersion,revision:0,status:'NONE',sourceText:text,readingText:null,ready:false,documentRevision:'synthetic-doc',paidCatalogCoverage:[1],lines:index.units.map((unit,i)=>({line:i+1,unitId:unit.id,text:unit.text,target:'UNRESOLVED',kind:'UNRESOLVED',entryId:null})),diagnostics:[],decisions:[],history:[]};
 const html=renderToStaticMarkup(React.createElement(SourceRegroupPanel,{projectId:'synthetic',selected,canConfirm:true,onAdopt:()=>{}}));
 assert.match(html,/原文选段/);assert.match(html,/免费预览/);assert.match(html,/批准来源由服务端记录/);assert.match(html,/加入说者/);assert.match(html,/加入台词/);assert.match(html,/加入动作/);
 assert.equal((html.match(/<textarea/g)??[]).length>=1,true);
 const source=readFileSync(file,'utf8');assert.match(source,/selectionStart/);assert.match(source,/selectionEnd/);assert.match(source,/selectSourceRegroupLineParts/);
});
test('only actual script issue coordinates create an episode and line reception link',async()=>{
 const links:any=await import('../lib/script-reception-link' as string).catch(()=>({}));assert.equal(typeof links.scriptReceptionIssueLink,'function');
 assert.deepEqual(links.scriptReceptionIssueLink('project/id','source.episodes.92.script.L38'),{episode:92,line:38,href:'/projects/project%2Fid/preparation?episode=92#script-line-38'});
 for(const coordinate of ['assets.a.sceneRefs','source.episodes.92.script.L38.extra','source.episodes.NaN.script.L38','source.episodes.92.script.L0'])assert.equal(links.scriptReceptionIssueLink('project',coordinate),null);
});
