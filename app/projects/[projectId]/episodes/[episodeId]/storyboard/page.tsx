import Link from "next/link";
import { notFound } from "next/navigation";
import { requireEpisodeAccess } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AppChrome } from "@/app/ui/app-chrome";
import { StoryboardWorkbench } from "./workbench";

export const dynamic = "force-dynamic";
export default async function StoryboardPage({ params }: { params: Promise<{ projectId: string; episodeId: string }> }) {
  const { projectId, episodeId } = await params;
  await requireEpisodeAccess(projectId, episodeId, `/projects/${projectId}/episodes/${episodeId}/storyboard`);
  const episode = await prisma.episode.findFirst({ where: { id: episodeId, projectId }, include: { project: true } });
  if (!episode) notFound();
  return <AppChrome title={`第${episode.number}集 · 情绪分镜`} eyebrow={episode.project.title} projectId={projectId} activeSection="episode" contentMode="page"
    utility={<Link href={`/projects/${projectId}`} className="quietButton">返回全剧资料</Link>}>
    <StoryboardWorkbench episodeId={episodeId} episodeTitle={`第${episode.number}集 · ${episode.title || "分镜制作"}`} />
  </AppChrome>;
}
