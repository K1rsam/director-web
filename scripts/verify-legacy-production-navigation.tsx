import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as presentation from "../lib/episode-presentation";
import { EpisodeSidebar } from "../app/ui/episode-sidebar";
import * as motion from "../app/ui/motion-selection";
import * as projectEntry from "../lib/project-entry";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
// Evaluate the real modules in memory; replace only database/auth/action and unrelated UI boundaries.
function load(file: string, dependencies: Record<string, unknown>) {
  const source = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  const localRequire = (id: string) => {
    if (id in dependencies) return dependencies[id];
    if (["react", "react/jsx-runtime", "next/link"].includes(id)) return require(id);
    throw new Error(`Unexpected dependency in isolated navigation test: ${id}`);
  };
  new Function("require", "module", "exports", source)(localRequire, module, module.exports);
  return module.exports;
}

const rows = [
  { id: "zero", number: 0, title: "第0集 序章剧情" },
  { id: "one", number: 1, title: "第一集 正文" },
  { id: "background", number: 3, title: "作者资料" },
  { id: "unresolved", number: 7, title: "待确认" }
].map(row => ({ ...row, pipelineRuns: [], _count: { storyboardShots: 0, seedanceUnits: 0 } }));
const project = { id: "fixture", title: "导航验证", style: null, aspectRatio: "16:9", executionMode: "CLI", assets: [], episodes: rows };
const db = {
  episode: { findFirst: async ({ where }: { where: { id: string } }) => {
    const row = rows.find(item => item.id === where.id);
    return row ? { ...row, projectId: project.id, project, content: "保留历史正文", scriptScenes: [], seedanceUnits: [], pipelineRuns: [], workflowIssues: [], taskPackages: [{ payload: "保留历史信息包" }] } : null;
  } },
  sceneSnapshot: { findFirst: async () => ({ content: JSON.stringify({ sourceStructure: { sections: [
    { kind: "EPISODE", episodeNumber: 0 }, { kind: "EPISODE", episodeNumber: 1 },
    { kind: "BACKGROUND", episodeNumber: 3 }, { kind: "UNRESOLVED", episodeNumber: 7 }
  ] } }) }) }
};
const studio = load("lib/studio.ts", {
  "@/lib/import-script": presentation, "@/lib/prisma": { prisma: db }, "@/lib/assets": {}, "@/lib/shot-cells": {},
  "@/lib/episode-pipeline-contracts": { PIPELINE_STAGE_CONFIGS: [], buildSourcePackage: () => ({ scenes: [] }) },
  "@/lib/foundation-state": {}, "@/lib/project-foundation-contracts": {}, "@/lib/foundation-run-usage": {}, "./foundation-run-history": {}
});
const production = load("lib/production-episodes.ts", { "./prisma": { prisma: db } });
const chrome = load("app/ui/app-chrome.tsx", {
  "./account-menu": { AccountMenu: () => null }, "./episode-sidebar": { EpisodeSidebar }, "./motion-selection": motion,
  "@/lib/episode-presentation": presentation
});
const noop = () => null;
const pageDependencies: Record<string, unknown> = {
  "@/lib/episode-presentation": presentation, "@/lib/production-episodes": production,
  "next/navigation": { notFound: () => { throw new Error("NOT_FOUND"); } },
  "@/lib/auth": { requireSessionUser: async () => ({ id: "fixture-user" }) }, "@/lib/studio": studio,
  "@/app/ui/app-chrome": chrome, "@/app/ui/motion-selection": motion, "@/lib/shot-cells": {}, "@/lib/execution-errors": {},
  "@/app/actions": {}, "@/app/ui/workbench-empty": { WorkbenchEmpty: noop },
  "./episode-pipeline-button": { EpisodePipelineButton: noop }, "./reset-episode-button": { ResetEpisodeButton: noop },
  "./stop-pipeline-button": { StopPipelineButton: noop }, "../../../../mode-switch": { ModeSwitch: noop },
  "./unit-prompt-card": { UnitPromptCard: noop }, "./export-episode": { ExportEpisodeButtons: noop }, "./workspace-grid": { WorkspaceGrid: noop }
};
const page = load("app/projects/[projectId]/episodes/[episodeId]/page.tsx", pageDependencies).default;
const failures: string[] = [];
const check = async (name: string, action: () => unknown | Promise<unknown>) => {
  try { await action(); }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
};
const pageFor = (episodeId: string): Promise<ReactElement<any>> => page({ params: Promise.resolve({ projectId: "fixture", episodeId }), searchParams: Promise.resolve({ view: "units" }) });
const navigation = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(chrome.AppChrome, { title: "历史分集", eyebrow: "验证", projectId: "fixture", activeSection: "episode", ...props, utility: null, primaryAction: null, children: null }));

