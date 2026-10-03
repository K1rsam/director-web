/** Real page, reader and auth checks on disposable SQLite; only Next request APIs are substituted. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function stub(name: string, exports: unknown) {
  const id = require.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
}
async function main() {
  assert.ok(existsSync('app/projects/[projectId]/foundation/handoff/page.tsx'), '缺少共享只读交接预览页');
  const directory = mkdtempSync(path.join(tmpdir(), 'light-preview-')), url = `file:${directory}/test.db`;
  process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  let writes = 0, reads = 0, protectedReads = 0, track = false;
  const db = new PrismaClient({ datasourceUrl: url }).$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    if (track) { reads++; if (/^(create|update|delete|upsert)/.test(operation)) writes++; if (!['Session', 'User', 'ProjectRole'].includes(model)) protectedReads++; }
    return query(args);
  } } } });
  stub('../lib/prisma', { prisma: db });
  let token: string | undefined;
  const navigation = { redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); }, notFound: () => { throw new Error('NOT_FOUND'); } };
  stub('next/navigation', navigation);
  // Run the actual guards; the cookies/redirect transport belongs to the Next request, absent in this process.
  const auth = { exports: {} };
  const compiled = ts.transpileModule(readFileSync('lib/auth.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', compiled)((name: string) => name === 'server-only' ? {} : name === 'next/headers'
    ? { cookies: async () => ({ get: () => token ? { value: token } : undefined }) } : name === 'next/navigation' ? navigation
      : name === '@/lib/prisma' ? { prisma: db } : name.startsWith('@/') ? require(`../${name.slice(2)}`) : require(name), auth, auth.exports);
  stub('../lib/auth', auth.exports);
  stub('../app/ui/account-menu', { AccountMenu: () => null });
  try {
    const { createSession } = require('../lib/auth-service');
    const { importProjectFromText } = require('../lib/workflow');
    const { preprocessProject } = require('../lib/project-preprocess');
    const { loadFoundationInputs } = require('../lib/foundation-state');
    const { createEmptyDocument, mergeDocumentF2, saveFoundationDocument } = require('../lib/foundation-document');
    const { requireProductionCatalogAuthor } = require('../lib/foundation-production-contracts');
    const { LIGHT_ASSET_METHOD_VERSION } = require('../lib/foundation-production-prompts');
    const user = await db.user.create({ data: { username: 'preview-owner', email: 'preview-owner@local.invalid', passwordHash: 'disabled' } });
    const other = await db.user.create({ data: { username: 'preview-other', email: 'preview-other@local.invalid', passwordHash: 'disabled' } });
    const content = '第8集\n\n8-1 日 内 收容所\n\t　\n人物：甲\n\n甲：<script>整座城？</script>\n第9集\n9-1 夜 内 宴会厅\n人物：甲\n△无关礼服不可泄漏。\n';
    const { project } = await importProjectFromText({ ownerUserId: user.id, title: '交接鉴权测试', sourceName: 'synthetic.txt', sourceText: content }, db);
    await preprocessProject(project.id, db);
    const input = await loadFoundationInputs(project.id, db), empty = createEmptyDocument(input);
    const catalog = requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [8, 9], assets: [
      { name: '甲', type: 'CH', episodes: [8], sceneRefs: [{ episode: 8, sceneKey: '8-1' }], preparation: { mode: 'REFERENCE' }, variants: [{ name: '灰衣', episodes: [8], sceneRefs: [{ episode: 8, sceneKey: '8-1' }], preparation: { mode: 'INLINE' } }] },
      { name: '无关礼服', type: 'PROP', episodes: [9], sceneRefs: [{ episode: 9, sceneKey: '9-1' }], preparation: { mode: 'REFERENCE' } }
    ] }, input.sourceIndex, [8, 9]);
    const doc = mergeDocumentF2({ ...empty, workflow: 'LIGHT_STAGE1_V1', assetMethodVersion: LIGHT_ASSET_METHOD_VERSION }, catalog, input.sourceIndex);
    doc.editorialCoverage = [8, 9]; doc.editorialTodos = [{ id: 'followup', owner: 'STAGE2', episodes: [8], note: '保留本句停顿。' }];
    await saveFoundationDocument(db, project.id, empty.revision, doc, 'isolated preview fixture');
    const ownerSession = await createSession(db, user.id), otherSession = await createSession(db, other.id);
    const Page = require('../app/projects/[projectId]/foundation/handoff/page').default;
    const page = (episode: string | undefined = '8') => Page({ params: Promise.resolve({ projectId: project.id }), searchParams: Promise.resolve({ episode }) });
    const before = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } });
    track = true;
    await assert.rejects(() => page(), /REDIRECT:\/login/);
    assert.equal(reads, 0, '未登录不能读取项目或原文');
    token = otherSession.token;
    await assert.rejects(() => page(), /NOT_FOUND/);
    assert.equal(protectedReads, 0, '无项目权限时不能先读取项目、原文或工作稿');
    assert.equal(writes, 0);
    token = ownerSession.token;
    const html = renderToStaticMarkup(await page());
    for (const text of ['分镜输入检查', '不是进入第三阶段的必经步骤', '本集原文', '逐场基础与变体', '准备方式', '后续提醒', '保留本句停顿。']) assert.ok(html.includes(text), text);
    for (const title of ['全剧方向与已采用设计', '必要事实与跨集状态', '本集原文', '逐场基础与变体', '前场事实']) {
      const details = html.match(new RegExp(`<details\\b([^>]*)>\\s*<summary[^>]*>${title}`));
      assert.ok(details, `${title} can be expanded on demand`);
      assert.doesNotMatch(details[1], /\bopen(?:\s|=|$)/, `${title} is collapsed by default`);
    }
    assert.ok(html.includes('&lt;script&gt;整座城？&lt;/script&gt;') && !html.includes('<script>整座城？'));
    assert.equal((html.match(/整座城？/g) ?? []).length, 1, '原文只展示一份');
    assert.ok(html.includes('第8集\n8-1 日 内 收容所\n人物：甲\n甲：&lt;script&gt;整座城？&lt;/script&gt;'), 'Read-only handoff display folds blank lines but keeps each source line');
    const { readLightEpisodeFoundation } = require('../lib/light-foundation-reader');
    const packet = (await readLightEpisodeFoundation(project.id, 8, db)).packet;
    const {readProductionEpisodeHandoff}=require('../lib/episode-upstream-material');
    const {GET:download}=require('../app/projects/[projectId]/foundation/handoff/download/route');
    const materials=await readProductionEpisodeHandoff(project.id,8);
    const downloadContext={params:Promise.resolve({projectId:project.id})};
    const downloaded=await download(new Request(`http://localhost/projects/${project.id}/foundation/handoff/download?episode=8&materialVersion=${materials.materialVersion}`),downloadContext);
    assert.equal(downloaded.status,200);
    assert.equal((await downloaded.json()).materialVersion,materials.materialVersion,'download and preview use the same scoped material');
    assert.equal((await download(new Request(`http://localhost/projects/${project.id}/foundation/handoff/download?episode=8&materialVersion=stale`),downloadContext)).status,409);
    const beforeInvalid=protectedReads;
    assert.equal((await download(new Request(`http://localhost/projects/${project.id}/foundation/handoff/download?episode=`),downloadContext)).status,400);
    assert.equal(protectedReads,beforeInvalid,'blank input is invalid, not episode zero and must not start reading a production packet');
    assert.equal(packet.sourceText, before.find(episode => episode.number === 8)?.content, 'Actual downstream packet retains the full original spacing');
    assert.ok(!html.includes('无关礼服') && !html.includes('pipelineRuns') && !html.includes('INPUT_JSON'));
    assert.ok(!/action="[^"]*generate|生成视频|生成分镜/.test(html));
    assert.equal(writes, 0, '正常预览零源写、零模型记录');
    assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 0);
    assert.deepEqual(await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } }), before);
    assert.match(renderToStaticMarkup(await page('100')), /集号不存在|没有找到.*集/);
    assert.match(renderToStaticMarkup(await page('abc')), /无效|选择/);
    assert.match(renderToStaticMarkup(await Page({ params: Promise.resolve({ projectId: project.id }), searchParams: Promise.resolve({}) })), /选择.*集/);
    const projectPage = readFileSync('app/projects/[projectId]/page.tsx', 'utf8');
    assert.ok(!projectPage.includes('/foundation/handoff'), 'P4 owns the only prominent input-check entry on the project page');
    assert.ok(projectPage.indexOf('/foundation/export') > projectPage.indexOf('id="foundation-history"'), 'full JSON export remains in the collapsed history area');
    console.log('PASS readonly preview: actual page/reader/auth, denied login and cross-account, one source copy, escaped text, no mutation/model calls');
  } finally { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
