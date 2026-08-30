import { heartbeatJob, authenticateRunner } from "@/lib/runner-api";
import { parseHeartbeatBody } from "@/lib/runner-contract";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const identity = await authenticateRunner(request);
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = parseHeartbeatBody(await readJson(request));
  if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });

  const leaseExpiresAt = await heartbeatJob(identity, body.jobId, body.leaseToken);
  return leaseExpiresAt
    ? Response.json({ ok: true, leaseExpiresAt })
    : Response.json({ error: "lease_lost" }, { status: 409 });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
