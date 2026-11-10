"use server";
import { assertActionSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export async function bulkLinkToAccount(documentIds: string[], accountId: string) {
  const session = await assertActionSession();
  if (!session) throw new Error("Unauthorized");

  await prismadb.documentsToAccounts.createMany({
    data: documentIds.map((document_id) => ({ document_id, account_id: accountId })),
    skipDuplicates: true,
  });

  revalidatePath("/[locale]/(routes)/documents");
}
