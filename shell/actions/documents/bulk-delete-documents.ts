"use server";
import { assertActionSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { canManageDocument } from "@/lib/documents/storage-key";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { minioClient, MINIO_BUCKET } from "@/lib/minio";

export async function bulkDeleteDocuments(documentIds: string[]) {
  const session = await assertActionSession();
  if (!session) throw new Error("Unauthorized");

  const documents = await prismadb.documents.findMany({
    where: { id: { in: documentIds } },
    select: { id: true, key: true, createdBy: true },
  });
  if (documents.some((d) => !canManageDocument(session.user, d))) throw new Error("Forbidden");
  const ids = documents.map((d) => d.id);
  // A file still used by a document we are not deleting stays.
  const stillUsed = new Set((await prismadb.documents.findMany({ where: { key: { in: documents.map((d) => d.key).filter((k): k is string => !!k) }, id: { notIn: ids } }, select: { key: true } })).map((d) => d.key));

  // Delete from MinIO
  await Promise.allSettled(
    documents.map((doc) =>
      doc.key && !stillUsed.has(doc.key)
        ? minioClient.send(new DeleteObjectCommand({ Bucket: MINIO_BUCKET, Key: doc.key }))
        : Promise.resolve()
    )
  );

  // Delete from DB (cascade handles chunks, embeddings, junction tables)
  await prismadb.documents.deleteMany({
    where: { id: { in: ids } },
  });

  revalidatePath("/[locale]/(routes)/documents");
}
