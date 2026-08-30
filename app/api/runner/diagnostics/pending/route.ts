import { claimPendingDiagnosticUpload } from "@/lib/runner-diagnostics";
import { authenticateRunner } from "@/lib/runner-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const identity = await authenticateRunner(request);
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const requestId = await claimPendingDiagnosticUpload(identity);
    return requestId ? Response.json({ requestId }) : new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: "诊断上传请求读取失败。" }, { status: 503 });
  }
}