async function main() {
  await check("studio retains zero for source-aware navigation while legacy zero remains closed", async () => {
    const view = await studio.getEpisodeStudio("fixture", "one", "fixture-user");
    assert.deepEqual(view.episodeNav.map((item: { number: number }) => item.number), [0, 1, 3, 7]);
    assert.equal(await studio.getEpisodeStudio("fixture", "zero", "fixture-user"), null);
  });
  await check("legacy page passes only source-confirmed production navigation", async () => {
    const view = await pageFor("one");
    assert.deepEqual(view.props.episodes.map((item: { number: number }) => item.number), [0, 1]);
    assert(view.props.episodes.every((item: { productionEligible?: boolean }) => item.productionEligible === true));
    assert.match(renderToStaticMarkup(view.props.utility), /进入第三阶段/);
    assert.equal(view.props.primaryAction,undefined,'legacy history cannot display the disabled E0–E5 production action');
    assert.equal(/<form\b/.test(renderToStaticMarkup(view.props.utility)),false,'legacy toolbar is read-only: no update/reset/stop writes');
  });
  await check("legacy background history remains readable without a current-episode creation link", async () => {
    const view = await pageFor("background");
    assert(view.props.children);
    assert.equal(/进入第三阶段/.test(renderToStaticMarkup(view.props.utility)), false, "Background history must not offer current-episode creation");
  });
  await check("desktop and mobile route real zero to storyboard and preserve positive legacy hrefs", () => {
    const html = navigation({ activeEpisodeId: "one", episodes: rows.slice(0, 2).map(row => ({ ...row, productionEligible: true })) });
    assert.equal([...html.matchAll(/href="\/projects\/fixture\/episodes\/zero\/storyboard"/g)].length, 2);
    assert.equal([...html.matchAll(/href="\/projects\/fixture\/episodes\/one"/g)].length, 2);
    assert.equal(/href="\/projects\/fixture\/episodes\/zero"/.test(html), false, "Real zero must never link to the closed legacy page");
  });
  await check("main stage-three navigation cannot select an excluded active episode", () => {
    const html = navigation({ activeEpisodeId: "background", episodes: rows.map(row => ({ ...row, productionEligible: row.number === 0 || row.number === 1 })) });
    assert.equal(/href="\/projects\/fixture\/episodes\/background\/storyboard"/.test(html), false, "Main navigation must not promote excluded active history to production");
    assert.match(html, /href="\/projects\/fixture\/episodes\/zero\/storyboard"/);
    assert.equal(/第三阶段 · 分镜创作/.test(navigation({ activeEpisodeId: "background", episodes: [] })), false, "No eligible episodes means no creation navigation");
  });
  await check("home counts real zero and normal episodes, excludes positive background, and retains legacy/archive display", async () => {
    const card = (id: string, numbers: number[], archived = false) => ({ ...project, id, title: id, description: "离线项目卡", updatedAt: new Date(0), archivedAt: archived ? new Date(0) : null,
      _count: { assets: 0, episodes: numbers.length, sceneSnapshots: 0 }, episodes: numbers.map(number => ({ id: `${id}-${number}`, number, title: `第${number}集`, _count: { seedanceUnits: 1 } })) });
    const projects = [card("source-zero", [0, 1]), card("source-background", [1, 3]), card("legacy", [0, 1, 3])];
    const archivedProjects = [card("archived", [0, 1, 3], true)];
    const sources: Record<string, unknown> = {
      "source-zero": { sourceStructure: { sections: [{ kind: "EPISODE", episodeNumber: 0 }, { kind: "EPISODE", episodeNumber: 1 }] } },
      "source-background": { sourceStructure: { sections: [{ kind: "EPISODE", episodeNumber: 1 }, { kind: "BACKGROUND", episodeNumber: 3 }] } }
    };
    const sourceReads: string[] = [], metrics: Parameters<typeof projectEntry.deriveProjectCardState>[0][] = [];
    const homeProduction = load("lib/production-episodes.ts", { "./prisma": { prisma: { sceneSnapshot: { findFirst: async ({ where }: { where: { projectId: string } }) => {
      sourceReads.push(where.projectId);
      return where.projectId in sources ? { content: JSON.stringify(sources[where.projectId]) } : null;
    } } } } });
    const home = load("app/page.tsx", {
      "@/lib/auth": pageDependencies["@/lib/auth"], "@/lib/project-library": { getProjectLibrary: async () => ({ projects, archivedProjects }) },
      "@/lib/foundation-delivery": { getFoundationDeliveryState: async () => ({ complete: true }) }, "@/lib/production-episodes": homeProduction,
      "@/lib/project-entry": { ...projectEntry, deriveProjectCardState: (value: Parameters<typeof projectEntry.deriveProjectCardState>[0]) => { metrics.push(value); return projectEntry.deriveProjectCardState(value); } },
      "@/app/actions": {}, "./delete-project-button": { DeleteProjectButton: noop }, "./ui/app-chrome": chrome, "./page-surfaces.css": {}
    }).default;
    const html = renderToStaticMarkup(await home({ searchParams: Promise.resolve({}) }));
    assert.deepEqual(metrics, [
      { episodeCount: 2, foundationReady: true, unitEpisodeCount: 2 },
      { episodeCount: 1, foundationReady: true, unitEpisodeCount: 1 },
      { episodeCount: 2, foundationReady: true, unitEpisodeCount: 2 }
    ], "Home must pass source-scoped counts to the unchanged progress algorithm");
    for (const [id, count] of [["source-zero", 2], ["source-background", 1], ["legacy", 2]] as const) {
      const renderedCard = html.match(new RegExp(`aria-labelledby="project-${id}-title"[\\s\\S]*?</article>`))?.[0] ?? "";
      assert(renderedCard.includes(`<dt>剧集</dt><dd>${count}<span>`), `${id} must render the expected episode count`);
      assert(renderedCard.includes(`<dt>已有分镜单元</dt><dd>${count}<span>`), `${id} must render the expected unit-episode count`);
    }
    assert.deepEqual(sourceReads.sort(), projects.map(item => item.id).sort(), "Archived history must not acquire new source filtering");
    assert(html.includes('id="archived-project-archived-title"') && html.includes("2 集 · 归档于"), "Archived history and its original count stay visible");
  });
  await check("project episode entries use saved scene counts instead of scene headings as names", async () => {
    const episodes = [
      { id: "scene-heading", number: 1, title: "1.1 日，内，道观", content: "保留原稿" },
      { id: "real-name", number: 2, title: "第二集：归来", content: "保留原稿" },
      { id: "missing-count", number: 3, title: "3.1 日，外，街道", content: "保留原稿" },
      { id: "empty-name", number: 25, title: "", content: "保留原稿" }
    ];
    const savedBefore = JSON.stringify(episodes);
    const dashboard = load("app/projects/[projectId]/page.tsx", {
      "next/navigation": pageDependencies["next/navigation"], "@/lib/auth": pageDependencies["@/lib/auth"],
      "@/lib/episode-presentation": presentation, "@/lib/production-episodes": {
        ...production, readProductionScope: async () => ({ sourceKnown: true, episodeNumbers: [1, 2, 3, 25] })
      },
      "@/lib/prisma": { prisma: { episode: { findMany: async () => episodes } } },
      "@/lib/studio": { getProjectStudio: async () => ({ project, assets: [], firstPhase: { stages: [] },
        episodes: episodes.filter(episode => episode.number !== 3).map(episode => ({ ...episode, scenes: Array.from({ length: episode.number === 25 ? 4 : episode.number + 1 }, (_, i) => ({ sceneKey: String(i) })) })) }) },
      "@/lib/foundation-delivery": { getFoundationDeliveryState: async () => ({ requiredChoices: [], confirmedChoices: [], issues: [], document: { notes: [], editorialTodos: [] } }) },
      "@/app/ui/app-chrome": chrome, "./foundation-actions": { FoundationUsage: noop },
      "./foundation-delivery-panel": { FoundationDeliveryPanel: noop, FoundationWorkflowStatus: noop },
      "./foundation-document-viewer": { LightFoundationDocumentViewer: noop }, "./scene-structure-table": { SceneStructureTable: noop },
      "./presentation-contracts": { PresentationContracts: noop }, "../../mode-switch": { ModeSwitch: noop },
      "@/lib/presentation-contracts": {}, "@/app/page-surfaces.css": {}, "@/app/workbench-refinement.css": {}
    }).default;
    const html = renderToStaticMarkup(await dashboard({ params: Promise.resolve({ projectId: "fixture" }) }));
    const entries = html.match(/class="stageThreeEpisodeEntries"[^>]*aria-label="进入第三阶段"[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.match(html, /<details class="bibleSection"><summary class="bibleSectionHead">选择其他剧集/,'full episode navigation is available in a collapsed secondary list');
    for (const title of ["第1集 · 2场", "第2集 · 3场 · 归来", "第3集 · 场次待识别", "第25集 · 4场"]) assert(entries.includes(title), title);
    assert(!entries.includes("道观") && !entries.includes("街道"), "Scene headings belong in the scene list, not episode entry titles");
    for (const episode of episodes) assert(entries.includes(`/projects/fixture/episodes/${episode.id}/storyboard`), "Routes retain database identities");
    assert.equal(JSON.stringify(episodes), savedBefore, "Presentation must not rewrite stored title or source text");
  });
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("PASS production navigation and home cards: source-scoped real zero/background counts, legacy fallback, archive/history preservation and desktop/mobile hrefs; no DB/model calls");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
