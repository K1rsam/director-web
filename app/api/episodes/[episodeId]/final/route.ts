import { NextResponse } from "next/server";
import { getD1 } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { getFinalScriptExport } from "@/lib/repositories/episode-studio";

export async function GET(_request: Request, context: { params: Promise<{ episodeId: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { episodeId } = await context.params;
  const finalScript = await getFinalScriptExport(getD1(), episodeId, user.id);

  if (!finalScript) {
    return NextResponse.json({ error: "Final script not found." }, { status: 404 });
  }

  const projectTitle = finalScript.projectTitle;
  const episodeTitle = finalScript.episodeTitle ?? `第${finalScript.number ?? ""}集`;
  const fileName = encodeURIComponent(`${projectTitle}_${episodeTitle}_v${finalScript.version}.md`);

  return new Response(finalScript.content, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${fileName}`
    }
  });
}
