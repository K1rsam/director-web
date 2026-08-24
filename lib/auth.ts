export type AppRole = "ADMIN" | "REVIEWER" | "OPERATOR";

export type CurrentUser = {
  name: string;
  email: string;
  role: AppRole;
};

export type UserPermissions = {
  canDeleteProject: boolean;
  canOverrideFinal: boolean;
  canReview: boolean;
  canOperate: boolean;
};

const roleSet = new Set<AppRole>(["ADMIN", "REVIEWER", "OPERATOR"]);
type HeaderLike = { get(name: string): string | null };

function normalizeRole(value: string | null | undefined): AppRole {
  const role = value?.trim().toUpperCase();
  return roleSet.has(role as AppRole) ? (role as AppRole) : "OPERATOR";
}

export function getCurrentUser(headersList?: HeaderLike): CurrentUser {
  const role = normalizeRole(headersList?.get("x-user-role") ?? process.env.CURRENT_USER_ROLE);
  const email =
    headersList?.get("x-user-email") ?? process.env.CURRENT_USER_EMAIL ?? "operator@lan.local";
  const name = headersList?.get("x-user-name") ?? process.env.CURRENT_USER_NAME ?? "局域网用户";

  return { name, email, role };
}

export function getPermissions(role: AppRole): UserPermissions {
  return {
    canDeleteProject: role === "ADMIN",
    canOverrideFinal: role === "ADMIN" || role === "REVIEWER",
    canReview: role === "ADMIN" || role === "REVIEWER",
    canOperate: true
  };
}
