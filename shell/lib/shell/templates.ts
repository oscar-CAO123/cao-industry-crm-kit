// Industry templates: preview what one adds, apply it in one transaction, undo exactly what it added.
//
// - A template adds department pages and switches on workflows. It never adds records: a business starts empty.
// - Preview lists every change before anything is written; apply writes exactly that list and stores it on the
//   application row, so undo removes those rows and nothing else.
// - A page or workflow that is already there is left untouched and listed as "already on", never overwritten.
// - Undo removes the pages and switches the workflows off. Records people entered on those pages stay in the
//   database (a template never deletes business data); applying the template again shows them again.
import { prismadb } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit-log";
import { loadTemplate, type Template } from "./kit";

export interface Change { type: "page" | "workflow"; key: string; title: string; department: string; detail: string; state: "add" | "already-on" }
export interface Preview { industry: string; name: string; version: number; changes: Change[]; planned: Template["planned_workflows"]; connectors: Template["connectors"]; missing: Template["missing_connectors"]; applied: { id: string; appliedAt: Date } | null }

export async function preview(industry: string): Promise<Preview> {
  const t = loadTemplate(industry);
  const [pages, workflows, applied] = await Promise.all([
    prismadb.shell_Pages.findMany({ select: { department: true, slug: true } }),
    prismadb.shell_Workflows.findMany({ select: { id: true, enabled: true } }),
    prismadb.shell_TemplateApplications.findFirst({ where: { industry, status: "applied" }, orderBy: { appliedAt: "desc" }, select: { id: true, appliedAt: true } }),
  ]);
  const havePage = new Set(pages.map((p) => `${p.department}/${p.slug}`));
  const haveWf = new Set(workflows.filter((w) => w.enabled).map((w) => w.id));
  const changes: Change[] = [
    ...t.pages.map((p): Change => ({
      type: "page", key: `${p.department}/${p.slug}`, title: p.title, department: p.department,
      detail: p.tabs.map((x) => `${x.title} (${x.view})`).join(", "), state: havePage.has(`${p.department}/${p.slug}`) ? "already-on" : "add",
    })),
    ...t.workflows.map((w): Change => ({
      type: "workflow", key: w.id, title: w.name, department: w.department,
      detail: w.status, state: haveWf.has(w.id) ? "already-on" : "add",
    })),
  ];
  return { industry, name: t.name, version: t.version, changes, planned: t.planned_workflows, connectors: t.connectors, missing: t.missing_connectors, applied };
}

export async function apply(industry: string, userId: string): Promise<{ id: string; added: number }> {
  const t = loadTemplate(industry);
  const result = await prismadb.$transaction(async (tx) => {
    const pages = new Set((await tx.shell_Pages.findMany({ select: { department: true, slug: true } })).map((p) => `${p.department}/${p.slug}`));
    const wfs = new Map((await tx.shell_Workflows.findMany({ select: { id: true, enabled: true } })).map((w) => [w.id, w.enabled]));
    const app = await tx.shell_TemplateApplications.create({ data: { industry, version: t.version, appliedBy: userId, changes: [] } });
    const added: { type: "page" | "workflow"; id: string; enabled?: boolean }[] = [];
    const maxPos = await tx.shell_Pages.aggregate({ _max: { position: true } });
    let pos = (maxPos._max.position ?? 0) + 1;
    for (const p of t.pages) {
      if (pages.has(`${p.department}/${p.slug}`)) continue;
      const row = await tx.shell_Pages.create({ data: { department: p.department, slug: p.slug, title: p.title, position: pos++, spec: p as object, applicationId: app.id } });
      added.push({ type: "page", id: row.id });
    }
    for (const w of t.workflows) {
      const had = wfs.get(w.id);
      if (had === true) continue;
      if (had === false) await tx.shell_Workflows.update({ where: { id: w.id }, data: { enabled: true, applicationId: app.id } });
      else await tx.shell_Workflows.create({ data: { id: w.id, dir: w.dir, department: w.department, name: w.name, status: w.status, enabled: true, applicationId: app.id } });
      added.push({ type: "workflow", id: w.id, enabled: had });
    }
    await tx.shell_TemplateApplications.update({ where: { id: app.id }, data: { changes: added } });
    return { id: app.id, added: added.length };
  });
  await writeAuditLog({ entityType: "template", entityId: result.id, action: "applied", changes: [{ field: "industry", old: null, new: industry }], userId });
  return result;
}

export async function undo(applicationId: string, userId: string): Promise<{ removed: number }> {
  const removed = await prismadb.$transaction(async (tx) => {
    const app = await tx.shell_TemplateApplications.findUnique({ where: { id: applicationId } });
    if (!app || app.status !== "applied") throw new Error("no applied template with that id");
    const changes = (app.changes ?? []) as { type: string; id: string; enabled?: boolean }[];
    let n = 0;
    for (const c of changes) {
      if (c.type === "page") n += (await tx.shell_Pages.deleteMany({ where: { id: c.id, applicationId } })).count;
      if (c.type === "workflow") {
        // a workflow that was on before this template stays on; one this template switched on is switched off
        if (c.enabled === false) n += (await tx.shell_Workflows.updateMany({ where: { id: c.id, applicationId }, data: { enabled: false, applicationId: null } })).count;
        else n += (await tx.shell_Workflows.deleteMany({ where: { id: c.id, applicationId } })).count;
      }
    }
    await tx.shell_TemplateApplications.update({ where: { id: applicationId }, data: { status: "undone", undoneBy: userId, undoneAt: new Date() } });
    return n;
  });
  await writeAuditLog({ entityType: "template", entityId: applicationId, action: "undone", changes: null, userId });
  return { removed };
}
