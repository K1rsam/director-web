import { authenticateRunner, reportRunnerStatus } from "@/lib/runner-api";
import { parseRunnerStatusBody } from "@/lib/runner-contract";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const identity = await authenticateRunner(request);
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = parseRunnerStatusBody(await readJson(request));
  if (!body) return Response.json({ error: "invalid_status" }, { status: 400 });

  try {
    await reportRunnerStatus(identity, body);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "本机状态保存失败。" },
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
