import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createStoryboardRun, loadStoryboardInput, prepareStoryboardView, refreshProductionChain, refreshStoryboardRun, storyboardSavedRunView, storyboardChainComplete, storyboardSourceCompatible, storyboardFailure, storyboardHttp, storyboardRunnerStatus, storyboardRunView, storyboardService } from "@/lib/storyboard-service";
import type {ScriptInputProtocol} from '@/lib/standard-script-reception';

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
      if(url.searchParams.get('view')==='saved'){
        const runs=await service.list({episodeId:episode.id}),views=await Promise.all(runs.map((run:any)=>storyboardSavedRunView(run,episode)));
        return json({runs:views.map(({id,title,status,createdAt,active,legacyReadOnly}:any)=>({id,title,status,createdAt,active,legacyReadOnly})).sort((a:any,b:any)=>b.createdAt.localeCompare(a.createdAt)),
          model:'gpt-6.1-sol',reasoning:'medium',maxConcurrent:4,runner:{ready:false,message:'正在核对本机连接与资料'},sourceWarnings:[],preparation:{ready:false,checking:true}});
      }
      const [runs, runner, prepared] = await Promise.all([service.list({ episodeId: episode.id }), storyboardRunnerStatus(), prepareStoryboardView(episode)]);
      const key=(protocol:ScriptInputProtocol,inlinePerformance:boolean)=>`${protocol}:${inlinePerformance}`;
      const preparationByProtocol = new Map<string,typeof prepared>([[key(prepared.protocol,prepared.inlinePerformance),prepared]]);
      const modes=new Map<string,{protocol:ScriptInputProtocol;inlinePerformance:boolean}>();
      for(const run of runs){const protocol:ScriptInputProtocol=run.web?.binding?.inputProtocol??'legacy',inlinePerformance=run.web?.binding?.inlinePerformanceVersion==='inline-performance-v1';modes.set(key(protocol,inlinePerformance),{protocol,inlinePerformance});}
      await Promise.all([...modes].filter(([k])=>!preparationByProtocol.has(k)).map(async([k,{protocol,inlinePerformance}])=>preparationByProtocol.set(k,await prepareStoryboardView(episode,protocol,inlinePerformance))));
      const views = await Promise.all(runs.map((run: any) => storyboardRunView(run, episode, preparationByProtocol.get(key(run.web?.binding?.inputProtocol??'legacy',run.web?.binding?.inlinePerformanceVersion==='inline-performance-v1')), false)));
      return json({ runs: views.map(({ id, title, status, createdAt, active, sourceStale, blocked, legacyReadOnly }: any) => ({ id, title, status, createdAt, active, sourceStale, blocked, legacyReadOnly })).sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)),
        model: "gpt-6.1-sol", reasoning: "medium", maxConcurrent: 4, runner, sourceWarnings: prepared.sourceWarnings, preparation: prepared.preparation });
    }
    let run = await service.read(id);
    storyboardHttp.assertEpisodeBinding(run, episode);
    const format = url.searchParams.get("format");
    if (format) {
      if (!["json", "md"].includes(format)) return json({ error: "仅支持Markdown/JSON导出" }, 400);
      if(format==='md'&&!run.web.legacyReadOnly){await refreshProductionChain(episode.projectId);run=await service.read(id);}
      // Historical Markdown is an archived result, not a claim that it matches today's source.
      if (format === "md" && !run.web.legacyReadOnly) {
        const current = await loadStoryboardInput(episode, '', run.web.binding.inputProtocol ?? 'legacy',undefined,run.web.binding.inlinePerformanceVersion==='inline-performance-v1');
        const stale = !storyboardSourceCompatible(run.web.binding,current);
        if (stale) return json({ error: "原文或关键约束已更新，旧记录仍可导出JSON。", code: "SOURCE_STALE" }, 409);
        if(!storyboardChainComplete(run))return json({error:'本次连续生产链还有承接或材料问题，不能作为正式连续稿导出；完整历史可导出JSON。',code:'PRODUCTION_CHAIN_INCOMPLETE'},409);
      }
      if (format === "md" && (service.active(id) || run.status !== "text_ready_for_review" || run.assembly?.validation?.errors?.length || !run.assembly?.text)) return json({ error: "当前文字稿尚未完成整编，原记录可用JSON导出" }, 409);
      const preliminary=!run.web.legacyReadOnly&&run.production?.boundaryCheck?.status==='PRELIMINARY';
      const content = format === "json" ? JSON.stringify(run, null, 2) : (preliminary?'以上游原文底稿完成；未与上集实际分镜核对。\n\n':'')+run.assembly.text;
      return new Response(content, { headers: { "cache-control": "no-store", "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="storyboard-${run.id}.${format}"`, "x-content-type-options": "nosniff" } });
    }
    if(url.searchParams.get('view')==='saved')return json({run:await storyboardSavedRunView(run,episode)});
    if(run.web.legacyReadOnly)return json({run:await storyboardRunView(run,episode)});
    const checked=await refreshStoryboardRun(run,episode);
    return json({ run: await storyboardRunView(checked.run, episode, checked.prepared) });
  } catch (e) { const failure = storyboardFailure(e); return json(failure.body, failure.status); }
}
export async function POST(request: Request, context: Context) {
  try {
    const episode = await episodeFor(context), command = await storyboardHttp.readCommand(request), service = storyboardService();
    if (command.action === "create") return json({ run: await storyboardRunView(await createStoryboardRun(episode, command), episode) }, 201);
    const run = await service.read(command.runId);
    storyboardHttp.assertEpisodeBinding(run, episode);
    if (run.web.legacyReadOnly) return json({error:'旧版第三阶段记录只读，可导出已有稿；请新建任务使用新版。',code:'LEGACY_READ_ONLY'},409);
    if (["start", "repair", "replan", "recheck"].includes(command.action)) {
      const current = await loadStoryboardInput(episode, '', run.web.binding.inputProtocol ?? 'legacy',undefined,run.web.binding.inlinePerformanceVersion==='inline-performance-v1');
      const stale = !storyboardSourceCompatible(run.web.binding,current);
      if (run.web.sourceStale || stale) return json({ error: "原文或关键约束已更新，请新建任务使用最新资料；旧结果仍已保存。", code: "SOURCE_STALE" }, 409);
    }
    if (["start", "repair", "replan"].includes(command.action)) {
      const runner = await storyboardRunnerStatus();
      if (!runner.ready) return json({ error: runner.message, code: runner.configurationError ? "RUNNER_TIMEOUT_CONFIG" : "CLI_NOT_READY" }, 503);
    }
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
