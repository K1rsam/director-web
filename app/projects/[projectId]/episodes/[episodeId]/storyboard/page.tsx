import Link from "next/link";
import { notFound } from "next/navigation";
import { requireEpisodeAccess } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AppChrome } from "@/app/ui/app-chrome";
import { StoryboardWorkbench } from "./workbench";
import "@/app/page-surfaces.css";
import "@/app/episode-surface.css";
import { episodePresentation } from "@/lib/episode-presentation";
import { isProductionEpisodeNumber, readProductionScope } from "@/lib/production-episodes";

export const dynamic = "force-dynamic";

export default async function StoryboardPage({ params }: { params: Promise<{ projectId: string; episodeId: string }> }) {
  const { projectId, episodeId } = await params;
  await requireEpisodeAccess(projectId, episodeId, `/projects/${projectId}/episodes/${episodeId}/storyboard`);
  const episode = await prisma.episode.findFirst({ where: { id: episodeId, projectId }, include: { project: true } });
  if (!episode) notFound();
  const episodes = await prisma.episode.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { id: true, number: true, title: true } });
  const scope = await readProductionScope(projectId);
  return <AppChrome title={episodePresentation(episode.number, episode.title).fullTitle} eyebrow="第三阶段 / 分镜创作" projectId={projectId} projectLabel={episode.project.title}
    activeSection="storyboard" activeEpisodeId={episodeId} episodes={episodes.filter(item => isProductionEpisodeNumber(item.number, scope)).map(item => ({ ...item, title: item.title || "", productionEligible: true }))}
    utility={<div className="projectTopbarMeta"><span>{episode.project.style}</span><span>{episode.project.aspectRatio}</span></div>}
    primaryAction={<Link href={`/projects/${projectId}`} className="quietButton">返回全剧资料</Link>}>
    <StoryboardWorkbench key={episodeId} episodeId={episodeId} projectId={projectId} episodeTitle={episode.project.title} episodeNumber={episode.number} />
  </AppChrome>;
}
