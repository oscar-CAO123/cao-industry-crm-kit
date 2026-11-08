import { prismadb } from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { hasRole, STAFF_ROLES } from "@/lib/security/session-status";
import { ApprovalButtons } from "@/components/shell/Decisions";

interface Approval { id: string; workflow: string; summary: string; status: string; created: string; decided?: string; decided_by?: string; error?: string; acts: { platform: string; op: string; summary: string }[] }

/** Everything the workflows want to send, pay or change, waiting for one click. Nothing here has happened yet. */
export default async function ApprovalsPage() {
  const session = await getSession();
  const canDecide = hasRole(session?.user, STAFF_ROLES);
  const [rows, workflows] = await Promise.all([prismadb.shell_State.findMany({ where: { ns: "approvals" } }), prismadb.shell_Workflows.findMany()]);
  const names = new Map(workflows.map((w) => [w.id, w.name]));
  const all = rows.map((r) => r.value as unknown as Approval).sort((a, b) => b.created.localeCompare(a.created));
  const open = all.filter((a) => ["pending", "failed", "needs-check", "running"].includes(a.status));
  const recent = all.filter((a) => ["done", "rejected"].includes(a.status)).slice(0, 25);

  return (
    <div className="space-y-6">
      <div>
        <div className="sh-eyebrow">Approvals</div>
        <h1 className="sh-h1">Waiting for you</h1>
        <p className="text-muted-foreground">Workflows read and draft on their own. Anything that reaches a customer, moves money or changes a live record waits here for one click.</p>
      </div>
      {open.length === 0 ? <div className="sh-card text-sm text-muted-foreground">Nothing is waiting.</div> : (
        <div className="space-y-3">
          {open.map((a) => (
            <div key={a.id} className="sh-card space-y-2">
              <div className="flex flex-wrap items-start gap-2">
                <div className="flex-1 font-medium">{a.summary}</div>
                <span className={`sh-pill ${a.status === "pending" ? "" : "sh-pill-bad"}`}>{a.status}</span>
              </div>
              <div className="text-xs text-muted-foreground">{names.get(a.workflow) ?? a.workflow} · queued {a.created.slice(0, 16).replace("T", " ")} UTC</div>
              <ol className="list-decimal space-y-0.5 pl-5 text-sm">{a.acts.map((x, i) => <li key={i}>{x.summary} <span className="text-xs text-muted-foreground">({x.platform})</span></li>)}</ol>
              {a.error && <div className="text-sm text-[hsl(var(--bad))]">{a.error}</div>}
              {canDecide && a.status !== "running" && <ApprovalButtons id={a.id} status={a.status} />}
            </div>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Decided</h2>
          {recent.map((a) => (
            <div key={a.id} className="flex flex-wrap gap-2 border-b py-2 text-sm">
              <span className="flex-1">{a.summary}</span>
              <span className="text-muted-foreground">{a.status} by {a.decided_by ?? "someone"} {a.decided?.slice(0, 10)}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
