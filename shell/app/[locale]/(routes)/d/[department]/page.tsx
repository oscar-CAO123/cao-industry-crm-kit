import Link from "next/link";
import { notFound } from "next/navigation";
import { prismadb } from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { departmentOf, isDepartment, BUILT_IN } from "@/lib/shell/departments";
import { workflowInfo } from "@/lib/shell/kit";

/** A department's own page: its pages, the workflows switched on for it, and what waits for a person. */
export default async function DepartmentPage(props: { params: Promise<{ department: string }> }) {
  const { department } = await props.params;
  if (!isDepartment(department)) notFound();
  const d = departmentOf(department)!;
  const session = await getSession();
  const [pages, workflows, approvals] = await Promise.all([
    prismadb.shell_Pages.findMany({ where: { department }, orderBy: { position: "asc" } }),
    prismadb.shell_Workflows.findMany({ where: { department, enabled: true }, orderBy: { name: "asc" } }),
    prismadb.shell_State.findMany({ where: { ns: "approvals" } }),
  ]);
  const ids = new Set(workflows.map((w) => w.id));
  const waiting = approvals.map((a) => a.value as { workflow: string; status: string }).filter((a) => ids.has(a.workflow) && ["pending", "failed", "needs-check"].includes(a.status)).length;

  return (
    <div className="space-y-6">
      <div>
        <div className="sh-eyebrow">Department</div>
        <h1 className="sh-h1">{d.title}</h1>
        <p className="text-muted-foreground">{d.line}</p>
      </div>
      <div className="sh-stats">
        <div className="sh-stat"><div className="sh-stat-v">{pages.length + BUILT_IN[department].length}</div><div className="sh-stat-l">Pages</div></div>
        <div className="sh-stat"><div className="sh-stat-v">{workflows.length}</div><div className="sh-stat-l">Workflows on</div></div>
        <Link href="/approvals" className="sh-stat hover:bg-accent"><div className={`sh-stat-v ${waiting ? "" : "text-muted-foreground"}`}>{waiting}</div><div className="sh-stat-l">Waiting for approval</div></Link>
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Pages</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {pages.map((p) => {
            const spec = p.spec as { tabs: { title: string }[] };
            return (
              <Link key={p.id} href={`/d/${department}/${p.slug}`} className="sh-card hover:bg-accent">
                <div className="font-medium">{p.title}</div>
                <div className="mt-1 text-sm text-muted-foreground">{spec.tabs.map((t) => t.title).join(" · ")}</div>
              </Link>
            );
          })}
          {BUILT_IN[department].map((b) => (
            <Link key={b.url} href={b.url} className="sh-card hover:bg-accent"><div className="font-medium">{b.title}</div><div className="mt-1 text-sm text-muted-foreground">Built in</div></Link>
          ))}
          {pages.length + BUILT_IN[department].length === 0 && (
            <div className="sh-card text-sm text-muted-foreground">
              No pages yet. {session?.user.role === "admin" ? <Link className="underline" href="/admin/templates">Apply an industry template</Link> : "An admin applies an industry template"} to switch on this department&apos;s pages.
            </div>
          )}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Workflows</h2>
        {workflows.length === 0 ? <div className="sh-card text-sm text-muted-foreground">No workflows switched on for {d.title.toLowerCase()}.</div> : (
          <div className="grid gap-3 lg:grid-cols-2">
            {workflows.map((w) => {
              let info: ReturnType<typeof workflowInfo> | null = null;
              try { info = workflowInfo(w.dir); } catch { info = null; }
              return (
                <div key={w.id} className="sh-card space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 font-medium">{w.name}</div>
                    <span className={`sh-pill ${w.status === "live-tested" ? "sh-pill-on" : ""}`}>{w.status}</span>
                  </div>
                  {info ? <>
                    <p className="text-sm text-muted-foreground">{info.summary}</p>
                    <div className="text-xs text-muted-foreground">Runs: {info.crons.map((c) => `${c.name} (${c.schedule} UTC)`).join(", ") || "on demand"}</div>
                    {info.liveOps.length > 0 && <div className="text-xs text-muted-foreground">Waits for approval before: {info.liveOps.length} kinds of send, payment or live change</div>}
                  </> : <p className="text-sm text-[hsl(var(--bad))]">Its files are missing from this deploy.</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
