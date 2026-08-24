import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildChatGptPrompt } from "@/lib/workflow";

export async function GET(_request: Request, context: { params: Promise<{ taskPackageId: string }> }) {
  const { taskPackageId } = await context.params;
  const taskPackage = await prisma.taskPackage.findUnique({
    where: { id: taskPackageId },
    include: { episode: { include: { project: true } } }
  });

  if (!taskPackage?.payload) {
    return NextResponse.json({ error: "Task package prompt not found." }, { status: 404 });
  }

  const projectTitle = taskPackage.episode?.project.title ?? "导演项目";
  const episodeTitle = taskPackage.episode?.title ?? `第${taskPackage.episode?.number ?? ""}集`;
  const fileName = encodeURIComponent(`${projectTitle}_${episodeTitle}_GPT投喂包.txt`);

  return new Response(buildChatGptPrompt(JSON.parse(taskPackage.payload)), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${fileName}`
    }
  });
}
