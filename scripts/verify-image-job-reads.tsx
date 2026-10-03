/** Actual hook + isolated browser HTTP boundary. No Next, DB, ChatGPT, CLI or provider calls. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import type { ImageJob } from '../lib/asset-image-job-contract';

type Props = { projectId: string; materialVersion: string };
declare global {
  interface Window {
    imageJobHarness: {
      setProps: (props: Props) => void;
      refresh: () => Promise<ImageJob[]>;
      renders: Array<{ project: string; material: string; ids: string[] }>;
      setHidden: (hidden: boolean) => void;
      reads: Array<{ url: string; cache: string | undefined; hadSignal: boolean }>;
      completedReads: number;
    };
  }
}
const origin = 'http://image-job-reads.invalid';
function job(id: string, status: ImageJob['status'] = 'REVIEW', revision = 0): ImageJob {
  return { id, key: 'fixture-asset', name: id, revision, status, provider: 'CHATGPT_WEB', dispatchMode: 'MANUAL', stale: false,
    prompt: 'synthetic', createdAt: '2026-10-04T00:00:00Z', error: '', expectedCount: 1, quality: '1K', aspectRatio: '1:1', references: [], images: [], usedImageIds: [] };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until(check: () => Promise<boolean> | boolean, message: string) {
  const deadline = performance.now() + 3500;
  while (performance.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
}
async function ids(page: Page, consumer = 'grid') {
  return JSON.parse(await page.getByTestId(consumer).textContent() ?? '[]') as string[];
}

async function main() {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{useProjectImageJobs}from'./app/projects/[projectId]/asset-prompts/use-image-jobs';
    const renders=[];window.imageJobHarness.renders=renders;
    function Consumer({name,jobs,refresh}){return <section><output data-testid={name}>{JSON.stringify(jobs.map(job=>job.id))}</output><button data-testid={name+'-refresh'} onClick={()=>refresh().catch(()=>{})}>refresh</button></section>}
    function Host(){const[props,setProps]=useState({projectId:'A',materialVersion:'v1'});
      const state=useProjectImageJobs(props.projectId,props.materialVersion);
      window.imageJobHarness.setProps=setProps;window.imageJobHarness.refresh=state.refresh;
      renders.push({project:props.projectId,material:props.materialVersion,ids:state.jobs.map(job=>job.id)});
      return <main data-testid="host" data-project={props.projectId} data-material={props.materialVersion}>
        <Consumer name="grid" jobs={state.jobs} refresh={state.refresh}/><Consumer name="editor" jobs={state.jobs} refresh={state.refresh}/>
        <output data-testid="loading">{String(state.loading)}</output><output data-testid="error">{state.error}</output>
      </main>}
    createRoot(document.getElementById('root')).render(<Host/>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }) });
  let checks = 0;
  async function fixture(initial: ImageJob[], options: { ignoreAbort?: boolean; frozenClock?: boolean } = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
    page.setDefaultTimeout(3000);
    const gets: string[] = [], posts: string[] = [], errors: string[] = [], gates: ReturnType<typeof gate>[] = [];
    const records = new Map<string, ImageJob[]>([['A', initial], ['B', [job('B-current')]]]);
    const replies = new Map<string, Array<{ jobs: ImageJob[]; hold?: ReturnType<typeof gate> }>>();
    const enqueue = (project: string, jobs: ImageJob[], held = false) => {
      const hold = held ? gate() : undefined;
      if (hold) gates.push(hold);
      const pending = replies.get(project) ?? []; pending.push({ jobs, hold }); replies.set(project, pending);
      return hold;
    };
    let closing = false;
    page.on('pageerror', error => errors.push(error.message));
    // Raw init-script source avoids Node's TSX function-name helpers leaking
    // into serialized browser callbacks. The only injected value is a boolean.
    await context.addInitScript({ content: `
      let hidden=false;
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
      const harness=window.imageJobHarness={renders:[],reads:[],completedReads:0,setProps:()=>{},refresh:async()=>[],
        setHidden:value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));}};
      const originalFetch=window.fetch;
      window.fetch=(input,init)=>{
        harness.reads.push({url:String(input),cache:init?.cache,hadSignal:!!init?.signal});
        return originalFetch(input,${options.ignoreAbort === true} ? {...init,signal:undefined}:init).then(async response=>{
          await response.clone().arrayBuffer();harness.completedReads++;return response;
        },error=>{harness.completedReads++;throw error;});
      };
    ` });
    if (options.frozenClock) {
      const time = new Date('2026-10-04T00:00:00Z');
      await page.clock.install({ time }); await page.clock.pauseAt(time);
    }
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { errors.push('Unexpected external network'); return await route.abort(); }
        if (request.method() !== 'GET') { posts.push(`${request.method()} ${url.pathname}`); return await route.abort(); }
        if (url.pathname === '/') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="UTF-8"><div id="root"></div><script src="/fixture.js"></script>' });
        if (url.pathname === '/fixture.js') return await route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles[0].text });
        const match = /^\/projects\/([^/]+)\/asset-prompts\/images$/.exec(url.pathname);
        if (!match || url.search) { errors.push('Unexpected HTTP path'); return await route.abort(); }
        const project = match[1]; gets.push(project);
        const response = replies.get(project)?.shift() ?? { jobs: records.get(project) ?? [] };
        if (response.hold) await response.hold.promise;
        await route.fulfill({ json: { jobs: response.jobs }, headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { if (!closing) errors.push(error instanceof Error ? error.message : 'Route failed'); }
    });
    const open = async () => { await page.goto(origin + '/'); await new Promise(resolve => setTimeout(resolve, 30)); assert.deepEqual(errors, [], 'Fixture mount must succeed before reading assertions'); };
    const shown = (expected: string[]) => until(async () => JSON.stringify(await ids(page)) === JSON.stringify(expected) && JSON.stringify(await ids(page, 'editor')) === JSON.stringify(expected), 'Grid/editor did not receive the same expected snapshot');
    const settled = async (count: number) => {
      await until(async () => (await page.evaluate(() => window.imageJobHarness.completedReads)) === count, 'Expected HTTP reads have not settled');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const close = async () => {
      assert.deepEqual(posts, [], 'Reading and polling must never POST or dispatch generation');
      assert.deepEqual(errors, [], 'No browser errors or external services are permitted');
      const reads = await page.evaluate(() => window.imageJobHarness.reads);
      assert.ok(reads.every(read => read.cache === 'no-store' && read.hadSignal), 'Each actual hook GET uses a private fresh read and an abort lifecycle');
      closing = true; gates.forEach(hold => hold.release()); await context.close();
    };
    return { page, gets, records, enqueue, open, shown, settled, close };
  }
  const check = async (name: string, run: () => Promise<void>) => { await run(); checks++; console.log(`PASS ${name}`); };
  try {
    await check('grid and editor share the initial GET; concurrent forced refreshes coalesce behind an in-flight read', async () => {
      const f = await fixture([job('A-initial')]); const initial = f.enqueue('A', [job('A-initial')], true)!;
      await f.open(); await until(() => f.gets.length === 1, 'Initial GET missing');
      await f.page.evaluate(() => { void Promise.all([window.imageJobHarness.refresh(), window.imageJobHarness.refresh()]).catch(() => {}); });
      assert.equal(f.gets.length, 1, 'Refresh does not duplicate an outstanding request');
      f.records.set('A', [job('A-fresh', 'REVIEW', 1)]); initial.release();
      await f.shown(['A-fresh']); assert.deepEqual(f.gets, ['A', 'A']);
      await f.close();
    });
    await check('both consumers see changed data from an explicit refresh; concurrent settled refreshes share one GET', async () => {
      const f = await fixture([job('A-v1')]); await f.open(); await f.shown(['A-v1']);
      f.records.set('A', [job('A-v2', 'REVIEW', 2)]);
      await f.page.evaluate(() => Promise.all([window.imageJobHarness.refresh(), window.imageJobHarness.refresh()]));
      await f.shown(['A-v2']); assert.deepEqual(f.gets, ['A', 'A']); await f.close();
    });
    await check('project changes hide the old snapshot immediately and reject uncancellable late project responses', async () => {
      const f = await fixture([job('A-visible')], { ignoreAbort: true }); await f.open(); await f.shown(['A-visible']);
      const old = f.enqueue('A', [job('A-late')], true)!, current = f.enqueue('B', [job('B-current')], true)!;
      await f.page.evaluate(() => { void window.imageJobHarness.refresh().catch(() => {}); });
      await until(() => f.gets.length === 2, 'Old project refresh missing');
      await f.page.evaluate(() => window.imageJobHarness.setProps({ projectId: 'B', materialVersion: 'v1' }));
      await until(() => f.gets.length === 3, 'New project read missing'); await f.shown([]);
      current.release(); await f.shown(['B-current']); old.release();
      await f.settled(3); await f.shown(['B-current']);
      const renders = await f.page.evaluate(() => window.imageJobHarness.renders);
      assert.ok(renders.filter(row => row.project === 'B').every(row => row.ids.every(id => !id.startsWith('A-'))), 'No render of project B exposes the previous project snapshot');
      assert.deepEqual(f.gets, ['A', 'A', 'B']); await f.close();
    });
    await check('material changes reject an uncancellable older material read within the same project', async () => {
      const f = await fixture([job('A-old-material')], { ignoreAbort: true }); const old = f.enqueue('A', [job('A-old-material')], true)!;
      await f.open(); await until(() => f.gets.length === 1, 'Old material read missing');
      f.records.set('A', [job('A-current-material')]);
      await f.page.evaluate(() => window.imageJobHarness.setProps({ projectId: 'A', materialVersion: 'v2' }));
      await f.shown(['A-current-material']); old.release(); await f.settled(2);
      await f.shown(['A-current-material']);
      const renders = await f.page.evaluate(() => window.imageJobHarness.renders);
      assert.ok(renders.filter(row => row.material === 'v2').every(row => !row.ids.includes('A-old-material')));
      assert.deepEqual(f.gets, ['A', 'A']); await f.close();
    });
    await check('forced refreshes waiting on an old scope cannot launch another old-scope GET after project change', async () => {
      const f = await fixture([job('A-old')], { ignoreAbort: true }); const old = f.enqueue('A', [job('A-old')], true)!;
      await f.open(); await until(() => f.gets.length === 1, 'Initial pending scope missing');
      await f.page.evaluate(() => { void Promise.all([window.imageJobHarness.refresh(), window.imageJobHarness.refresh()]).catch(() => {}); });
      await f.page.evaluate(() => window.imageJobHarness.setProps({ projectId: 'B', materialVersion: 'v1' }));
      await f.shown(['B-current']); old.release(); await f.settled(2);
      await f.shown(['B-current']); assert.deepEqual(f.gets, ['A', 'B']); await f.close();
    });
    await check('actual timers poll active jobs after 5 seconds, idle jobs after 30, suspend while hidden and resume immediately', async () => {
      const f = await fixture([job('active', 'RUNNING')], { frozenClock: true }); await f.open(); await f.shown(['active']);
      await f.page.clock.runFor(4999); assert.equal(f.gets.length, 1);
      f.records.set('A', [job('still-active', 'WAITING_EXECUTOR')]);
      await f.page.clock.runFor(1); await f.shown(['still-active']); assert.equal(f.gets.length, 2);
      f.records.set('A', [job('idle', 'REVIEW')]);
      await f.page.clock.runFor(5000); await f.shown(['idle']); assert.equal(f.gets.length, 3);
      await f.page.clock.runFor(29999); assert.equal(f.gets.length, 3);
      f.records.set('A', [job('idle-refreshed')]);
      await f.page.clock.runFor(1); await f.shown(['idle-refreshed']); assert.equal(f.gets.length, 4);
      await f.page.evaluate(() => window.imageJobHarness.setHidden(true));
      await f.page.clock.runFor(90000); assert.equal(f.gets.length, 4, 'Hidden page timers cannot send GETs');
      f.records.set('A', [job('visible-again')]);
      await f.page.evaluate(() => window.imageJobHarness.setHidden(false));
      await f.shown(['visible-again']); assert.equal(f.gets.length, 5, 'Visibility restoration immediately reads current jobs');
      await f.close();
    });
    console.log(`PASS image-job reads: ${checks} isolated actual-hook browser checks; shared GET and fresh refresh, project/material lifecycle guards, exact poll boundaries, hidden-page pause/resume; POST/provider/production DB calls 0.`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Image-job read verification failed'); process.exitCode = 1; });
