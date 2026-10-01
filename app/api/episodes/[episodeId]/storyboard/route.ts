import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createStoryboardRun, loadStoryboardInput, storyboardFailure, storyboardHttp, storyboardRunnerStatus, storyboardRunView, storyboardService } from "@/lib/storyboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ episodeId: string }> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
async function episodeFor(context: Context) {
  const user = await getCurrentUser();
  if (!user) throw Object.assign(new Error("请先登录"), { status: 401, code: "UNAUTHORIZED" });
  const { episodeId } = await context.params;
  const episode = await prisma.episode.findFirst({ where: { id: episodeId, project: { roles: { some: { userId: user.id } } } }, include: { project: true } });
  if (!episode) throw Object.assign(new Error("本集不存在"), { status: 404 });
  return episode;
}
export async function GET(request: Request, context: Context) {
  try {
    const episode = await episodeFor(context), url = new URL(request.url), service = storyboardService();
    const id = url.searchParams.get("runId");
    if (!id) {
      const [runs, runner, prepared] = await Promise.all([service.list({ episodeId: episode.id }), storyboardRunnerStatus(), loadStoryboardInput(episode)]);
      const { maxConcurrent, maxPerEpisode } = service.scheduling();
      return json({ runs: runs.map((r: any) => ({ id: r.id, title: r.web.title, status: ["pausing", "paused", "stopped", "unknown", "usage_review", "budget_stop", "source_stale"].includes(r.web.progress) ? r.web.progress : r.status, createdAt: r.web.createdAt })).sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)),
        model: "gpt-6.1-sol", reasoning: "medium", maxConcurrent, maxPerEpisode, runner, sourceWarnings: prepared.warnings });
    }
    const run = await service.read(id);
    storyboardHttp.assertEpisodeBinding(run, episode);
    const format = url.searchParams.get("format");
    if (format) {
      if (!["json", "md"].includes(format)) return json({ error: "仅支持Markdown/JSON导出" }, 400);
      if (format === "md" && (await loadStoryboardInput(episode)).sourceVersion !== run.web.binding.sourceVersion) return json({ error: "原文或前情资料已更新，旧记录可导出JSON，但不能当当前完成稿下载", code: "SOURCE_STALE" }, 409);
      if (format === "md" && (service.active(id) || run.status !== "text_ready_for_review" || run.assembly?.validation?.errors?.length || !run.assembly?.text)) return json({ error: "当前文字稿尚未完成整编，原记录可用JSON导出" }, 409);
      const content = format === "json" ? JSON.stringify(run, null, 2) : run.assembly.text;
      return new Response(content, { headers: { "cache-control": "no-store", "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="storyboard-${run.id}.${format}"`, "x-content-type-options": "nosniff" } });
    }
    return json({ run: await storyboardRunView(run, episode) });
  } catch (e) { const failure = storyboardFailure(e); return json(failure.body, failure.status); }
}
export async function POST(request: Request, context: Context) {
  try {
    const episode = await episodeFor(context), command = await storyboardHttp.readCommand(request), service = storyboardService();
    if (command.action === "create") return json({ run: await storyboardRunView(await createStoryboardRun(episode, command), episode) }, 201);
    const run = await service.read(command.runId);
    storyboardHttp.assertEpisodeBinding(run, episode);
    if (["start", "repair", "replan"].includes(command.action) && !(await storyboardRunnerStatus()).ready) return json({ error: "本机CLI未登录或不可用；未发送生成请求", code: "CLI_NOT_READY" }, 503);
    const id = command.runId;
    let result;
    switch (command.action) {
      case "start": result = await service.start(id, { mode: command.mode }); break;
      case "replan": result = await service.replan(id); break;
      case "pause": result = await service.pause(id); break;
      case "stop": result = await service.stop(id); break;
      case "acknowledge_cancel": result = await service.acknowledgeCancelled(id, { attemptId: command.attemptId, acceptUnknownUsage: command.acceptUnknownUsage }); break;
      case "choice": result = await service.choose(id, command); break;
      case "confirm": result = await service.confirm(id, command); break;
      case "repair": result = await service.repair(id, { packageIds: command.packageIds, notes: [{ problem: command.notes, scope: command.packageIds }] }); break;
      case "recover": result = await service.recover(id, command.attemptId); break;
      case "recheck": result = await service.recheck(id, command.candidateId); break;
      case "budget": result = await service.setBudget(id, { maxCalls: command.maxCalls, maxTokens: command.maxTokens }); break;
      default: return json({ error: "未知操作" }, 400);
    }
    return json({ run: await storyboardRunView(result, episode) }, ["start", "repair", "replan"].includes(command.action) ? 202 : 200);
  } catch (e) { const failure = storyboardFailure(e); return json(failure.body, failure.status); }
}
