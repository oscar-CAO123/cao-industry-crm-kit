"use server";
import { assertActionSession } from "@/lib/auth-server";
import { canManageDocument } from "@/lib/documents/storage-key";

import { prismadb } from "@/lib/prisma";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { minioClient, MINIO_BUCKET } from "@/lib/minio";

export async function deleteDocument(documentId: string) {
  const session = await assertActionSession();
  if (!session) throw new Error("Unauthenticated");

  if (!documentId) throw new Error("Document ID is required");

  const document = await prismadb.documents.findUnique({
    where: { id: documentId },
  });

  if (!document) throw new Error("Document not found");
  if (!canManageDocument(session.user, document)) throw new Error("Forbidden");

  await prismadb.documents.delete({ where: { id: documentId } });

  // Remove the stored file only when no other document still points at it.
  const shared = document.key ? await prismadb.documents.findFirst({ where: { key: document.key }, select: { id: true } }) : null;
  if (document.key && !shared) {
    await minioClient.send(
      new DeleteObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: document.key,
      })
    );
  }
}
