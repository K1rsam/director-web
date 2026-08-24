import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildChatGptPrompt } from "@/lib/workflow";
import { getCurrentUser } from "@/lib/auth";

export async function GET(_request: Request, context: { params: Promise<{ taskPackageId: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { taskPackageId } = await context.params;
  const taskPackage = await prisma.taskPackage.findFirst({
    where: {
      id: taskPackageId,
      project: { roles: { some: { userId: user.id } } }
    },
    include: { project: true, episode: true }
  });

  if (!taskPackage?.payload) {
    return NextResponse.json({ error: "Task package prompt not found." }, { status: 404 });
  }

  const projectTitle = taskPackage.project.title;
  const episodeTitle = taskPackage.episode?.title ?? `第${taskPackage.episode?.number ?? ""}集`;
  const fileName = encodeURIComponent(`${projectTitle}_${episodeTitle}_GPT投喂包.txt`);

  return new Response(buildChatGptPrompt(JSON.parse(taskPackage.payload)), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${fileName}`
    }
  });
}
