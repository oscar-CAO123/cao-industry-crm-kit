"use server";
// Records on template pages. Every call: an active staff session (admin or member), the page and tab looked up from
// the database (never trusted from the browser), data cleaned against that tab's fields, an audit log row.
import { revalidatePath } from "next/cache";
import { prismadb } from "@/lib/prisma";
import { assertActionSession } from "@/lib/auth-server";
import { writeAuditLog, diffObjects } from "@/lib/audit-log";
import { getPage, tabOf, cleanData } from "@/lib/shell/pages";

type Result = { ok: true } | { ok: false; error: string };
const fail = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "Something went wrong" });

async function target(department: string, slug: string, tab: string) {
  const page = await getPage(department, slug);
  if (!page) throw new Error("No such page");
  const t = tabOf(page, tab);
  if (t.slug !== tab) throw new Error("No such tab");
  return t;
}

export async function createRecord(department: string, slug: string, tab: string, title: string, input: Record<string, unknown>, stage?: string): Promise<Result> {
  try {
    const session = await assertActionSession();
    const t = await target(department, slug, tab);
    const name = String(title ?? "").trim().slice(0, 200);
    if (!name) throw new Error("Give it a name");
    if (stage && !(t.stages ?? []).includes(stage)) throw new Error("No such stage");
    const data = cleanData(t.fields, input ?? {});
    const row = await prismadb.shell_Records.create({ data: { kind: t.kind, title: name, stage: stage ?? t.stages?.[0] ?? null, data, createdBy: session.user.id, updatedBy: session.user.id } });
    await writeAuditLog({ entityType: "record", entityId: row.id, action: "created", changes: [{ field: "kind", old: null, new: t.kind }], userId: session.user.id });
    revalidatePath(`/[locale]/(routes)/d/${department}/${slug}`, "page");
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function updateRecord(department: string, slug: string, tab: string, id: string, patch: { title?: string; stage?: string; data?: Record<string, unknown> }): Promise<Result> {
  try {
    const session = await assertActionSession();
    const t = await target(department, slug, tab);
    const before = await prismadb.shell_Records.findFirst({ where: { id, kind: t.kind, deletedAt: null } });
    if (!before) throw new Error("No such record");
    if (patch.stage !== undefined && !(t.stages ?? []).includes(patch.stage)) throw new Error("No such stage");
    const next = {
      title: patch.title !== undefined ? String(patch.title).trim().slice(0, 200) || before.title : before.title,
      stage: patch.stage ?? before.stage,
      data: patch.data ? cleanData(t.fields, patch.data) : (before.data as Record<string, unknown>),
    };
    await prismadb.shell_Records.update({ where: { id }, data: { ...next, data: next.data as object, updatedBy: session.user.id } });
    await writeAuditLog({ entityType: "record", entityId: id, action: "updated", changes: diffObjects({ title: before.title, stage: before.stage, ...(before.data as object) }, { title: next.title, stage: next.stage, ...next.data }), userId: session.user.id });
    revalidatePath(`/[locale]/(routes)/d/${department}/${slug}`, "page");
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function deleteRecord(department: string, slug: string, tab: string, id: string): Promise<Result> {
  try {
    const session = await assertActionSession();
    const t = await target(department, slug, tab);
    const n = await prismadb.shell_Records.updateMany({ where: { id, kind: t.kind, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: session.user.id } });
    if (!n.count) throw new Error("No such record");
    await writeAuditLog({ entityType: "record", entityId: id, action: "deleted", changes: null, userId: session.user.id });
    revalidatePath(`/[locale]/(routes)/d/${department}/${slug}`, "page");
    return { ok: true };
  } catch (e) { return fail(e); }
}
