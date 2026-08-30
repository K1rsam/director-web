import { NextResponse } from "next/server";
import { getD1 } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { getTaskPackageExport } from "@/lib/repositories/episode-studio";

export async function GET(_request: Request, context: { params: Promise<{ taskPackageId: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { taskPackageId } = await context.params;
  const taskPackage = await getTaskPackageExport(getD1(), taskPackageId, user.id);

  if (!taskPackage?.payload) {
    return NextResponse.json({ error: "Task package prompt not found." }, { status: 404 });
  }

  const projectTitle = taskPackage.projectTitle;
  const episodeTitle = taskPackage.episodeTitle ?? `第${taskPackage.number ?? ""}集`;
  const fileName = encodeURIComponent(`${projectTitle}_${episodeTitle}_GPT投喂包.txt`);

  let payload: unknown;
  try {
    payload = JSON.parse(taskPackage.payload);
  } catch {
    payload = taskPackage.payload;
  }
  const prompt = [
    "你是导演项目的分镜制作员，不是自由编剧。",
    "请严格依据下面的 TASK_SCHEMA_V4 信息包执行，不得改写原剧本因果或新增设定。",
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
  ].join("\n\n");

  return new Response(prompt, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${fileName}`
    }
  });
}
