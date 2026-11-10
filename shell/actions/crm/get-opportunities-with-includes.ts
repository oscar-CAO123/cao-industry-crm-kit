"use server";

import { cache } from "react";
import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";

export const getOpportunitiesFull = cache(async () => {
  if (!(await getSession())) return [];
  const data = await prismadb.crm_Opportunities.findMany({
    where: { deletedAt: null },
    include: {
      assigned_account: {
        select: {
          name: true,
        },
      },
      assigned_sales_stage: {
        select: {
          name: true,
        },
      },
      assigned_to_user: {
        select: {
          name: true,
        },
      },
    },
    orderBy: {
      created_on: "desc",
    },
  });

  return data;
});
