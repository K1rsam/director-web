import { getD1 } from "@/db";
import { getProjectStudio as getProjectStudioFromD1 } from "@/lib/repositories/project-studio";

export function getProjectStudio(projectId: string, userId: string) {
  return getProjectStudioFromD1(projectId, userId, getD1());
}
