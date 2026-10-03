import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ScriptReceptionView} from '../lib/script-resolution-service';

assert.ok(existsSync('app/projects/[projectId]/script-reception-panel.tsx'),'RED: readable script reception panel is missing');
const require=createRequire(import.meta.url);require.extensions['.css']=module=>{module.exports={};};
const {ScriptReceptionPanel}=require('../app/projects/[projectId]/script-reception-panel');
let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('render must not call a model or API');};
const initial:ScriptReceptionView={projectId:'p',title:'测试',canConfirm:true,episodes:[{number:1,title:'第一集'}],selected:{number:1,title:'第一集',sourceVersion:'v1',revision:0,status:'NONE',sourceText:'提示：<script>危险</script>',readingText:null,ready:false,lines:[{line:1,unitId:'u1',entryId:null,target:'UNRESOLVED',kind:'UNRESOLVED',text:'提示：<script>危险</script>'}],diagnostics:[{line:1,code:'UNKNOWN_COLON_LINE',message:'这行需要核对'}],decisions:[],history:[]}};
const html=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial}));
const clear:ScriptReceptionView={...initial,selected:{...initial.selected!,sourceText:'人物：围观学生\n\n围观学生甲：（大笑）快看！\n',ready:true,diagnostics:[],readingText:'内部机器阅读不可作为重复视图',lines:[
 {line:1,unitId:'clear1',entryId:'c1',target:'STRUCTURE',kind:'SCENE_METADATA',text:'人物：围观学生\n'},
 {line:2,unitId:'clear2',entryId:'c2',target:'EXCLUDE',kind:'',text:'　\t\n'},
 {line:3,unitId:'clear3',entryId:'c3',target:'BODY',kind:'DIALOGUE',text:'围观学生甲：（大笑）快看！\n',speaker:'围观学生甲',channel:'SPEECH'}
]}};
const clearHtml=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial:clear}));
assert.doesNotMatch(clearHtml,/核对第1行|核对第3行/,'recognized syntax must not present per-line confirmation');
assert.doesNotMatch(clearHtml,/<pre[^>]*>\s*<\/pre>/,'blank lines do not become rows in the cleaned reading');
assert.match(clearHtml,/无需逐行确认|已自动识别/);
assert.doesNotMatch(clearHtml,/内部机器阅读不可作为重复视图/);
assert.match(html,/原文/);assert.match(html,/标准阅读/);assert.match(html,/第1行/);assert.match(html,/这行需要核对/);assert.match(html,/辅助判断此处/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>危险/);assert.doesNotMatch(html,/<textarea/);
const reader=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial:{...initial,canConfirm:false}}));
assert.match(reader,/管理员或审阅者/);assert.doesNotMatch(reader,/辅助判断此处|确认此项/);
const stale=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial:{...initial,selected:{...initial.selected!,status:'STALE'}}}));
assert.match(stale,/旧核对.*不再生效/);
const multi=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial:{...initial,selected:{...initial.selected!,diagnostics:[{line:1,code:'MULTIPLE_SPEAKERS_ON_LINE',message:'同一行多个说者'}]}}}));
assert.match(multi,/暂不支持/);assert.match(multi,/不能.*绕过/);
assert.equal(calls,0);
const receipt={id:'paid',status:'CANDIDATE' as const,episode:1,sourceVersion:'v1',expectedRevision:0,startLine:1,endLine:1,provider:'CLI' as const,choice:{startLine:1,endLine:1,type:'CREATIVE_GUIDANCE' as const},note:'刷新后恢复的已付候选',usage:{inputTokens:17,outputTokens:null},cached:true};
const mixed:ScriptReceptionView={...initial,selected:{...initial.selected!,ready:true,diagnostics:[],sourceText:'林岚os：到了。【字幕：旅客】',lines:[{line:1,unitId:'mixed1',entryId:'mixed-entry',target:'BODY',kind:'BODY_GROUP',text:'林岚os：到了。【字幕：旅客】'}]}};
const mixedAuto=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial:mixed}));
assert.doesNotMatch(mixedAuto,/核对第1行|辅助判断此处|确认此项/,'recognized mixed dialogue and subtitle need no human classification or model call');
const mixedSaved=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial:{...mixed,selected:{...mixed.selected!,assistance:[receipt]}}}));
assert.match(mixedSaved,/<button\b[^>]*disabled=""[^>]*>采用并保存核对<\/button>/,'an old single-type suggestion must not overwrite a mixed source group');
assert.match(mixedSaved,/字幕/);
const mixedUnknown=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial:{...initial,selected:{...initial.selected!,diagnostics:[{line:1,code:'MIXED_DIALOGUE_ONSCREEN_TEXT',message:'程序尚不能安全分离该字幕形式'}]}}}));
assert.match(mixedUnknown,/<button\b[^>]*disabled=""[^>]*>辅助判断此处（可能消耗）<\/button>/,'a parser capability gap must not invite a paid single-type classifier');
const restored=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial:{...initial,assistProviders:{project:'CLI',jevConfigured:false},selected:{...initial.selected!,assistance:[receipt]}}}));
assert.match(restored,/刷新后恢复的已付候选/);assert.match(restored,/Jev仅类型建议/);assert.match(restored,/17/);assert.doesNotMatch(restored,/reasoning|stdout/);
const unknown=renderToStaticMarkup(createElement(ScriptReceptionPanel,{projectId:'p',initial:{...initial,selected:{...initial.selected!,assistance:[{...receipt,status:'UNKNOWN',choice:null,retryAllowed:true,note:'上次结果未知'}]}}}));
assert.match(unknown,/重复消耗/);assert.match(unknown,/确认风险后重新判断/);
const source=readFileSync('app/projects/[projectId]/script-reception-panel.tsx','utf8');
assert.match(source,/type: 'button'|type="button"/);assert.match(source,/aria-busy/);assert.doesNotMatch(source,/dangerouslySetInnerHTML/);
console.log('PASS script-reception UI SSR: single clean reading surface, clear dialogue without required confirmation, source-numbered diagnostics, role restriction, stale/unsupported notice, no JSON editor/XSS, zero fetch/model calls; browser interaction remains separate');
