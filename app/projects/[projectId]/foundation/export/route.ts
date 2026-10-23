import { getCurrentUser, requireProjectAccess } from "@/lib/auth";
import { buildFoundationExport, foundationExportFilename, foundationExportStream } from "@/lib/foundation-export";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!(await getCurrentUser())) return Response.json({ error: "请先登录。" }, { status: 401 });
  await requireProjectAccess(projectId);
  const exported = await buildFoundationExport(projectId);
  return new Response(foundationExportStream(exported, [process.env.DEEPSEEK_API_KEY]), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${foundationExportFilename(projectId)}"`,
      "Cache-Control": "private, no-store"
    }
  });
}
