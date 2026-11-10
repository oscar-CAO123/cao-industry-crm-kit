"use server";
import { getSession } from "@/lib/auth-server";

import { prismadb } from "@/lib/prisma";

export async function getAccountById(accountId: string) {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  const account = await prismadb.crm_Accounts.findFirst({
    where: { id: accountId, deletedAt: null },
    select: { id: true, name: true },
  });

  return account ?? null;
}
