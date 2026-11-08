import Link from "next/link";
import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";
import { DEPARTMENTS, BUILT_IN } from "@/lib/shell/departments";

/** Home: what needs a person, the main counts, and every department with what is switched on in it. */
export default async function HomePage() {
  const session = await getSession();
  if (!session) return null;
  const [approvals, pages, workflows, leads, opportunities, tasks, invoices, applied] = await Promise.all([
    prismadb.shell_State.findMany({ where: { ns: "approvals" }, select: { value: true } }),
    prismadb.shell_Pages.findMany({ select: { department: true } }),
    prismadb.shell_Workflows.findMany({ where: { enabled: true }, select: { department: true } }),
    prismadb.crm_Leads.count({ where: { deletedAt: null } }),
    prismadb.crm_Opportunities.count({ where: { deletedAt: null } }),
    prismadb.tasks.count({ where: { taskStatus: "ACTIVE" } }),
    prismadb.invoices.count(),
    prismadb.shell_TemplateApplications.findMany({ where: { status: "applied" }, select: { industry: true } }),
  ]);
  const waiting = approvals.filter((a) => ["pending", "failed", "needs-check"].includes((a.value as { status?: string }).status ?? "")).length;
  const count = (rows: { department: string }[], d: string) => rows.filter((r) => r.department === d).length;
  const first = session.user.name?.split(" ")[0];

  return (
    <div className="space-y-6">
      <div>
        <div className="sh-eyebrow">Home</div>
        <h1 className="sh-h1">{first ? `Morning, ${first}` : "Morning"}</h1>
        <p className="text-muted-foreground">{waiting ? `${waiting} ${waiting === 1 ? "thing waits" : "things wait"} for your approval.` : "Nothing waits for your approval."}</p>
      </div>
      <div className="sh-stats">
        <Link href="/approvals" className={`sh-stat hover:bg-accent ${waiting ? "" : "opacity-80"}`}><div className="sh-stat-v">{waiting}</div><div className="sh-stat-l">Waiting for approval</div></Link>
        <div className="sh-stat"><div className="sh-stat-v">{workflows.length}</div><div className="sh-stat-l">Workflows on</div></div>
        <Link href="/crm/leads" className="sh-stat hover:bg-accent"><div className="sh-stat-v">{leads}</div><div className="sh-stat-l">Leads</div></Link>
        <Link href="/crm/opportunities" className="sh-stat hover:bg-accent"><div className="sh-stat-v">{opportunities}</div><div className="sh-stat-l">Opportunities</div></Link>
        <Link href="/crm/tasks" className="sh-stat hover:bg-accent"><div className="sh-stat-v">{tasks}</div><div className="sh-stat-l">Open tasks</div></Link>
        <Link href="/invoices" className="sh-stat hover:bg-accent"><div className="sh-stat-v">{invoices}</div><div className="sh-stat-l">Invoices</div></Link>
      </div>
      {applied.length === 0 && (
        <div className="sh-card flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <div className="font-medium">No industry template yet</div>
            <div className="text-sm text-muted-foreground">A template switches on the pages and workflows your industry uses. You see every change first.</div>
          </div>
          {session.user.role === "admin" && <Link href="/admin/templates" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Choose a template</Link>}
        </div>
      )}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Departments</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {DEPARTMENTS.map((d) => (
            <Link key={d.id} href={`/d/${d.id}`} className="sh-card space-y-1 hover:bg-accent">
              <div className="font-medium">{d.title}</div>
              <div className="text-sm text-muted-foreground">{d.line}</div>
              <div className="text-xs text-muted-foreground">{count(pages, d.id) + BUILT_IN[d.id].length} pages · {count(workflows, d.id)} workflows</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
