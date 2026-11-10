import Link from "next/link";
import { redirect } from "next/navigation";
import { prismadb } from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { listIndustries, loadTemplate } from "@/lib/shell/kit";

/** Industry templates: one per industry in the repo. Open one to see exactly what it adds before applying it. */
export default async function TemplatesPage() {
  const session = await getSession();
  if (session?.user.role !== "admin") redirect("/");
  const applied = await prismadb.shell_TemplateApplications.findMany({ where: { status: "applied" }, select: { industry: true } });
  const on = new Set(applied.map((a) => a.industry));
  const templates = listIndustries().map((i) => { const t = loadTemplate(i); return { i, name: t.name, pages: t.pages.length, tabs: t.pages.reduce((a, p) => a + p.tabs.length, 0), workflows: t.workflows.length }; });
  return (
    <div className="space-y-6">
      <div>
        <div className="sh-eyebrow">Admin</div>
        <h1 className="sh-h1">Industry templates</h1>
        <p className="text-muted-foreground">A template switches on the department pages and workflows an industry uses. It adds no records. You see every change before it is applied, and you can undo it.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => (
          <Link key={t.i} href={`/admin/templates/${t.i}`} className="sh-card space-y-1 hover:bg-accent">
            <div className="flex items-center gap-2"><span className="flex-1 font-medium">{t.name}</span>{on.has(t.i) && <span className="sh-pill sh-pill-on">Applied</span>}</div>
            <div className="text-sm text-muted-foreground">{t.pages} pages, {t.tabs} tabs, {t.workflows} workflows</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
