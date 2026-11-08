"use server";
import { getSession } from "@/lib/auth-server";

import { prismadb } from "@/lib/prisma";

export const getIndustries = async () => {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  const data = await prismadb.crm_Industry_Type.findMany({});
  return data;
};
