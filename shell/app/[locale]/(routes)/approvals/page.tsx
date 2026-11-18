import { prismadb } from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { hasRole, STAFF_ROLES } from "@/lib/security/session-status";
import { ApprovalButtons } from "@/components/shell/Decisions";
import { approvalDigest } from "@/lib/shell/approval-ticket";

// Text from a workflow or an app, shown to the person approving: control, invisible and direction characters (which
// could reorder or hide what they read) are written out as \uXXXX so they are seen, never applied.
const visible = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u115f\u1160\u17b4\u17b5\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]|\udb40[\udc00-\udc7f\udd00-\uddef]|\ud834[\udd73-\udd7a]|\ud804[\udcbd\udccd]|\ud80d[\udc30-\udc3f]|\ud82f[\udca0-\udca3]/g, (c) => { const n = c.codePointAt(0) ?? 0; return n > 0xffff ? `\\u{${n.toString(16)}}` : `\\u${n.toString(16).padStart(4, "0")}`; });

interface Approval { id: string; workflow: string; summary: string; status: string; created: string; decided?: string; decided_by?: string; error?: string; results?: { op: string; status: number | "started" }[]; acts: { platform: string; op: string; summary: string; input?: unknown; check?: unknown; key?: string }[] }

/** Everything the workflows want to send, pay or change, waiting for one click. Nothing here has happened yet. */
export default async function ApprovalsPage() {
  const session = await getSession();
  const canDecide = hasRole(session?.user, STAFF_ROLES);
  const [rows, workflows] = await Promise.all([prismadb.shell_State.findMany({ where: { ns: "approvals" } }), prismadb.shell_Workflows.findMany()]);
  const names = new Map(workflows.map((w) => [w.id, w.name]));
  const all = rows.map((r) => r.value as unknown as Approval).sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")));
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
                <div className="min-w-0 flex-1 break-words font-medium">{visible(a.summary)}</div>
                <span className={`sh-pill ${a.status === "pending" ? "" : "sh-pill-bad"}`}>{a.status}</span>
              </div>
              <div className="text-xs text-muted-foreground">{visible(names.get(a.workflow) ?? a.workflow)} · queued {visible(String(a.created ?? "").slice(0, 16).replace("T", " "))} UTC</div>
              {/* What runs is each act below in full (call, inputs, its check and key), not the summary: the click approves exactly these. */}
              <ol className="list-decimal space-y-1 pl-5 text-sm">{(a.acts ?? []).filter(Boolean).map((x, i) => (
                <li key={i} className="min-w-0 break-words">{visible(x.summary)} <span className="text-xs text-muted-foreground">({visible(x.platform)})</span>
                  <div className="font-mono text-xs text-muted-foreground break-all">{visible(`${x.platform} ${x.op}`)}</div>
                  <pre className="whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{visible(JSON.stringify(x, null, 1))}</pre>
                </li>))}</ol>
              {a.status === "needs-check" && (a.results ?? []).filter((r) => r.status === "started").map((r, i) => (
                <div key={i} className="text-sm">Outcome unknown for act {(a.results ?? []).indexOf(r) + 1}: {visible(r.op)}. Check it in the app before marking done or running again.</div>))}
              {a.error && <div className="text-sm text-[hsl(var(--bad))] break-words">{visible(a.error)}</div>}
              {canDecide && a.status !== "running" && <ApprovalButtons id={a.id} status={a.status} acts={approvalDigest(a)} />}
            </div>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Decided</h2>
          {recent.map((a) => (
            <div key={a.id} className="flex flex-wrap gap-2 border-b py-2 text-sm">
              <span className="min-w-0 flex-1 break-words">{visible(a.summary)}</span>
              <span className="text-muted-foreground">{a.status} by {visible(a.decided_by ?? "someone")} {a.decided?.slice(0, 10)}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
