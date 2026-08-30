import { authenticateRunner } from "@/lib/runner-api";
import { buildRunnerJobInput } from "@/lib/runner-pipeline";
import { parseJobInputBody } from "@/lib/runner-contract";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const identity = await authenticateRunner(request);
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = parseJobInputBody(await readJson(request));
  if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });

  try {
    const input = await buildRunnerJobInput(identity, body.jobId, body.leaseToken);
    return input ? Response.json({ input }) : Response.json({ error: "lease_lost" }, { status: 409 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "任务输入读取失败。" }, { status: 422 });
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
