"use server";
import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";

export const getCurrencies = async () => {
  const session = await getSession();
  if (!session) return { error: "Unauthorized" };
  try {
    const currencies = await prismadb.currency.findMany({
      where: { isEnabled: true },
      select: { code: true, name: true, symbol: true },
      orderBy: { code: "asc" },
    });
    return { data: currencies };
  } catch (error) {
    return { error: "Failed to fetch currencies" };
  }
};
