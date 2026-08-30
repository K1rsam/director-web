import { getCurrentUser } from "@/lib/auth";
import {
  parseDiagnosticUploadRequestBody,
} from "@/lib/diagnostic-log";
import { requestDetailedDiagnostics } from "@/lib/runner-diagnostics";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "请先登录网站。" }, { status: 401 });
  const body = parseDiagnosticUploadRequestBody(await readJson(request));
  if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });
  try {
    const result = await requestDetailedDiagnostics(user.id, body.runnerTokenId);
    return result
      ? Response.json(result)
      : Response.json({ error: "设备不存在或已撤销。" }, { status: 404 });
  } catch {
    return Response.json({ error: "详细诊断请求创建失败。" }, { status: 503 });
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

