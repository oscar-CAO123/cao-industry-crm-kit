"use server";

import { cache } from "react";
import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";

export const getContractsWithIncludes = cache(async () => {
  if (!(await getSession())) return [];
  const data = await prismadb.crm_Contracts.findMany({
    where: { deletedAt: null },
    include: {
      assigned_to_user: {
        select: {
          name: true,
        },
      },
      assigned_account: {
        select: {
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
  return data;
});

export const getContractsByAccountId = async (accountId: string) => {
  if (!(await getSession())) return [];
  const data = await prismadb.crm_Contracts.findMany({
    where: {
      account: accountId,
      deletedAt: null,
    },
    include: {
      assigned_to_user: {
        select: {
          name: true,
        },
      },
      assigned_account: {
        select: {
          name: true,
        },
      },
    },
  });
  return data;
};
