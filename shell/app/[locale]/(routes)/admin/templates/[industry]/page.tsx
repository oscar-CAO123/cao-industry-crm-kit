import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth-server";
import { listIndustries } from "@/lib/shell/kit";
import { preview } from "@/lib/shell/templates";
import { departmentOf } from "@/lib/shell/departments";
import { TemplateButtons } from "@/components/shell/Decisions";

/** The preview: every page and workflow the template would add, what is already on, and what it cannot do yet. */
export default async function TemplatePreviewPage(props: { params: Promise<{ industry: string }> }) {
  const { industry } = await props.params;
  const session = await getSession();
  if (session?.user.role !== "admin") redirect("/");
  if (!listIndustries().includes(industry)) notFound();
  const p = await preview(industry);
  const adds = p.changes.filter((c) => c.state === "add");
  const group = (type: "page" | "workflow") => p.changes.filter((c) => c.type === type);
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/templates" className="sh-eyebrow hover:underline">Industry templates</Link>
        <h1 className="sh-h1">{p.name}</h1>
        <p className="text-muted-foreground">{adds.length} changes to apply{p.applied ? `; applied ${p.applied.appliedAt.toISOString().slice(0, 10)}` : ""}. Nothing is written until you press apply.</p>
      </div>
      <TemplateButtons industry={industry} name={p.name} appliedId={p.applied?.id ?? null} adds={adds.length} />
      {(["page", "workflow"] as const).map((type) => (
        <section key={type} className="space-y-2">
          <h2 className="text-lg font-medium">{type === "page" ? "Pages" : "Workflows"}</h2>
          <div className="sh-card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <tbody>
                {group(type).map((c) => (
                  <tr key={c.key} className="border-b last:border-0">
                    <td className="px-4 py-2.5 align-top"><span className={`sh-pill ${c.state === "add" ? "sh-pill-on" : ""}`}>{c.state === "add" ? "Adds" : "Already on"}</span></td>
                    <td className="px-4 py-2.5 align-top text-muted-foreground">{departmentOf(c.department)?.title}</td>
                    <td className="px-4 py-2.5 align-top font-medium">{c.title}</td>
                    <td className="px-4 py-2.5 align-top text-muted-foreground">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <section className="grid gap-3 lg:grid-cols-2">
        <div className="sh-card space-y-2">
          <h2 className="font-medium">Connectors this industry uses</h2>
          <ul className="space-y-1 text-sm">{p.connectors.map((c) => <li key={c.platform} className="flex gap-2"><span className="flex-1">{c.tool}</span><span className="sh-pill">{c.status}</span></li>)}</ul>
          {p.missing.length > 0 && <p className="text-sm text-muted-foreground">Not in the kit yet: {p.missing.map((m) => m.tool).join(", ")}.</p>}
        </div>
        <div className="sh-card space-y-2">
          <h2 className="font-medium">Planned, not built yet</h2>
          <p className="text-sm text-muted-foreground">Planned for this industry but not built, so not switched on.</p>
          <ul className="space-y-1 text-sm">{p.planned.map((w) => <li key={w.id}>{w.name} <span className="text-muted-foreground">({departmentOf(w.department)?.title})</span></li>)}</ul>
        </div>
      </section>
    </div>
  );
}
