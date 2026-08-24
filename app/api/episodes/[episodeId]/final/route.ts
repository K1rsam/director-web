import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function GET(_request: Request, context: { params: Promise<{ episodeId: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { episodeId } = await context.params;
  const finalScript = await prisma.finalScript.findFirst({
    where: {
      episodeId,
      project: { roles: { some: { userId: user.id } } }
    },
    include: { project: true, episode: true },
    orderBy: { version: "desc" }
  });

  if (!finalScript) {
    return NextResponse.json({ error: "Final script not found." }, { status: 404 });
  }

  const projectTitle = finalScript.project.title;
  const episodeTitle = finalScript.episode?.title ?? `第${finalScript.episode?.number ?? ""}集`;
  const fileName = encodeURIComponent(`${projectTitle}_${episodeTitle}_v${finalScript.version}.md`);

  return new Response(finalScript.content, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${fileName}`
    }
  });
}
