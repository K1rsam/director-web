import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';

globalThis.location={search:'?preview=1'};
let networkRequests=0,mutations=0;
globalThis.fetch=async()=>{networkRequests++;throw Error('Network forbidden');};
const base={project:{id:'offline',title:'Offline'},assets:[],units:[],jobs:[],media:[],rules:[],settings:{},providers:[]};
const server=await createServer({logLevel:'error',optimizeDeps:{noDiscovery:true},server:{middlewareMode:true,hmr:false},appType:'custom'});
let passed=0;
try {
  const {DreaminaAccountCard}=await server.ssrLoadModule('/src/Panels.tsx');
  const render=(account,writable=true)=>renderToStaticMarkup(React.createElement(DreaminaAccountCard,{workspace:{...base,dreaminaAccount:account},writable,mutate:async()=>{mutations++;throw Error('Mutation forbidden');}}));
  const enabled=(html,label)=>{const buttons=html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)||[];const button=buttons.find(b=>b.includes(label));assert.ok(button,label);assert.ok(!button.includes('disabled='),label);};
  for(const status of ['logged_out','unknown','error']) {
    const html=render({status,ready:false,identityVerified:false,credits:{total:0}});
    enabled(html,'OAuth 登录');assert.ok(html.includes('登录后显示'));assert.ok(!html.includes('总额度 0'));passed++;
  }
  const html=render({status:'authenticated',ready:true,identityVerified:true,credits:{total:0,member:0,gift:0,purchase:0}});
  enabled(html,'重新登录');enabled(html,'退出登录');assert.ok(html.includes('总额度 0'));assert.ok(html.includes('会员 0'));passed++;
  const pending=render({status:'authorizing',ready:false,authorization:{userCode:'DO_NOT_DISPLAY',verificationUrl:'https://jimeng.jianying.com/ai-tool/cli-auth'}});
  enabled(pending,'打开授权页');assert.ok(!pending.includes('DO_NOT_DISPLAY'));passed++;
  assert.ok(render({status:'logged_out'},false).includes('disabled=""'));passed++;
} finally {await server.close();}
assert.equal(networkRequests,0);assert.equal(mutations,0);
console.log(JSON.stringify({passed,networkRequests,mutations,method:'Actual React account card rendering; no channel or database access'},null,2));
