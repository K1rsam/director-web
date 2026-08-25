import { authenticateRunner, reportJob } from "@/lib/runner-api";
import { parseReportBody } from "@/lib/runner-contract";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const identity = await authenticateRunner(request);
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = parseReportBody(await readJson(request));
  if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });

  const accepted = await reportJob(identity, body);
  return accepted
    ? Response.json({ ok: true })
    : Response.json({ error: "lease_lost" }, { status: 409 });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
