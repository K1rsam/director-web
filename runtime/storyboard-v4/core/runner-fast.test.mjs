import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRunnerArgs,runModel} from './runner.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {digest} from './shared.mjs';

const paths={cwd:'/tmp/fast-work',outputPath:'/tmp/fast-output',instructionsPath:'/tmp/fast-instructions'};
test('explicit new-task model selection reaches CLI without opening legacy frozen requests',async t=>{
 const modelSelection={version:'production-model-selection-v1',model:'gpt-6-astra',reasoning:'high'};
 const args=buildRunnerArgs({...paths,...modelSelection,modelSelection});
 assert.equal(args[args.indexOf('--model')+1],'gpt-6-astra');assert.ok(args.includes('model_reasoning_effort="high"'));
 assert.ok(!args.includes('features.fast_mode=true'));
 assert.throws(()=>buildRunnerArgs({...paths,model:'gpt-6-astra',reasoning:'high'}),{code:'MODEL_POLICY_CHANGED'});
 assert.throws(()=>buildRunnerArgs({...paths,model:'gpt-6-sol',reasoning:'high',modelSelection}),{code:'MODEL_POLICY_CHANGED'});
 const directory=await mkdtemp(path.join(tmpdir(),'runner-selection-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const request={stage:'author',prompt:'原始源文',instructions:'完整创作规则',settings:{model:'gpt-6-astra',reasoning:'high'},inputHash:'choice',promptHash:digest('原始源文')};
 await assert.rejects(runModel(request,{directory,attemptId:'choice',modelSelection,shouldDispatch:()=>false,executable:'/must-not-spawn'}),e=>e.requestOutcome==='NOT_SENT');
 const saved=JSON.parse(await readFile(path.join(directory,'attempts/choice/request.json'),'utf8'));
 assert.deepEqual(saved.executionSettings.modelSelection,modelSelection);assert.equal(saved.prompt,request.prompt);
});
test('Fast is a per-invocation service tier, not a weaker reasoning setting or a model suffix',()=>{
 const args=buildRunnerArgs({...paths,serviceTier:'fast'});
 assert.ok(args.includes('service_tier="priority"'),'Fast须显式传给忽略个人配置的执行器');
 assert.ok(args.includes('features.fast_mode=true'));
 assert.equal(args[args.indexOf('--model')+1],'gpt-6.1-sol');assert.ok(args.includes('model_reasoning_effort="medium"'));
 assert.ok(args.includes('--ignore-user-config'));
 assert.ok(!buildRunnerArgs(paths).some(v=>v.startsWith('service_tier=')),'旧任务不自动转换Fast');
 assert.throws(()=>buildRunnerArgs({...paths,serviceTier:'ultrafast'}),{code:'INVALID_SERVICE_TIER'});
});
test('a withdrawn Fast request saves its execution tier without spawning a CLI or changing the creative prompt',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'runner-fast-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const request={stage:'author',prompt:'原始创作输入',instructions:'原始创作规则',settings:{model:'gpt-6.1-sol',reasoning:'medium'},inputHash:'fast-test',promptHash:digest('原始创作输入')};
 await assert.rejects(runModel(request,{directory,attemptId:'fast',serviceTier:'fast',shouldDispatch:()=>false,executable:'/this-must-never-spawn'}),e=>e.requestOutcome==='NOT_SENT');
 const saved=JSON.parse(await readFile(path.join(directory,'attempts/fast/request.json'),'utf8'));
 const receipt=JSON.parse(await readFile(path.join(directory,'attempts/fast/receipt.json'),'utf8'));
 assert.equal(saved.prompt,request.prompt);assert.equal(saved.instructions,request.instructions);
 assert.equal(saved.executionSettings?.serviceTier,'fast');assert.equal(receipt.requestedServiceTier,'priority');
 assert.equal(receipt.requestOutcome,'NOT_SENT');assert.equal(receipt.localProcess,null);
});
