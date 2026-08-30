import { getCurrentUser } from "@/lib/auth";
import { listRunnerDiagnostics } from "@/lib/runner-diagnostics";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "请先登录网站。" }, { status: 401 });
  try {
    return Response.json(await listRunnerDiagnostics(user.id), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "诊断日志读取失败。" }, { status: 503 });
  }
}

