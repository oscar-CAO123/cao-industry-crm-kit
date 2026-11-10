import { prismadb } from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { hasRole, STAFF_ROLES } from "@/lib/security/session-status";

/** The signed-in, active user's own row, or throw. */
export const getUser = async () => {
  const session = await getSession();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const data = await prismadb.users.findUnique({ where: { id: session.user.id } });
  if (!data) throw new Error("User not found");
  return data;
};

/** Like getUser, but for writes: the read-only viewer role is refused. */
export const getStaffUser = async () => {
  const session = await getSession();
  if (!session?.user?.id || !hasRole(session.user, STAFF_ROLES)) throw new Error("Unauthorized");
  const data = await prismadb.users.findUnique({ where: { id: session.user.id } });
  if (!data) throw new Error("User not found");
  return data;
};

/** Admin means the role column. The old is_admin flag is only set by the seed and is never kept in step with role. */
export const isAdminUser = (user: { role?: string | null }) => user.role === "admin";
