import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, context: { params: Promise<{ episodeId: string }> }) {
  const { episodeId } = await context.params;
  const finalScript = await prisma.finalScript.findFirst({
    where: { episodeId },
    include: { episode: { include: { project: true } } },
    orderBy: { version: "desc" }
  });

  if (!finalScript) {
    return NextResponse.json({ error: "Final script not found." }, { status: 404 });
  }

  const projectTitle = finalScript.episode?.project.title ?? "导演项目";
  const episodeTitle = finalScript.episode?.title ?? `第${finalScript.episode?.number ?? ""}集`;
  const fileName = encodeURIComponent(`${projectTitle}_${episodeTitle}_v${finalScript.version}.md`);

  return new Response(finalScript.content, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${fileName}`
    }
  });
}
