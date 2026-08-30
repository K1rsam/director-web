import { getD1 } from "@/db";
import { listProjectLibrary } from "@/lib/repositories/projects";

export function getProjectLibrary(userId: string) {
  return listProjectLibrary(userId, getD1());
}
