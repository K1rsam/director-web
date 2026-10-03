import {getCurrentUser} from '@/lib/auth';
import {userHasProjectAccess} from '@/lib/auth-service';
import {prisma} from '@/lib/prisma';
import {hasSameLocalOrigin, readLocalJsonObject, LocalRequestError} from '@/lib/local-json-request';
import {readImageBrowserStatus, changeImageBrowserState, ImageBrowserServiceError} from '@/lib/image-browser-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = {'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'};
function failure(error: unknown) {
  const status = error instanceof LocalRequestError || error instanceof ImageBrowserServiceError ? error.status : 409;
  return Response.json({error: '网页执行器操作未确认，请刷新状态或检查本地连接设置。'}, {status, headers});
}
export async function GET(_request: Request, {params}: {params: Promise<{projectId: string}>}) {
  try {
    const {projectId} = await params, user = await getCurrentUser();
    if (!user) return Response.json({error: '请先登录。'}, {status: 401, headers});
    if (!await userHasProjectAccess(prisma, user.id, projectId)) return Response.json({error: '项目不可访问。'}, {status: 404, headers});
    return Response.json(await readImageBrowserStatus(projectId, user.id), {headers});
  } catch (error) {return failure(error);}
}
export async function POST(request: Request, {params}: {params: Promise<{projectId: string}>}) {
  try {
    const {projectId} = await params, user = await getCurrentUser();
    if (!user) return Response.json({error: '请先登录。'}, {status: 401, headers});
    if (!await userHasProjectAccess(prisma, user.id, projectId)) return Response.json({error: '项目不可访问。'}, {status: 404, headers});
    if (!hasSameLocalOrigin(request)) return Response.json({error: '请从当前工作台提交。'}, {status: 403, headers});
    const input = await readLocalJsonObject(request, 4096);
    if (Object.keys(input).some(key => key !== 'action') || !['enable', 'pause', 'refresh'].includes(input.action)) return Response.json({error: '不支持的网页执行器操作。'}, {status: 400, headers});
    return Response.json(await changeImageBrowserState(projectId, user.id, input.action), {headers});
  } catch (error) {return failure(error);}
}
