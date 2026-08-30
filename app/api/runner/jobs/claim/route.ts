import { parseClaimBody } from "@/lib/runner-contract";
import { authenticateRunner, claimNextJob } from "@/lib/runner-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const identity = await authenticateRunner(request);
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = parseClaimBody(await readJson(request));
  if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });

  const job = await claimNextJob(identity, body.deviceId);
  return job ? Response.json({ job }) : new Response(null, { status: 204 });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
