import { getD1 } from "@/db";
import { getEpisodeStudio as getEpisodeStudioFromD1 } from "@/lib/repositories/episode-studio";
import { getProjectStudio as getProjectStudioFromD1 } from "@/lib/repositories/project-studio";

export function getProjectStudio(projectId: string, userId: string) {
  return getProjectStudioFromD1(projectId, userId, getD1());
}

export function getEpisodeStudio(projectId: string, episodeId: string, userId: string) {
  return getEpisodeStudioFromD1(projectId, episodeId, userId, getD1());
}
