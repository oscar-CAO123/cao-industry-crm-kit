// A template page as stored (shell_Pages.spec), checked on every read: the spec decides which fields a record may hold.
import { prismadb } from "@/lib/prisma";
import type { PageSpec, TabSpec, Field } from "./departments";

export async function getPage(department: string, slug: string): Promise<(PageSpec & { id: string }) | null> {
  const row = await prismadb.shell_Pages.findUnique({ where: { department_slug: { department, slug } } });
  if (!row) return null;
  const spec = row.spec as unknown as PageSpec;
  return { ...spec, id: row.id, title: row.title, department: row.department as PageSpec["department"], slug: row.slug };
}

export function tabOf(page: PageSpec, tab?: string): TabSpec {
  return page.tabs.find((t) => t.slug === tab) ?? page.tabs[0];
}

/** Keep only the tab's own fields, each checked against its type. Unknown keys are dropped, never stored. */
export function cleanData(fields: Field[], input: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const f of fields) {
    const raw = input[f.key];
    if (raw === undefined || raw === null || raw === "") continue;
    const s = String(raw).trim().slice(0, f.type === "textarea" ? 5000 : 300);
    if (f.type === "number" || f.type === "money") {
      const n = Number(s.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n)) throw new Error(`${f.label} must be a number`);
      out[f.key] = n;
    } else if (f.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${f.label} must be a date`);
      out[f.key] = s;
    } else if (f.type === "email") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new Error(`${f.label} must be an email address`);
      out[f.key] = s.toLowerCase();
    } else if (f.type === "select") {
      if (!f.options?.includes(s)) throw new Error(`${f.label} must be one of its options`);
      out[f.key] = s;
    } else out[f.key] = s;
  }
  return out;
}
