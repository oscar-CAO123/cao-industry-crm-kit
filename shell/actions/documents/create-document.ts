"use server";
import { assertActionSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { MINIO_BUCKET, MINIO_PUBLIC_URL } from "@/lib/minio";
import { isIssuedFileUrl, isIssuedKey } from "@/lib/documents/storage-key";
import { verifyKey } from "@/lib/documents/key-signature";

interface CreateDocumentInput {
  name: string;
  url: string;
  key: string;
  /** The signature the upload route returned with the key, for this user. */
  keySig: string;
  size: number;
  mimeType: string;
  contentHash?: string;
  accountId?: string;
}

export async function createDocument(input: CreateDocumentInput) {
  const session = await assertActionSession();
  if (!session) throw new Error("Unauthorized");

  // The key must carry the signature the upload route gave THIS user, the URL must be that key's own URL, and no other row may
  // already own the file. So only a file you uploaded can become your document, and only that can later be deleted.
  if (!isIssuedKey(input.key) || !verifyKey(input.key, session.user.id, input.keySig) || !isIssuedFileUrl(input.url, input.key, MINIO_PUBLIC_URL, MINIO_BUCKET)) {
    throw new Error("Invalid file reference");
  }
  if (await prismadb.documents.findFirst({ where: { key: input.key }, select: { id: true } })) {
    throw new Error("That file already belongs to a document");
  }

  const document = await prismadb.documents.create({
    data: {
      v: 0,
      document_name: input.name,
      description: "new document",
      document_file_url: input.url,
      key: input.key,
      size: input.size,
      document_file_mimeType: input.mimeType,
      content_hash: input.contentHash ?? null,
      processing_status: "PENDING",
      createdBy: session.user.id,
      assigned_user: session.user.id,
      ...(input.accountId
        ? { accounts: { create: { account_id: input.accountId } } }
        : {}),
    },
  });


  revalidatePath("/[locale]/(routes)/documents");
  return document;
}
