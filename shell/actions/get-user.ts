import { prismadb } from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";

/** The signed-in, active user's own row, or throw. */
export const getUser = async () => {
  const session = await getSession();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const data = await prismadb.users.findUnique({ where: { id: session.user.id } });
  if (!data) throw new Error("User not found");
  return data;
};
