import { getCurrentUser } from "@/lib/auth";
import {hasSameLocalOrigin,readLocalJsonObject,LocalRequestError} from '@/lib/local-json-request';
import { generateSeriesDirectionCandidate, getSeriesDirectionWorkspace, mutateSeriesDirection, seriesDirectionFailure, type SeriesDirectionCommand, type SeriesDirectionGenerateCommand } from "@/lib/series-direction-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ projectId: string }> };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
export async function GET(_request: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return json({ code: "UNAUTHORIZED", error: "请先登录。" }, 401);
  try { return json(await getSeriesDirectionWorkspace((await context.params).projectId, user.id)); }
  catch (error) { const failure = seriesDirectionFailure(error); return json(failure.body, failure.status); }
}
export async function POST(request: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return json({ code: "UNAUTHORIZED", error: "请先登录。" }, 401);
  if (!hasSameLocalOrigin(request)) return json({ code: "DIRECTION_ORIGIN", error: "请从当前工作台提交。" }, 403);
  try {
    const command = await readLocalJsonObject(request,32_768) as SeriesDirectionCommand | SeriesDirectionGenerateCommand;
    const { projectId } = await context.params;
    // actorId and confirmation are exclusively supplied by the authenticated server context.
    return json(command.action === "generate" || command.action === "resume" ? await generateSeriesDirectionCandidate(projectId, user.id, command) : await mutateSeriesDirection(projectId, user.id, command));
  } catch (error) { if(error instanceof LocalRequestError)return json({code:'DIRECTION_REQUEST',error:error.message},error.status);const failure = seriesDirectionFailure(error); return json(failure.body, failure.status); }
}
