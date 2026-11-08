"use server";
// Documents by name, for the command menu. Keyword match only: the shell keeps no embeddings.
import { prismadb } from "@/lib/prisma";
import { assertActionSession } from "@/lib/auth-server";

export interface DocumentSearchResult { id: string; name: string; summary: string | null }

export async function searchDocumentsByName(query: string): Promise<DocumentSearchResult[]> {
  await assertActionSession();
  const q = String(query ?? "").trim().slice(0, 100);
  if (q.length < 2) return [];
  const rows = await prismadb.documents.findMany({
    where: { parent_document_id: null, OR: [{ document_name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }] },
    take: 8, select: { id: true, document_name: true, summary: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.document_name, summary: r.summary }));
}
