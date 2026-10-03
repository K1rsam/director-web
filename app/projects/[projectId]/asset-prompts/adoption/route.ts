import {getCurrentUser} from '@/lib/auth';
import {hasSameLocalOrigin,readLocalJsonObject,LocalRequestError} from '@/lib/local-json-request';
import {adoptAssetDesign, AssetDesignAdoptionError, readAssetDesignAdoptions, restoreAssetDesign, revokeAssetDesign} from '@/lib/asset-design-adoption';
export const dynamic = 'force-dynamic';
const headers = {'Cache-Control': 'private, no-store'};
function failure(error: unknown) {
  return Response.json({error: error instanceof Error ? error.message : '采用操作未完成，请稍后重试。'}, {status: error instanceof AssetDesignAdoptionError || error instanceof LocalRequestError ? error.status : 409, headers});
}
export async function GET(_request: Request, {params}: {params: Promise<{projectId: string}>}) {
  const user = await getCurrentUser();
  if (!user) return Response.json({error: '请先登录。'}, {status: 401, headers});
  try {return Response.json(await readAssetDesignAdoptions((await params).projectId, user.id), {headers});} catch (error) {return failure(error);}
}
export async function POST(request: Request, {params}: {params: Promise<{projectId: string}>}) {
  const user = await getCurrentUser();
  if (!user) return Response.json({error: '请先登录。'}, {status: 401, headers});
  if (!hasSameLocalOrigin(request)) return Response.json({error: '请从当前工作台提交。'}, {status: 403, headers});
  try {
    const input = await readLocalJsonObject(request,16000);
    const {projectId} = await params;
    // Actor is always the authenticated session user; body fields cannot impersonate a reviewer.
    if (input.action === 'adopt') return Response.json(await adoptAssetDesign(projectId, user.id, input), {headers});
    if (input.action === 'revoke') return Response.json(await revokeAssetDesign(projectId, user.id, input), {headers});
    if (input.action === 'restore') return Response.json(await restoreAssetDesign(projectId, user.id, input), {headers});
    throw new AssetDesignAdoptionError('不支持的采用操作。', 400);
  } catch (error) {return failure(error);}
}
