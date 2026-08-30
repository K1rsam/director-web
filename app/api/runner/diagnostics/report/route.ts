import { parseDiagnosticReportBody } from "@/lib/diagnostic-log";
import { recordRunnerDiagnostics } from "@/lib/runner-diagnostics";
import { authenticateRunner } from "@/lib/runner-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const identity = await authenticateRunner(request);
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = parseDiagnosticReportBody(await readJson(request));
  if (!body) return Response.json({ error: "invalid_diagnostic" }, { status: 400 });

  try {
    const accepted = await recordRunnerDiagnostics(identity, body);
    return Response.json({ ok: true, accepted });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "诊断日志保存失败。" },
      { status: 422 },
    );
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

